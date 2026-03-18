import {
  CrmDataService,
  CRM_STATUS_OPTIONS
} from './crm-data-service.js'
import {
  inferTimeZoneFromPhone,
  resolveLeadTimeZone
} from './crm-time-zone-resolver.js'
import {
  buildFullName,
  dedupeStrings,
  formatPhone,
  normalizeEmail,
  normalizeNotes,
  normalizePhone,
  normalizeWhitespace,
  parseTags,
  uid
} from '../utils/formatters.js'
import { getSupabase } from '../../../src/lib/supabase-browser.js'

const LEAD_SELECT_COLUMNS = [
  'id',
  'external_contact_id',
  'first_name',
  'last_name',
  'full_name',
  'phone',
  'email',
  'business_name',
  'status',
  'lifecycle',
  'disposition_id',
  'assigned_rep_id',
  'subscription_type',
  'timezone',
  'timezone_overridden',
  'follow_up_action',
  'follow_up_at',
  'source_created_raw',
  'source_last_activity_raw',
  'created_at',
  'updated_at'
].join(', ')
const LEAD_SUGGESTION_SELECT_COLUMNS = [
  'id',
  'first_name',
  'last_name',
  'full_name',
  'phone',
  'email',
  'business_name',
  'status',
  'lifecycle',
  'subscription_type',
  'timezone',
  'updated_at'
].join(', ')
const PROFILE_ACCESS_SELECT = 'role, active'
const SUPABASE_BATCH_SIZE = 1000
const SUPABASE_FILTER_BATCH_SIZE = 250

export class SupabaseCrmDataService extends CrmDataService {
  constructor() {
    super()
  }

  async initializeWorkspace() {
    const [tagDefinitions, dispositionDefinitions, leadCount, memberCount] = await Promise.all([
      this.listTagDefinitions(),
      this.listDispositionDefinitions(),
      this.countLeadsForScope('leads'),
      this.countLeadsForScope('members')
    ])

    return {
      importHistory: [],
      allowedTags: tagDefinitions.filter((definition) => definition.isArchived !== true).map((definition) => definition.label),
      tagDefinitions,
      dispositionDefinitions,
      workspaceSummary: {
        leadCount,
        memberCount
      }
    }
  }

  async initialize() {
    const [leadRows, tagDefinitions, dispositionDefinitions, profileRows] = await Promise.all([
      this.fetchAllLeadRows(),
      this.listTagDefinitions(),
      this.listDispositionDefinitions(),
      this.fetchAllOptionalRows('profiles')
    ])

    const userMap = new Map(profileRows.map(mapProfileUser).map((user) => [user.id, user]))
    const leadIds = leadRows.map((row) => String(row.id ?? '')).filter(Boolean)

    const [leadTagRows, noteRows, noteVersionRows, historyRows] = await Promise.all([
      leadIds.length ? this.fetchAllOptionalRowsByIds('lead_tags', 'lead_id', leadIds) : Promise.resolve([]),
      leadIds.length ? this.fetchAllOptionalRowsByIds('notes', 'lead_id', leadIds, (query) => query.order('created_at', { ascending: false })) : Promise.resolve([]),
      this.fetchAllOptionalRows('note_versions', (query) => query.order('edited_at', { ascending: false })),
      leadIds.length ? this.fetchAllLeadHistoryRowsByLeadIds(leadIds) : Promise.resolve([])
    ])

    const tagsByLeadId = buildLeadTagsMap(leadTagRows, tagDefinitions)
    const noteVersionsByNoteId = buildNoteVersionsMap(noteVersionRows, userMap)
    const notesByLeadId = buildLeadNotesMap(noteRows, noteVersionsByNoteId, userMap)
    const historyByLeadId = buildLeadHistoryMap(historyRows, userMap)
    const clients = leadRows
      .map((row) => mapLeadRow(row, {
        usersById: userMap,
        tagsByLeadId,
        notesByLeadId,
        historyByLeadId,
        dispositionDefinitions
      }))
      .sort((left, right) => Date.parse(right.updatedAt ?? 0) - Date.parse(left.updatedAt ?? 0))

    return {
      clients,
      importHistory: [],
      allowedTags: tagDefinitions.filter((definition) => definition.isArchived !== true).map((definition) => definition.label),
      tagDefinitions,
      dispositionDefinitions
    }
  }

  async listClientsPage({
    scope = 'leads',
    assignmentState = 'all',
    page = 1,
    pageSize = 50,
    search = '',
    sort = { field: 'updatedAt', direction: 'desc' },
    filters = {},
    tagDefinitions = []
  } = {}) {
    const normalizedPage = Math.max(1, Number(page) || 1)
    const normalizedPageSize = Math.max(1, Number(pageSize) || 50)
    const rangeFrom = (normalizedPage - 1) * normalizedPageSize
    const rangeTo = rangeFrom + normalizedPageSize - 1
    const activeTagId = resolveTagId(filters?.tag, tagDefinitions)
    const normalizedStatusFilter = normalizeStatusFilter(filters?.status)
    const selectClause = activeTagId ? `${LEAD_SELECT_COLUMNS}, lead_tags!inner(tag_id)` : LEAD_SELECT_COLUMNS
    const booleanExpression = buildLeadListBooleanExpression({
      scope,
      searchExpression: buildLeadBooleanExpression({ search, filters })
    })
    const supabase = await getSupabase()
    let query = supabase
      .from('leads')
      .select(selectClause, { count: 'exact' })

    if (scope === 'members') {
      query = query.eq('lifecycle', 'member')
    } else if (assignmentState === 'assigned') {
      query = query.not('assigned_rep_id', 'is', null)
    } else if (assignmentState === 'unassigned') {
      query = query.is('assigned_rep_id', null)
    }

    if (activeTagId) {
      query = query.eq('lead_tags.tag_id', activeTagId)
    }

    if (normalizedStatusFilter !== 'all') {
      query = query.eq('status', normalizedStatusFilter)
    }

    if (booleanExpression) {
      query = query.or(booleanExpression)
    }

    query = applyLeadListSort(query, sort)
    const { data: leadRows, error, count } = await query.range(rangeFrom, rangeTo)

    if (error) {
      throw new Error(error.message || 'Unable to load the requested CRM lead page from Supabase.')
    }

    const pageLeadRows = (leadRows ?? []).map(stripJoinedLeadRow)
    const leadIds = pageLeadRows.map((row) => String(row.id ?? '')).filter(Boolean)
    const [profileRows, effectiveTagDefinitions, latestNoteRows, pageLeadTagRows] = await Promise.all([
      this.fetchOptionalRows('profiles'),
      tagDefinitions?.length ? Promise.resolve(tagDefinitions) : this.listTagDefinitions(),
      leadIds.length ? this.fetchLatestNoteRowsByLeadIds(leadIds) : Promise.resolve([]),
      leadIds.length ? this.fetchAllOptionalRowsByIds('lead_tags', 'lead_id', leadIds) : Promise.resolve([])
    ])
    const userMap = new Map(profileRows.map(mapProfileUser).map((user) => [user.id, user]))
    const normalizedTagDefinitions = Array.isArray(effectiveTagDefinitions) ? effectiveTagDefinitions : mapCatalogRows(effectiveTagDefinitions)
    const tagsByLeadId = buildLeadTagsMap(pageLeadTagRows, normalizedTagDefinitions)
    const latestNotesByLeadId = buildLatestLeadNotesMap(latestNoteRows, userMap)
    const clients = pageLeadRows.map((row) => mapLeadRow(row, {
      usersById: userMap,
      tagsByLeadId,
      notesByLeadId: latestNotesByLeadId,
      historyByLeadId: new Map(),
      dispositionDefinitions: []
    }))

    return {
      clients,
      totalCount: typeof count === 'number' ? count : clients.length,
      page: normalizedPage,
      pageSize: normalizedPageSize
    }
  }

  async searchClientSuggestions({ query = '', limit = 10 } = {}) {
    const searchExpression = buildLeadBooleanExpression({ search: query, filters: {} })
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 10, 10))

    if (!searchExpression) {
      return []
    }

    const supabase = await getSupabase()
    const fetchLimit = Math.max(normalizedLimit * 4, 30)
    let suggestionQuery = supabase
      .from('leads')
      .select(LEAD_SUGGESTION_SELECT_COLUMNS)
      .or(searchExpression)

    suggestionQuery = applyLeadListSort(suggestionQuery, { field: 'updatedAt', direction: 'desc' }).limit(fetchLimit)

    const { data, error } = await suggestionQuery

    if (error) {
      throw new Error(error.message || 'Unable to load CRM search suggestions from Supabase.')
    }

    return [...(data ?? [])]
      .map(mapLeadSuggestionRow)
      .filter((suggestion) => Boolean(suggestion.id))
      .map((suggestion) => ({
        ...suggestion,
        rank: getLeadSuggestionRank(suggestion, query)
      }))
      .sort((left, right) => {
        if (left.rank !== right.rank) {
          return left.rank - right.rank
        }

        const updatedDiff = (Date.parse(right.updatedAt ?? 0) || 0) - (Date.parse(left.updatedAt ?? 0) || 0)
        if (updatedDiff !== 0) {
          return updatedDiff
        }

        return left.fullName.localeCompare(right.fullName)
      })
      .slice(0, normalizedLimit)
      .map(({ rank: _rank, ...suggestion }) => suggestion)
  }

  async saveClient(payload) {
    const existing = payload.id ? await this.getClientById(payload.id) : null
    const client = this.normalizeManualClient(payload, existing, payload.actor ?? null)
    const dispositionDefinitions = await this.listDispositionDefinitions()
    const supabase = await getSupabase()
    let leadId = String(existing?.id ?? '').trim()

    if (existing) {
      const updatePayload = buildLeadUpdatePayload(client, { dispositionDefinitions, existingLead: existing })
      const { error } = await supabase
        .from('leads')
        .update(updatePayload)
        .eq('id', existing.id)

      if (error) {
        throw new Error(error.message || 'Unable to save the lead to Supabase.')
      }
    } else {
      const insertPayload = buildLeadInsertPayload(client, { dispositionDefinitions, existingLead: existing })
      const { data, error } = await supabase
        .from('leads')
        .insert(insertPayload)
        .select('id')
        .single()

      if (error) {
        throw new Error(error.message || 'Unable to save the lead to Supabase.')
      }

      leadId = String(data?.id ?? '').trim()

      if (!leadId) {
        throw new Error('Supabase did not return the new lead id.')
      }
    }

    await this.syncLeadTags(leadId, client.tags)
    await this.insertLeadHistoryRows(buildLeadStateHistoryRows({
      leadId,
      client,
      existingLead: existing,
      actor: payload.actor ?? null,
      changedAt: client.updatedAt
    }))

    if (!existing && Array.isArray(client.noteHistory) && client.noteHistory[0]?.content) {
      await this.insertNoteEntry({
        ...client.noteHistory[0],
        leadId
      }, payload.actor ?? null)
    }

    return this.getClientById(leadId)
  }

  async appendClientNote({ clientId, content, actor }) {
    const normalizedContent = normalizeNotes(content)

    if (!normalizedContent) {
      throw new Error('Enter a note before saving.')
    }

    await this.insertNoteEntry({
      id: uid('note'),
      leadId: clientId,
      content: normalizedContent,
      createdAt: new Date().toISOString(),
      createdByUserId: actor?.id || '',
      createdByName: actor?.name || 'CRM user',
      versions: []
    }, actor)

    return this.getClientById(clientId)
  }

  async updateClientNote({ clientId, noteId, content, actor }) {
    const normalizedContent = normalizeNotes(content)

    if (!normalizedContent) {
      throw new Error('Enter a note before saving.')
    }

    const supabase = await getSupabase()
    let noteQuery = supabase
      .from('notes')
      .select('*')
      .eq('id', noteId)
      .eq('lead_id', clientId)

    if (actor?.role !== 'admin') {
      noteQuery = noteQuery.eq('created_by', actor?.id || '')
    }

    const { data: existingNote, error: noteError } = await noteQuery.maybeSingle()

    if (noteError) {
      throw new Error(noteError.message || 'Unable to load the note for editing.')
    }

    if (!existingNote) {
      throw new Error('That note is no longer available.')
    }

    const existingContent = normalizeNotes(pickValue(existingNote, ['content', 'note']))

    if (existingContent === normalizedContent) {
      throw new Error('No note changes were detected.')
    }

    const now = new Date().toISOString()
    await this.insertNoteVersion(existingNote, actor, now)

    const { error } = await supabase
      .from('notes')
      .update({
        content: normalizedContent,
        updated_at: now
      })
      .eq('id', noteId)

    if (error) {
      throw new Error(error.message || 'Unable to update the note in Supabase.')
    }

    await this.touchLead(clientId, actor, now)
    return this.getClientById(clientId)
  }

  async listTagDefinitions() {
    return this.fetchCatalogRows('tags')
  }

  async saveTagDefinition(payload) {
    await this.assertActiveAdminCatalogAccess()

    const normalizedLabel = normalizeWhitespace(payload.label)

    if (!normalizedLabel) {
      throw new Error('Tags need a label.')
    }

    await this.saveCatalogDefinition('tags', payload, 'tag')
    return this.listTagDefinitions()
  }

  async deleteTagDefinition(tagId, { replacementLabels = [] } = {}) {
    await this.assertActiveAdminCatalogAccess()

    const normalizedTagId = normalizeWhitespace(tagId)

    if (!normalizedTagId) {
      throw new Error('Choose a tag before deleting it.')
    }

    const supabase = await getSupabase()
    const replacementIds = await this.resolveReplacementTagIds(replacementLabels, normalizedTagId)
    const { data: leadTagRows, error: leadTagError } = await supabase
      .from('lead_tags')
      .select('lead_id, tag_id')
      .eq('tag_id', normalizedTagId)

    if (leadTagError) {
      throw new Error(leadTagError.message || 'Unable to load leads using that tag.')
    }

    const affectedLeadIds = dedupeStrings((leadTagRows ?? []).map((row) => row.lead_id))

    if (replacementIds.length && affectedLeadIds.length) {
      const { data: existingLeadTagRows, error: existingLeadTagsError } = await supabase
        .from('lead_tags')
        .select('lead_id, tag_id')
        .in('lead_id', affectedLeadIds)

      if (existingLeadTagsError) {
        throw new Error(existingLeadTagsError.message || 'Unable to prepare replacement tags.')
      }

      const existingPairs = new Set((existingLeadTagRows ?? []).map((row) => `${row.lead_id}:${row.tag_id}`))
      const replacementRows = affectedLeadIds.flatMap((leadId) =>
        replacementIds
          .filter((replacementId) => !existingPairs.has(`${leadId}:${replacementId}`))
          .map((replacementId) => ({
            lead_id: leadId,
            tag_id: replacementId
          }))
      )

      if (replacementRows.length) {
        const { error: insertReplacementError } = await supabase
          .from('lead_tags')
          .insert(replacementRows)

        if (insertReplacementError && !isDuplicateRowError(insertReplacementError)) {
          throw new Error(insertReplacementError.message || 'Unable to save replacement tags.')
        }
      }
    }

    const { error: detachError } = await supabase
      .from('lead_tags')
      .delete()
      .eq('tag_id', normalizedTagId)

    if (detachError) {
      throw new Error(detachError.message || 'Unable to remove the deleted tag from existing leads.')
    }

    const { error } = await supabase
      .from('tags')
      .delete()
      .eq('id', normalizedTagId)

    if (error) {
      throw new Error(error.message || 'Unable to delete the tag from Supabase.')
    }

    return {
      tagDefinitions: await this.listTagDefinitions(),
      updatedClients: []
    }
  }

  async listDispositionDefinitions() {
    return this.fetchCatalogRows('dispositions')
  }

  async saveDispositionDefinition(payload) {
    await this.assertActiveAdminCatalogAccess()

    const normalizedLabel = normalizeWhitespace(payload.label)

    if (!normalizedLabel) {
      throw new Error('Dispositions need a label.')
    }

    await this.saveCatalogDefinition('dispositions', payload, 'disposition')
    return this.listDispositionDefinitions()
  }

  async deleteDispositionDefinition(dispositionId) {
    await this.assertActiveAdminCatalogAccess()

    const normalizedDispositionId = normalizeWhitespace(dispositionId)

    if (!normalizedDispositionId) {
      throw new Error('Choose a disposition before deleting it.')
    }

    const supabase = await getSupabase()
    const now = new Date().toISOString()
    const { error: clearLeadError } = await supabase
      .from('leads')
      .update({
        disposition_id: null,
        updated_at: now
      })
      .eq('disposition_id', normalizedDispositionId)

    if (clearLeadError) {
      throw new Error(clearLeadError.message || 'Unable to clear the deleted disposition from existing leads.')
    }

    const { error } = await supabase
      .from('dispositions')
      .delete()
      .eq('id', normalizedDispositionId)

    if (error) {
      throw new Error(error.message || 'Unable to delete the disposition from Supabase.')
    }

    return this.listDispositionDefinitions()
  }

  async bulkAssignClients({ clientIds, assignedRepId, actor }) {
    if (!clientIds?.length) {
      return []
    }

    const supabase = await getSupabase()
    const now = new Date().toISOString()
    const updatePayload = {
      assigned_rep_id: assignedRepId || null,
      updated_at: now
    }
    const { data, error } = await supabase
      .from('leads')
      .update(updatePayload)
      .in('id', clientIds)
      .select('id, assigned_rep_id')

    if (error) {
      throw new Error(error.message || 'Unable to bulk assign leads in Supabase.')
    }

    return (data ?? []).map((row) => ({
      id: String(row.id ?? '').trim(),
      assignedRepId: normalizeWhitespace(row.assigned_rep_id)
    }))
  }

  async deleteClient(id) {
    const supabase = await getSupabase()
    const { error } = await supabase
      .from('leads')
      .delete()
      .eq('id', id)

    if (error) {
      throw new Error(error.message || 'Unable to delete the lead from Supabase.')
    }
  }

  async reassignClientsFromUser(fromUserId, toUserId) {
    if (!fromUserId || !toUserId || fromUserId === toUserId) {
      return []
    }

    const supabase = await getSupabase()
    const { error } = await supabase
      .from('leads')
      .update({ assigned_rep_id: toUserId, updated_at: new Date().toISOString() })
      .eq('assigned_rep_id', fromUserId)

    if (error) {
      throw new Error(error.message || 'Unable to reassign leads in Supabase.')
    }

    const refreshedClients = await this.initialize()
    return refreshedClients.clients.filter((client) => client.assignedRepId === toUserId)
  }

  async clearAllData() {
    throw new Error('Clearing all CRM data is not wired for Supabase in this pass.')
  }

  async restoreSampleData() {
    throw new Error('Restoring sample data is not available once Supabase is enabled.')
  }

  async backfillLeadTimeZones() {
    await this.assertActiveAdminSettingsAccess()

    const leadRows = await this.fetchAllLeadRows(
      (query) => query.order('updated_at', { ascending: false }),
      'id, phone, timezone, timezone_overridden, updated_at',
      'Unable to load leads for time zone backfill.'
    )
    const stats = {
      scannedCount: leadRows.length,
      updatedCount: 0,
      unchangedCount: 0,
      skippedOverriddenCount: 0,
      unknownCount: 0
    }
    const now = new Date().toISOString()
    const supabase = await getSupabase()
    const updateRows = []

    for (const row of leadRows) {
      const rowId = String(row.id ?? '').trim()

      if (!rowId) {
        continue
      }

      if (row.timezone_overridden === true) {
        stats.skippedOverriddenCount += 1
        continue
      }

      const nextTimeZone = inferTimeZoneFromPhone(row.phone)

      if (nextTimeZone === 'Unknown') {
        stats.unknownCount += 1
      }

      if (normalizeWhitespace(row.timezone) === nextTimeZone && row.timezone_overridden === false) {
        stats.unchangedCount += 1
        continue
      }

      updateRows.push({
        id: rowId,
        timezone: nextTimeZone,
        timezone_overridden: false,
        updated_at: now
      })
    }

    for (let index = 0; index < updateRows.length; index += 25) {
      const batch = updateRows.slice(index, index + 25)
      const results = await Promise.all(batch.map((row) =>
        supabase
          .from('leads')
          .update({
            timezone: row.timezone,
            timezone_overridden: row.timezone_overridden,
            updated_at: row.updated_at
          })
          .eq('id', row.id)
      ))

      results.forEach(({ error }) => {
        if (error) {
          throw new Error(error.message || 'Unable to update lead time zones in Supabase.')
        }
      })
    }

    stats.updatedCount = updateRows.length
    return stats
  }

  async buildImportPreview() {
    throw new Error('CSV import preview is still on the local prototype path in this pass.')
  }

  async importClients() {
    throw new Error('CSV import is still on the local prototype path in this pass.')
  }

  async getClientById(clientId) {
    const [leadRows, profileRows, tagDefinitions, dispositionDefinitions] = await Promise.all([
      this.fetchLeadRows((query) => query.eq('id', clientId)),
      this.fetchOptionalRows('profiles'),
      this.listTagDefinitions(),
      this.listDispositionDefinitions()
    ])
    const leadRow = leadRows[0]

    if (!leadRow) {
      return null
    }

    const userMap = new Map(profileRows.map(mapProfileUser).map((user) => [user.id, user]))
    const [leadTagRows, noteRows, historyRows] = await Promise.all([
      this.fetchOptionalRows('lead_tags', (query) => query.eq('lead_id', clientId)),
      this.fetchOptionalRows('notes', (query) => query.eq('lead_id', clientId).order('created_at', { ascending: false })),
      this.fetchLeadHistoryRows((query) => query.eq('lead_id', clientId))
    ])
    const noteIds = noteRows.map((row) => String(row.id ?? '')).filter(Boolean)
    const noteVersionRows = noteIds.length
      ? await this.fetchOptionalRows('note_versions', (query) => query.in('note_id', noteIds).order('edited_at', { ascending: false }))
      : []

    return mapLeadRow(leadRow, {
      usersById: userMap,
      tagsByLeadId: buildLeadTagsMap(leadTagRows, tagDefinitions),
      notesByLeadId: buildLeadNotesMap(noteRows, buildNoteVersionsMap(noteVersionRows, userMap), userMap),
      historyByLeadId: buildLeadHistoryMap(historyRows, userMap),
      dispositionDefinitions
    })
  }

  async findDuplicateClientCandidate(payload) {
    const normalizedEmail = normalizeEmail(payload?.email)
    const normalizedPhoneKey = normalizePhone(payload?.phone)
    const phoneVariants = dedupeStrings([
      normalizeWhitespace(payload?.phone),
      formatPhone(normalizedPhoneKey),
      normalizedPhoneKey
    ]).filter(Boolean)
    const [emailMatches, phoneMatches] = await Promise.all([
      normalizedEmail
        ? this.fetchLeadRows((query) => query.eq('email', normalizedEmail).limit(5))
        : Promise.resolve([]),
      phoneVariants.length
        ? this.fetchLeadRows((query) => query.in('phone', phoneVariants).limit(5))
        : Promise.resolve([])
    ])
    const duplicateId = dedupeStrings([...emailMatches, ...phoneMatches]
      .map((row) => String(row.id ?? '').trim())
      .filter((id) => id && id !== normalizeWhitespace(payload?.id)))[0]

    if (!duplicateId) {
      return null
    }

    return this.getClientById(duplicateId)
  }

  async fetchRows(table, configureQuery = (query) => query) {
    const supabase = await getSupabase()
    const { data, error } = await configureQuery(supabase.from(table).select('*'))

    if (error) {
      throw new Error(error.message || `Unable to load ${table} from Supabase.`)
    }

    return data ?? []
  }

  async fetchCatalogRows(table) {
    const rows = await this.fetchRows(table)
    return mapCatalogRows(rows)
  }

  async fetchLeadRows(configureQuery = (query) => query) {
    const supabase = await getSupabase()
    const { data, error } = await configureQuery(supabase.from('leads').select(LEAD_SELECT_COLUMNS))

    if (error) {
      throw new Error(error.message || 'Unable to load leads from Supabase.')
    }

    return data ?? []
  }

  async fetchAllRows(table, configureQuery = (query) => query, selectClause = '*', errorMessage = '') {
    const supabase = await getSupabase()
    const rows = []
    let rangeFrom = 0
    let totalCount = null

    while (true) {
      const rangeTo = rangeFrom + SUPABASE_BATCH_SIZE - 1
      const { data, error, count } = await configureQuery(
        supabase.from(table).select(selectClause, { count: 'exact' })
      ).range(rangeFrom, rangeTo)

      if (error) {
        if (isRangeNotSatisfiableError(error)) {
          break
        }

        throw new Error(error.message || errorMessage || `Unable to load ${table} from Supabase.`)
      }

      const batch = data ?? []
      totalCount = typeof count === 'number' ? count : totalCount
      rows.push(...batch)

      if (!batch.length) {
        break
      }

      if (typeof totalCount === 'number') {
        if (rows.length >= totalCount) {
          break
        }
      } else if (batch.length < SUPABASE_BATCH_SIZE) {
        break
      }

      rangeFrom += SUPABASE_BATCH_SIZE
    }

    return rows
  }

  async fetchAllLeadRows(configureQuery = (query) => query, selectClause = LEAD_SELECT_COLUMNS, errorMessage = 'Unable to load leads from Supabase.') {
    return this.fetchAllRows('leads', configureQuery, selectClause, errorMessage)
  }

  async fetchOptionalRows(table, configureQuery = (query) => query) {
    try {
      return await this.fetchRows(table, configureQuery)
    } catch (_error) {
      return []
    }
  }

  async fetchAllOptionalRows(table, configureQuery = (query) => query, selectClause = '*', errorMessage = '') {
    try {
      return await this.fetchAllRows(table, configureQuery, selectClause, errorMessage)
    } catch (_error) {
      return []
    }
  }

  async fetchAllRowsByIds(table, idColumn, ids, configureQuery = (query) => query, selectClause = '*', errorMessage = '') {
    const normalizedIds = dedupeStrings(ids)
    const rows = []

    for (let index = 0; index < normalizedIds.length; index += SUPABASE_FILTER_BATCH_SIZE) {
      const idBatch = normalizedIds.slice(index, index + SUPABASE_FILTER_BATCH_SIZE)
      const batchRows = await this.fetchAllRows(
        table,
        (query) => configureQuery(query.in(idColumn, idBatch)),
        selectClause,
        errorMessage
      )
      rows.push(...batchRows)
    }

    return rows
  }

  async fetchAllOptionalRowsByIds(table, idColumn, ids, configureQuery = (query) => query, selectClause = '*', errorMessage = '') {
    try {
      return await this.fetchAllRowsByIds(table, idColumn, ids, configureQuery, selectClause, errorMessage)
    } catch (_error) {
      return []
    }
  }

  async fetchLeadHistoryRows(configureQuery = (query) => query) {
    return this.fetchOptionalRows('lead_history', (query) =>
      configureQuery(query).order('changed_at', { ascending: false, nullsFirst: false })
    )
  }

  async fetchAllLeadHistoryRowsByLeadIds(leadIds) {
    return this.fetchAllOptionalRowsByIds('lead_history', 'lead_id', leadIds, (query) =>
      query.order('changed_at', { ascending: false, nullsFirst: false })
    )
  }

  async fetchLatestNoteRowsByLeadIds(leadIds) {
    const noteRows = await this.fetchAllOptionalRowsByIds(
      'notes',
      'lead_id',
      leadIds,
      (query) => query.order('created_at', { ascending: false }),
      'id, lead_id, content, created_at, created_by, updated_at'
    )
    const latestRowsByLeadId = new Map()

    noteRows.forEach((row) => {
      const leadId = String(row.lead_id ?? row.leadId ?? '').trim()

      if (!leadId || latestRowsByLeadId.has(leadId)) {
        return
      }

      latestRowsByLeadId.set(leadId, row)
    })

    return [...latestRowsByLeadId.values()]
  }

  async countLeadsForScope(scope = 'leads') {
    const supabase = await getSupabase()
    let query = supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })

    if (scope === 'members') {
      query = query.eq('lifecycle', 'member')
    } else {
      // Migration safety: keep null lifecycle rows in Leads until all records are backfilled.
      query = query.or('lifecycle.is.null,lifecycle.eq.lead')
    }

    const { error, count } = await query

    if (error) {
      throw new Error(error.message || `Unable to load the ${scope} lead count from Supabase.`)
    }

    return typeof count === 'number' ? count : 0
  }

  async syncLeadTags(leadId, tagLabels) {
    const supabase = await getSupabase()
    const tagIds = await this.resolveLeadTagIds(tagLabels)
    const existingRows = await this.fetchOptionalRows('lead_tags', (query) => query.eq('lead_id', leadId))
    const existingTagIds = dedupeStrings(existingRows.map((row) => row.tag_id ?? row.tagId))
    const tagsToRemove = existingTagIds.filter((tagId) => !tagIds.includes(tagId))
    const tagsToAdd = tagIds.filter((tagId) => !existingTagIds.includes(tagId))

    for (const tagId of tagsToRemove) {
      const { error } = await supabase
        .from('lead_tags')
        .delete()
        .eq('lead_id', leadId)
        .eq('tag_id', tagId)

      if (error) {
        throw new Error(error.message || 'Unable to detach the lead tag in Supabase.')
      }
    }

    if (!tagsToAdd.length) {
      return
    }

    const { error: insertError } = await supabase
      .from('lead_tags')
      .insert(tagsToAdd.map((tagId) => ({
        lead_id: leadId,
        tag_id: tagId
      })))

    if (insertError && !isDuplicateRowError(insertError)) {
      throw new Error(insertError.message || 'Unable to attach lead tags in Supabase.')
    }
  }

  async resolveLeadTagIds(tagLabels) {
    const normalizedLabels = dedupeStrings(tagLabels)

    if (!normalizedLabels.length) {
      return []
    }

    let tagDefinitions = await this.listTagDefinitions()
    const existingByLabel = new Map(tagDefinitions.map((definition) => [definition.label.toLowerCase(), definition]))
    const missingLabels = normalizedLabels.filter((label) => !existingByLabel.has(label.toLowerCase()))

    if (missingLabels.length) {
      await this.insertMissingTags(missingLabels)
      tagDefinitions = await this.listTagDefinitions()
    }

    return normalizedLabels
      .map((label) => tagDefinitions.find((definition) => definition.label.toLowerCase() === label.toLowerCase())?.id)
      .filter(Boolean)
  }

  async insertMissingTags(labels) {
    const normalizedLabels = dedupeStrings(labels)

    if (!normalizedLabels.length) {
      return
    }

    const supabase = await getSupabase()
    const now = new Date().toISOString()
    const catalogColumns = await this.getCatalogColumnConfig('tags')
    const { error } = await supabase
      .from('tags')
      .insert(normalizedLabels.map((label) => buildCatalogInsertRecord({
        label,
        isArchived: false,
        now,
        catalogColumns
      })))

    if (error && !isDuplicateRowError(error)) {
      throw new Error(error.message || 'Unable to create the missing tag in Supabase.')
    }
  }

  async insertLeadHistoryRows(rows) {
    if (!rows.length) {
      return
    }

    const supabase = await getSupabase()
    const { error } = await supabase
      .from('lead_history')
      .insert(rows.map((row) => ({
        lead_id: row.lead_id,
        field_name: row.field_name,
        old_value: row.old_value,
        new_value: row.new_value
      })))

    if (error) {
      throw new Error(error.message || 'Unable to save lead history to Supabase.')
    }
  }

  async insertNoteEntry(noteEntry, actor) {
    const now = noteEntry.createdAt || new Date().toISOString()
    const supabase = await getSupabase()
    const { error } = await supabase
      .from('notes')
      .insert({
        lead_id: noteEntry.leadId,
        content: noteEntry.content,
        created_at: now,
        created_by: noteEntry.createdByUserId || actor?.id || null,
        updated_at: now
      })

    if (error) {
      throw new Error(error.message || 'Unable to save the note to Supabase.')
    }

    await this.touchLead(noteEntry.leadId, actor, now)
  }

  async insertNoteVersion(existingNote, actor, changedAt) {
    const supabase = await getSupabase()
    const { error } = await supabase
      .from('note_versions')
      .insert({
        note_id: existingNote.id,
        previous_content: pickValue(existingNote, ['content', 'note']),
        edited_at: changedAt,
        edited_by: actor?.id || null
      })

    if (error) {
      throw new Error(error.message || 'Unable to save note version history to Supabase.')
    }
  }

  async touchLead(leadId, actor, timestamp = new Date().toISOString()) {
    const supabase = await getSupabase()
    const { error } = await supabase
      .from('leads')
      .update({
        updated_at: timestamp
      })
      .eq('id', leadId)

    if (error) {
      throw new Error(error.message || 'Unable to update the lead timestamp in Supabase.')
    }
  }

  async assertActiveAdminProfileAccess(actionLabel = 'manage tags or dispositions') {
    const supabase = await getSupabase()
    const { data: authData, error: authError } = await supabase.auth.getUser()

    if (authError) {
      throw new Error(authError.message || 'Unable to verify the signed-in CRM user.')
    }

    const userId = normalizeWhitespace(authData?.user?.id)

    if (!userId) {
      throw new Error('You must be signed in to manage tags or dispositions.')
    }

    const { data, error } = await supabase
      .from('profiles')
      .select(PROFILE_ACCESS_SELECT)
      .eq('id', userId)
      .maybeSingle()

    if (error) {
      throw new Error(error.message || 'Unable to load your CRM profile permissions.')
    }

    const role = normalizeProfileRole(data?.role)
    const isActive = data?.active === true

    if (role !== 'admin' || !isActive) {
      throw new Error(`Only active admin users can ${actionLabel}.`)
    }
  }

  async assertActiveAdminCatalogAccess() {
    await this.assertActiveAdminProfileAccess('manage tags or dispositions')
  }

  async assertActiveAdminSettingsAccess() {
    await this.assertActiveAdminProfileAccess('manage workspace settings')
  }

  async ensureUniqueCatalogLabel(table, label, currentId, entityLabel) {
    const normalizedLabel = normalizeWhitespace(label).toLowerCase()
    const normalizedCurrentId = normalizeWhitespace(currentId)
    const rows = await this.fetchCatalogRows(table)
    const duplicate = rows.find((row) =>
      row.id !== normalizedCurrentId
      && row.label.toLowerCase() === normalizedLabel
    )

    if (duplicate) {
      throw new Error(buildDuplicateCatalogMessage(entityLabel, label))
    }
  }

  async resolveReplacementTagIds(replacementLabels, deletedTagId) {
    const normalizedDeletedTagId = normalizeWhitespace(deletedTagId)
    const requestedLabels = dedupeStrings(replacementLabels)
    const tagDefinitions = await this.listTagDefinitions()
    const replacementIds = requestedLabels.map((label) =>
      tagDefinitions.find((definition) =>
        definition.id !== normalizedDeletedTagId
        && definition.label.toLowerCase() === label.toLowerCase()
      )?.id
    ).filter(Boolean)

    if (requestedLabels.length && replacementIds.length !== requestedLabels.length) {
      throw new Error('Choose replacement tags from the current admin-managed catalog.')
    }

    return replacementIds
  }

  async saveCatalogDefinition(table, payload, entityLabel) {
    const now = new Date().toISOString()
    const supabase = await getSupabase()
    const catalogColumns = await this.getCatalogColumnConfig(table)
    const normalizedLabel = normalizeWhitespace(payload.label)

    await this.ensureUniqueCatalogLabel(table, normalizedLabel, payload.id, entityLabel)

    let error = null

    if (payload.id) {
      ;({ error } = await supabase
        .from(table)
        .update(buildCatalogUpdateRecord({
          label: normalizedLabel,
          isArchived: payload.isArchived === true,
          now,
          catalogColumns
        }))
        .eq('id', payload.id))
    } else {
      ;({ error } = await supabase
        .from(table)
        .insert(buildCatalogInsertRecord({
          label: normalizedLabel,
          isArchived: payload.isArchived === true,
          now,
          catalogColumns
        })))
    }

    if (error) {
      throw new Error(describeCatalogWriteError(error, entityLabel, normalizedLabel))
    }
  }

  async getCatalogColumnConfig(table) {
    const rows = await this.fetchRows(table, (query) => query.limit(1)).catch(() => [])
    return inferCatalogColumnConfig(rows[0])
  }
}

function mapProfileUser(profile) {
  return {
    id: String(profile.id ?? '').trim(),
    name: String(profile.full_name ?? profile.name ?? profile.email ?? 'CRM user').trim(),
    email: String(profile.email ?? '').trim().toLowerCase(),
    role: normalizeProfileRole(profile.role),
    title: String(profile.title ?? '').trim()
  }
}

function mapCatalogRows(rows) {
  return (rows ?? [])
    .map((row) => ({
      id: String(row.id ?? '').trim(),
      label: normalizeWhitespace(row.label ?? row.name),
      isArchived: (row.is_archived ?? row.archived ?? row.isArchived) === true || row.active === false,
      createdAt: row.created_at ?? row.createdAt ?? '',
      updatedAt: row.updated_at ?? row.updatedAt ?? ''
    }))
    .filter((row) => row.id && row.label)
    .sort((left, right) => left.label.localeCompare(right.label))
}

function buildLeadTagsMap(rows, tagDefinitions) {
  const tagsById = new Map(tagDefinitions.map((definition) => [definition.id, definition.label]))
  const map = new Map()

  ;(rows ?? []).forEach((row) => {
    const leadId = String(row.lead_id ?? row.leadId ?? '').trim()
    const tagId = String(row.tag_id ?? row.tagId ?? '').trim()
    const tagLabel = normalizeWhitespace(row.label ?? tagsById.get(tagId))

    if (!leadId || !tagLabel) {
      return
    }

    const current = map.get(leadId) || []
    map.set(leadId, dedupeStrings([...current, tagLabel]))
  })

  return map
}

function buildNoteVersionsMap(rows, usersById = new Map()) {
  const map = new Map()

  ;(rows ?? []).forEach((row) => {
    const noteId = String(row.note_id ?? row.noteId ?? '').trim()

    if (!noteId) {
      return
    }

    const current = map.get(noteId) || []
    current.push({
      id: String(row.id ?? uid('note-version')),
      content: normalizeNotes(pickValue(row, ['previous_content', 'content', 'note'])),
      changedAt: row.edited_at ?? row.changed_at ?? row.changedAt ?? row.created_at ?? row.createdAt ?? '',
      changedByUserId: normalizeWhitespace(row.edited_by ?? row.changed_by_user_id ?? row.changedByUserId ?? row.changed_by ?? ''),
      changedByName: normalizeWhitespace(
        row.edited_by_name
        ?? row.changed_by_name
        ?? row.changedByName
        ?? usersById.get(normalizeWhitespace(row.edited_by ?? row.changed_by_user_id ?? row.changedByUserId ?? row.changed_by ?? ''))?.name
        ?? ''
      )
    })
    map.set(noteId, current)
  })

  return map
}

function buildLeadNotesMap(rows, noteVersionsByNoteId, usersById) {
  const map = new Map()

  ;(rows ?? []).forEach((row) => {
    const leadId = String(row.lead_id ?? row.leadId ?? '').trim()
    const noteId = String(row.id ?? '').trim()
    const createdByUserId = normalizeWhitespace(row.created_by ?? row.created_by_user_id ?? row.createdByUserId ?? '')

    if (!leadId || !noteId) {
      return
    }

    const current = map.get(leadId) || []
    current.push({
      id: noteId,
      leadId,
      content: normalizeNotes(pickValue(row, ['content', 'note'])),
      createdAt: row.created_at ?? row.createdAt ?? '',
      createdByUserId,
      createdByName: normalizeWhitespace(row.created_by_name ?? row.createdByName ?? usersById.get(createdByUserId)?.name ?? ''),
      updatedAt: row.updated_at ?? row.updatedAt ?? '',
      updatedByUserId: normalizeWhitespace(row.updated_by ?? row.updated_by_user_id ?? row.updatedByUserId ?? ''),
      updatedByName: normalizeWhitespace(row.updated_by_name ?? row.updatedByName ?? usersById.get(normalizeWhitespace(row.updated_by ?? row.updated_by_user_id ?? row.updatedByUserId ?? ''))?.name ?? ''),
      versions: noteVersionsByNoteId.get(noteId) || []
    })
    map.set(leadId, current)
  })

  map.forEach((entries, leadId) => {
    map.set(leadId, entries.sort((left, right) => Date.parse(right.createdAt ?? 0) - Date.parse(left.createdAt ?? 0)))
  })

  return map
}

function buildLatestLeadNotesMap(rows, usersById = new Map()) {
  const map = new Map()

  ;(rows ?? []).forEach((row) => {
    const leadId = String(row.lead_id ?? row.leadId ?? '').trim()
    const noteId = String(row.id ?? '').trim()
    const createdByUserId = normalizeWhitespace(row.created_by ?? row.created_by_user_id ?? row.createdByUserId ?? '')

    if (!leadId || !noteId || map.has(leadId)) {
      return
    }

    map.set(leadId, [{
      id: noteId,
      leadId,
      content: normalizeNotes(pickValue(row, ['content', 'note'])),
      createdAt: row.created_at ?? row.createdAt ?? '',
      createdByUserId,
      createdByName: normalizeWhitespace(row.created_by_name ?? row.createdByName ?? usersById.get(createdByUserId)?.name ?? ''),
      updatedAt: row.updated_at ?? row.updatedAt ?? '',
      updatedByUserId: normalizeWhitespace(row.updated_by ?? row.updated_by_user_id ?? row.updatedByUserId ?? ''),
      updatedByName: normalizeWhitespace(row.updated_by_name ?? row.updatedByName ?? ''),
      versions: []
    }])
  })

  return map
}

function buildLeadHistoryMap(rows, usersById) {
  const map = new Map()

  ;(rows ?? []).forEach((row) => {
    const leadId = String(row.lead_id ?? row.leadId ?? '').trim()
    const fieldName = normalizeLeadHistoryFieldName(row.field_name ?? row.fieldName ?? row.field_label ?? row.field ?? row.label ?? '')
    const changedByUserId = normalizeWhitespace(
      row.changed_by
      ?? row.changed_by_user_id
      ?? row.changedByUserId
      ?? row.created_by
      ?? row.created_by_user_id
      ?? row.createdByUserId
      ?? ''
    )
    const changedByName = normalizeWhitespace(
      row.changed_by_name
      ?? row.changedByName
      ?? row.created_by_name
      ?? row.createdByName
      ?? usersById.get(changedByUserId)?.name
      ?? ''
    )
    const oldValue = normalizeLeadHistoryFieldValue(fieldName, row.old_value ?? row.oldValue ?? row.previous_value ?? row.previousValue)
    const newValue = normalizeLeadHistoryFieldValue(fieldName, row.new_value ?? row.newValue ?? row.nextValue)
    const changedAt = row.changed_at ?? row.changedAt ?? row.created_at ?? row.createdAt ?? ''

    if (!leadId) {
      return
    }

    const current = map.get(leadId) || []
    current.push({
      id: String(row.id ?? uid('activity')),
      type: normalizeLeadHistoryType(row.type ?? row.action_type, fieldName),
      fieldName: fieldName || 'unknown',
      fieldLabel: fieldName || 'unknown',
      oldValue,
      previousValue: oldValue,
      newValue,
      nextValue: newValue,
      message: normalizeWhitespace(row.message ?? buildLeadHistoryMessage(fieldName, oldValue, newValue)),
      changedAt,
      createdAt: changedAt,
      changedByUserId,
      createdByUserId: changedByUserId,
      changedByName,
      createdByName: changedByName
    })
    map.set(leadId, current)
  })

  map.forEach((entries, leadId) => {
    map.set(leadId, entries.sort((left, right) => Date.parse(right.changedAt ?? right.createdAt ?? 0) - Date.parse(left.changedAt ?? left.createdAt ?? 0)))
  })

  return map
}

function mapLeadRow(row, { usersById, tagsByLeadId, notesByLeadId, historyByLeadId, dispositionDefinitions = [] }) {
  const leadId = String(row.id ?? '').trim()
  const firstName = normalizeWhitespace(row.first_name)
  const lastName = normalizeWhitespace(row.last_name)
  const fullName = normalizeWhitespace(row.full_name) || buildFullName(firstName, lastName)
  const email = normalizeEmail(row.email)
  const phoneKey = normalizePhone(row.phone)
  const assignedRepId = normalizeWhitespace(row.assigned_rep_id)
  const dispositionId = normalizeWhitespace(row.disposition_id)
  const timezoneOverridden = row.timezone_overridden === true
  const { autoTimeZone, timeZone } = resolveLeadTimeZone({
    phone: phoneKey,
    storedTimeZone: row.timezone,
    timezoneOverridden
  })
  const noteHistory = notesByLeadId.get(leadId) || []
  const tags = tagsByLeadId.get(leadId) || []
  const activityLog = historyByLeadId.get(leadId) || []
  const disposition = resolveDispositionLabel(dispositionId, dispositionDefinitions)
  const status = resolveLeadRowStatus(row.status, activityLog)
  const lifecycleType = resolveLeadRowLifecycle(row.lifecycle, activityLog)

  return {
    id: leadId,
    externalContactId: normalizeWhitespace(row.external_contact_id),
    firstName,
    lastName,
    fullName: fullName || email || formatPhone(phoneKey) || 'Unnamed lead',
    email,
    emailKey: email,
    phoneKey,
    phone: formatPhone(phoneKey) || normalizeWhitespace(row.phone),
    businessName: normalizeWhitespace(row.business_name),
    tags,
    notes: noteHistory[0]?.content || '',
    createdAt: row.created_at ?? new Date().toISOString(),
    updatedAt: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    sourceCreatedRaw: normalizeWhitespace(row.source_created_raw),
    sourceLastActivityRaw: normalizeWhitespace(row.source_last_activity_raw),
    assignedTo: normalizeWhitespace(usersById.get(assignedRepId)?.name ?? ''),
    assignedRepId,
    status,
    subscriptionType: normalizeWhitespace(row.subscription_type),
    timeZone,
    timezoneOverridden,
    autoTimeZone,
    lifecycleType,
    disposition,
    dispositionId,
    followUpAction: normalizeWhitespace(row.follow_up_action),
    followUpAt: normalizeWhitespace(row.follow_up_at),
    noteHistory,
    activityLog
  }
}

function mapLeadSuggestionRow(row) {
  const firstName = normalizeWhitespace(row.first_name)
  const lastName = normalizeWhitespace(row.last_name)
  const phoneKey = normalizePhone(row.phone)
  const fullName = normalizeWhitespace(row.full_name) || buildFullName(firstName, lastName)
  const { timeZone } = resolveLeadTimeZone({
    phone: phoneKey,
    storedTimeZone: row.timezone,
    timezoneOverridden: false
  })

  return {
    id: String(row.id ?? '').trim(),
    firstName,
    lastName,
    fullName: fullName || normalizeEmail(row.email) || formatPhone(phoneKey) || 'Unnamed lead',
    email: normalizeEmail(row.email),
    phone: formatPhone(phoneKey) || normalizeWhitespace(row.phone),
    phoneKey,
    businessName: normalizeWhitespace(row.business_name),
    status: resolveLeadRowStatus(row.status, []),
    lifecycleType: resolveLeadRowLifecycle(row.lifecycle, []),
    subscriptionType: normalizeWhitespace(row.subscription_type),
    timeZone,
    updatedAt: row.updated_at ?? row.updatedAt ?? ''
  }
}

function getLeadSuggestionRank(suggestion, query) {
  const normalizedQuery = normalizeWhitespace(query).toLowerCase()
  const normalizedPhoneQuery = normalizePhone(query)
  const fullName = normalizeWhitespace(suggestion.fullName).toLowerCase()
  const firstName = normalizeWhitespace(suggestion.firstName).toLowerCase()
  const lastName = normalizeWhitespace(suggestion.lastName).toLowerCase()
  const email = normalizeWhitespace(suggestion.email).toLowerCase()
  const phoneKey = normalizePhone(suggestion.phoneKey || suggestion.phone)
  const businessName = normalizeWhitespace(suggestion.businessName).toLowerCase()

  if (!normalizedQuery && !normalizedPhoneQuery) {
    return 6
  }

  if (normalizedQuery && fullName === normalizedQuery) {
    return 0
  }

  if (normalizedQuery && fullName.startsWith(normalizedQuery)) {
    return 1
  }

  if (normalizedQuery && (firstName.startsWith(normalizedQuery) || lastName.startsWith(normalizedQuery))) {
    return 2
  }

  if (normalizedQuery && email.startsWith(normalizedQuery)) {
    return 3
  }

  if (normalizedPhoneQuery && phoneKey.startsWith(normalizedPhoneQuery)) {
    return 4
  }

  if (
    (normalizedQuery && (
      fullName.includes(normalizedQuery)
      || email.includes(normalizedQuery)
      || businessName.includes(normalizedQuery)
    ))
    || (normalizedPhoneQuery && phoneKey.includes(normalizedPhoneQuery))
  ) {
    return 5
  }

  return 6
}

function buildLeadInsertPayload(client, { dispositionDefinitions = [], existingLead = null } = {}) {
  return {
    external_contact_id: client.externalContactId || null,
    first_name: client.firstName,
    last_name: client.lastName,
    email: client.email,
    phone: client.phone,
    business_name: client.businessName || null,
    status: normalizeStatus(client.status),
    lifecycle: normalizeLifecycle(client.lifecycleType),
    assigned_rep_id: client.assignedRepId || null,
    subscription_type: client.subscriptionType || null,
    timezone: client.timeZone || null,
    timezone_overridden: client.timezoneOverridden === true,
    disposition_id: resolveDispositionId(client, dispositionDefinitions, existingLead),
    follow_up_action: client.followUpAction || null,
    follow_up_at: client.followUpAt || null,
    source_created_raw: client.sourceCreatedRaw || null,
    source_last_activity_raw: client.sourceLastActivityRaw || null,
    updated_at: client.updatedAt,
    created_at: client.createdAt
  }
}

function buildLeadUpdatePayload(client, { dispositionDefinitions = [], existingLead = null } = {}) {
  return {
    external_contact_id: client.externalContactId || null,
    first_name: client.firstName,
    last_name: client.lastName,
    email: client.email,
    phone: client.phone,
    business_name: client.businessName || null,
    status: normalizeStatus(client.status),
    lifecycle: normalizeLifecycle(client.lifecycleType),
    assigned_rep_id: client.assignedRepId || null,
    subscription_type: client.subscriptionType || null,
    timezone: client.timeZone || null,
    timezone_overridden: client.timezoneOverridden === true,
    disposition_id: resolveDispositionId(client, dispositionDefinitions, existingLead),
    follow_up_action: client.followUpAction || null,
    follow_up_at: client.followUpAt || null,
    source_created_raw: client.sourceCreatedRaw || null,
    source_last_activity_raw: client.sourceLastActivityRaw || null,
    updated_at: client.updatedAt
  }
}

function resolveDispositionLabel(dispositionId, dispositionDefinitions) {
  if (dispositionId) {
    const matchedDefinition = dispositionDefinitions.find((definition) => definition.id === dispositionId)

    if (matchedDefinition?.label) {
      return matchedDefinition.label
    }
  }

  return ''
}

function resolveDispositionId(client, dispositionDefinitions, existingLead) {
  const explicitDispositionId = normalizeWhitespace(client.dispositionId)

  if (explicitDispositionId) {
    return explicitDispositionId
  }

  const selectedDisposition = normalizeWhitespace(client.disposition)

  if (!selectedDisposition) {
    return null
  }

  const directMatch = dispositionDefinitions.find((definition) => definition.id === selectedDisposition)

  if (directMatch) {
    return directMatch.id
  }

  const labelMatch = dispositionDefinitions.find((definition) => definition.label.toLowerCase() === selectedDisposition.toLowerCase())

  if (labelMatch) {
    return labelMatch.id
  }

  if (
    existingLead?.dispositionId
    && normalizeWhitespace(existingLead.disposition).toLowerCase() === selectedDisposition.toLowerCase()
  ) {
    return existingLead.dispositionId
  }

  throw new Error(`Disposition "${selectedDisposition}" is no longer available.`)
}

function buildLeadStateHistoryRows({ leadId, client, existingLead, actor, changedAt }) {
  const rows = []
  const previousStatus = existingLead ? normalizeStatus(existingLead.status) : ''
  const nextStatus = normalizeStatus(client.status)
  const previousLifecycle = existingLead ? normalizeLifecycle(existingLead.lifecycleType) : ''
  const nextLifecycle = normalizeLifecycle(client.lifecycleType)

  if (!existingLead || previousStatus !== nextStatus) {
    rows.push(buildLeadHistoryRow({
      leadId,
      fieldName: 'status',
      oldValue: previousStatus ? serializeLeadStatus(previousStatus) : null,
      newValue: serializeLeadStatus(nextStatus),
      actor,
      changedAt
    }))
  }

  if (!existingLead || previousLifecycle !== nextLifecycle) {
    rows.push(buildLeadHistoryRow({
      leadId,
      fieldName: 'lifecycle',
      oldValue: previousLifecycle || null,
      newValue: nextLifecycle,
      actor,
      changedAt
    }))
  }

  return rows
}

function buildLeadHistoryRow({ leadId, fieldName, oldValue, newValue, actor, changedAt }) {
  return {
    lead_id: leadId,
    field_name: fieldName,
    old_value: oldValue,
    new_value: newValue
  }
}

function normalizeLeadHistoryFieldName(value) {
  const normalized = normalizeWhitespace(value)
  const key = normalized.toLowerCase().replace(/[\s_-]+/g, '')

  if (key === 'status') {
    return 'status'
  }

  if (key === 'lifecycle' || key === 'lifecycletype') {
    return 'lifecycle'
  }

  return normalized
}

function resolveCurrentLeadStatus(historyEntries) {
  const statusEntry = (historyEntries ?? []).find((entry) => normalizeLeadHistoryFieldName(entry.fieldName) === 'status')
  return statusEntry ? normalizeStatus(statusEntry.newValue) : 'new'
}

function resolveCurrentLeadLifecycle(historyEntries) {
  const lifecycleEntry = (historyEntries ?? []).find((entry) => normalizeLeadHistoryFieldName(entry.fieldName) === 'lifecycle')
  return lifecycleEntry ? normalizeLifecycle(lifecycleEntry.newValue) : 'lead'
}

function resolveLeadRowStatus(rowStatus, historyEntries) {
  const normalizedRowStatus = normalizeWhitespace(rowStatus)

  if (normalizedRowStatus) {
    return normalizeStatus(normalizedRowStatus)
  }

  // Migration safety only: fall back to the audit log until every leads.status row is backfilled.
  return resolveCurrentLeadStatus(historyEntries)
}

function resolveLeadRowLifecycle(rowLifecycle, historyEntries) {
  const normalizedRowLifecycle = normalizeWhitespace(rowLifecycle)

  if (normalizedRowLifecycle) {
    return normalizeLifecycle(normalizedRowLifecycle)
  }

  // Migration safety only: fall back to the audit log until every leads.lifecycle row is backfilled.
  return resolveCurrentLeadLifecycle(historyEntries)
}

function normalizeLeadHistoryValue(value) {
  if (Array.isArray(value)) {
    return dedupeStrings(value).join(', ') || '—'
  }

  if (value === null || value === undefined) {
    return '—'
  }

  if (typeof value === 'object') {
    return normalizeWhitespace(JSON.stringify(value)) || '—'
  }

  return normalizeWhitespace(String(value)) || '—'
}

function normalizeLeadHistoryFieldValue(fieldName, value) {
  const normalizedFieldName = normalizeLeadHistoryFieldName(fieldName)
  const normalizedValue = normalizeLeadHistoryValue(value)

  if (normalizedFieldName === 'status') {
    return serializeLeadStatus(normalizeStatus(normalizedValue))
  }

  if (normalizedFieldName === 'lifecycle') {
    return normalizeLifecycle(normalizedValue)
  }

  return normalizedValue
}

function normalizeLeadHistoryType(rawType, fieldName) {
  const explicitType = normalizeWhitespace(rawType).toLowerCase()

  if (explicitType) {
    return explicitType
  }

  const normalizedFieldName = normalizeWhitespace(fieldName).toLowerCase()

  if (normalizedFieldName === 'assigned_rep_id' || normalizedFieldName === 'assigned_to') {
    return 'assignment'
  }

  if (normalizedFieldName === 'disposition') {
    return 'disposition'
  }

  if (normalizedFieldName === 'follow_up_action' || normalizedFieldName === 'follow_up_at') {
    return 'follow-up'
  }

  if (normalizedFieldName === 'status') {
    return 'status'
  }

  if (normalizedFieldName === 'tags') {
    return 'tags'
  }

  return 'change'
}

function buildLeadHistoryMessage(fieldName, oldValue, newValue) {
  const normalizedFieldName = fieldName || 'Field'
  return `${normalizedFieldName} changed from ${oldValue} to ${newValue}.`
}

function normalizeStatusFilter(value) {
  if (normalizeWhitespace(value).toLowerCase() === 'all') {
    return 'all'
  }

  return normalizeStatus(value)
}

function buildLeadBooleanExpression({ search = '', filters = {} } = {}) {
  const groups = []
  const searchConditions = buildLeadSearchConditions(search)

  if (searchConditions.length) {
    groups.push(searchConditions)
  }

  const firstNames = normalizeFilterValues(filters?.multi?.firstNames)
  if (firstNames.length) {
    groups.push(firstNames.map((value) => buildIlikeCondition('first_name', value)))
  }

  const lastNames = normalizeFilterValues(filters?.multi?.lastNames)
  if (lastNames.length) {
    groups.push(lastNames.map((value) => buildIlikeCondition('last_name', value)))
  }

  const subscriptionTypes = normalizeFilterValues(filters?.multi?.subscriptionTypes)
  if (subscriptionTypes.length) {
    groups.push(subscriptionTypes.map((value) => buildIlikeCondition('subscription_type', value)))
  }

  const timeZones = normalizeFilterValues(filters?.multi?.timeZones)
  if (timeZones.length) {
    groups.push(timeZones.map((value) => buildIlikeCondition('timezone', value)))
  }

  const areaCodes = normalizeAreaCodeFilterValues(filters?.multi?.areaCodes)
  if (areaCodes.length) {
    groups.push(areaCodes.map((value) => buildIlikeCondition('phone', value, true)))
  }

  const nonEmptyGroups = groups.filter((group) => group.length)

  if (!nonEmptyGroups.length) {
    return ''
  }

  if (nonEmptyGroups.length === 1) {
    return nonEmptyGroups[0].join(',')
  }

  return `and(${nonEmptyGroups.map((group) => `or(${group.join(',')})`).join(',')})`
}

function buildLeadListBooleanExpression({ scope = 'leads', searchExpression = '' } = {}) {
  const groupedSearchExpression = ensureGroupedBooleanExpression(searchExpression)

  if (scope === 'members' || scope === 'all') {
    return searchExpression
  }

  if (!searchExpression) {
    return 'lifecycle.is.null,lifecycle.eq.lead'
  }

  // Migration safety: keep null lifecycle rows visible in Leads until the column is fully backfilled.
  return `and(or(lifecycle.is.null,lifecycle.eq.lead),${groupedSearchExpression})`
}

function applyLeadListSort(query, sort = {}) {
  const field = normalizeWhitespace(sort?.field)
  const ascending = sort?.direction === 'asc'

  switch (field) {
    case 'name':
      return query
        .order('full_name', { ascending, nullsFirst: false })
        .order('last_name', { ascending, nullsFirst: false })
        .order('first_name', { ascending, nullsFirst: false })
        .order('updated_at', { ascending: false, nullsFirst: false })
    case 'email':
      return query.order('email', { ascending, nullsFirst: false }).order('updated_at', { ascending: false, nullsFirst: false })
    case 'phone':
      return query.order('phone', { ascending, nullsFirst: false }).order('updated_at', { ascending: false, nullsFirst: false })
    case 'status':
      return query.order('status', { ascending, nullsFirst: false }).order('updated_at', { ascending: false, nullsFirst: false })
    case 'updatedAt':
    default:
      return query.order('updated_at', { ascending, nullsFirst: false })
  }
}

function buildIlikeCondition(column, value, contains = false) {
  const pattern = contains ? `*${value}*` : value
  return `${column}.ilike.${pattern}`
}

function buildPhoneIlikeCondition(column, value, contains = false) {
  const digits = normalizePhone(value)

  if (!digits) {
    return ''
  }

  const body = digits.split('').join('*')
  const pattern = contains ? `*${body}*` : `${body}*`
  return `${column}.ilike.${pattern}`
}

function buildLeadSearchConditions(search = '') {
  const normalizedSearch = sanitizePostgrestValue(search)
  const conditions = [
    normalizedSearch ? buildIlikeCondition('first_name', normalizedSearch, true) : '',
    normalizedSearch ? buildIlikeCondition('last_name', normalizedSearch, true) : '',
    normalizedSearch ? buildIlikeCondition('full_name', normalizedSearch, true) : '',
    normalizedSearch ? buildIlikeCondition('email', normalizedSearch, true) : '',
    normalizedSearch ? buildIlikeCondition('phone', normalizedSearch, true) : '',
    normalizedSearch ? buildIlikeCondition('business_name', normalizedSearch, true) : '',
    buildPhoneIlikeCondition('phone', search, true)
  ].filter(Boolean)

  return [...new Set(conditions)]
}

function ensureGroupedBooleanExpression(expression = '') {
  const normalizedExpression = normalizeWhitespace(expression)

  if (!normalizedExpression) {
    return ''
  }

  if (normalizedExpression.startsWith('and(') || normalizedExpression.startsWith('or(')) {
    return normalizedExpression
  }

  return `or(${normalizedExpression})`
}

function normalizeFilterValues(values) {
  return dedupeStrings((Array.isArray(values) ? values : [])
    .map((value) => sanitizePostgrestValue(value))
    .filter(Boolean))
}

function normalizeAreaCodeFilterValues(values) {
  return dedupeStrings((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').replace(/\D/g, '').slice(0, 3))
    .filter((value) => value.length === 3))
}

function sanitizePostgrestValue(value) {
  return normalizeWhitespace(value).replace(/[(),]/g, ' ').replace(/\*/g, '').trim()
}

function resolveTagId(activeTagLabel, tagDefinitions) {
  const normalizedLabel = normalizeWhitespace(activeTagLabel)

  if (!normalizedLabel || normalizedLabel === 'all') {
    return ''
  }

  return tagDefinitions.find((definition) =>
    String(definition.label ?? '').trim().toLowerCase() === normalizedLabel.toLowerCase()
  )?.id || ''
}

function stripJoinedLeadRow(row) {
  if (!row || typeof row !== 'object') {
    return row
  }

  const { lead_tags: _leadTags, ...leadRow } = row
  return leadRow
}

function pickValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) {
      return row[key]
    }
  }

  return ''
}

function normalizeStatus(value) {
  const normalized = normalizeWhitespace(value).toLowerCase()

  if (normalized === 'member') {
    return 'won'
  }

  return CRM_STATUS_OPTIONS.includes(normalized) ? normalized : 'new'
}

function serializeLeadStatus(value) {
  switch (normalizeStatus(value)) {
    case 'contacted':
      return 'Contacted'
    case 'qualified':
      return 'Qualified'
    case 'won':
      return 'WON'
    case 'inactive':
      return 'Inactive'
    case 'new':
    default:
      return 'New'
  }
}

function normalizeLifecycle(value) {
  return normalizeWhitespace(value).toLowerCase() === 'member' ? 'member' : 'lead'
}

function isDuplicateRowError(error) {
  const code = normalizeWhitespace(error?.code)
  const message = normalizeWhitespace(error?.message).toLowerCase()
  return code === '23505' || message.includes('duplicate key') || message.includes('duplicate')
}

function isRangeNotSatisfiableError(error) {
  const code = normalizeWhitespace(error?.code)
  const message = normalizeWhitespace(error?.message).toLowerCase()
  const details = normalizeWhitespace(error?.details).toLowerCase()
  return Number(error?.status) === 416
    || code === 'PGRST103'
    || message.includes('range not satisfiable')
    || details.includes('range not satisfiable')
}

function buildDuplicateCatalogMessage(entityLabel, label) {
  return `A ${entityLabel} named "${label}" already exists.`
}

function describeCatalogWriteError(error, entityLabel, label) {
  if (isDuplicateRowError(error)) {
    return buildDuplicateCatalogMessage(entityLabel, label)
  }

  return error?.message || `Unable to save the ${entityLabel} to Supabase.`
}

function inferCatalogColumnConfig(row = null) {
  if (!row) {
    return {
      valueColumn: 'name',
      activeColumn: 'active',
      archivedColumn: 'archived',
      createdAtColumn: 'created_at',
      updatedAtColumn: null
    }
  }

  return {
    valueColumn: hasOwnCatalogColumn(row, 'label') ? 'label' : (hasOwnCatalogColumn(row, 'name') ? 'name' : 'name'),
    activeColumn: hasOwnCatalogColumn(row, 'active') ? 'active' : null,
    archivedColumn: hasOwnCatalogColumn(row, 'archived')
      ? 'archived'
      : (hasOwnCatalogColumn(row, 'is_archived') ? 'is_archived' : null),
    createdAtColumn: hasOwnCatalogColumn(row, 'createdAt')
      ? 'createdAt'
      : (hasOwnCatalogColumn(row, 'created_at') ? 'created_at' : null),
    updatedAtColumn: hasOwnCatalogColumn(row, 'updatedAt')
      ? 'updatedAt'
      : (hasOwnCatalogColumn(row, 'updated_at') ? 'updated_at' : null)
  }
}

function buildCatalogInsertRecord({ label, isArchived, now, catalogColumns }) {
  const record = {
    [catalogColumns.valueColumn]: label
  }

  if (catalogColumns.activeColumn) {
    record[catalogColumns.activeColumn] = isArchived !== true
  }

  if (catalogColumns.archivedColumn) {
    record[catalogColumns.archivedColumn] = isArchived === true
  }

  if (catalogColumns.createdAtColumn) {
    record[catalogColumns.createdAtColumn] = now
  }

  if (catalogColumns.updatedAtColumn) {
    record[catalogColumns.updatedAtColumn] = now
  }

  return record
}

function buildCatalogUpdateRecord({ label, isArchived, now, catalogColumns }) {
  const record = {
    [catalogColumns.valueColumn]: label
  }

  if (catalogColumns.activeColumn) {
    record[catalogColumns.activeColumn] = isArchived !== true
  }

  if (catalogColumns.archivedColumn) {
    record[catalogColumns.archivedColumn] = isArchived === true
  }

  if (catalogColumns.updatedAtColumn) {
    record[catalogColumns.updatedAtColumn] = now
  }

  return record
}

function hasOwnCatalogColumn(row, key) {
  return Boolean(row) && Object.prototype.hasOwnProperty.call(row, key)
}

function normalizeProfileRole(role) {
  if (role === 'admin') {
    return 'admin'
  }

  if (role === 'senior_rep') {
    return 'senior'
  }

  return 'sales'
}
