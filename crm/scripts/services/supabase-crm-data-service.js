import {
  CrmDataService,
  CRM_STATUS_OPTIONS
} from './crm-data-service.js'
import {
  normalizeTimeZoneLabel,
  inferTimeZoneFromPhone,
  resolveLeadTimeZone
} from './crm-time-zone-resolver.js'
import { US_AREA_CODE_TIME_ZONE_GROUPS } from '../data/us-area-code-time-zones.js'
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
import { getSupabase, getSupabaseConfig } from '../../../src/lib/supabase-browser.js'

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
const CALENDAR_EVENT_SELECT_COLUMNS = [
  'id',
  'lead_id',
  'owner_user_id',
  'created_by_user_id',
  'title',
  'action_text',
  'notes',
  'start_at',
  'end_at',
  'event_time_zone',
  'status',
  'visibility',
  'completed_at',
  'canceled_at',
  'created_at',
  'updated_at'
].join(', ')
const CALENDAR_LEAD_SELECT_COLUMNS = [
  'id',
  'first_name',
  'last_name',
  'full_name',
  'phone',
  'email',
  'lifecycle',
  'timezone'
].join(', ')
const CALENDAR_EVENT_STATUS_OPTIONS = ['scheduled', 'completed', 'canceled', 'missed']
const PROFILE_ACCESS_SELECT = 'role, active'
const MAILBOX_SENDER_SELECT_COLUMNS = [
  'id',
  'kind',
  'owner_user_id',
  'sender_email',
  'sender_name',
  'signature_mode',
  'signature_template',
  'signature_html_override',
  'signature_text',
  'imap_inbox_folder',
  'imap_sent_folder',
  'is_active',
  'last_verified_at',
  'created_at',
  'updated_at'
].join(', ')
const EMAIL_THREAD_SELECT_COLUMNS = [
  'id',
  'mailbox_sender_id',
  'lead_id',
  'subject',
  'snippet',
  'participants',
  'folder_presence',
  'latest_message_id',
  'latest_message_at',
  'unread_count',
  'is_starred',
  'last_message_direction',
  'last_message_status',
  'created_at',
  'updated_at'
].join(', ')
const EMAIL_MESSAGE_SELECT_COLUMNS = [
  'id',
  'lead_id',
  'thread_id',
  'sender_mailbox_id',
  'sender_kind',
  'created_by_user_id',
  'from_email',
  'from_name',
  'to_email',
  'to_emails',
  'subject',
  'body_text',
  'body_html',
  'provider',
  'provider_message_id',
  'status',
  'error_message',
  'direction',
  'folder',
  'is_read',
  'is_starred',
  'received_at',
  'message_id_header',
  'in_reply_to',
  'references_header',
  'snippet',
  'participants',
  'source',
  'sent_at',
  'created_at',
  'updated_at'
].join(', ')
const MAILBOX_SYNC_STATE_SELECT_COLUMNS = [
  'mailbox_sender_id',
  'folder',
  'last_synced_at',
  'last_uid',
  'last_error',
  'sync_status',
  'synced_message_count',
  'created_at',
  'updated_at'
].join(', ')
const SUPABASE_BATCH_SIZE = 1000
const SUPABASE_FILTER_BATCH_SIZE = 250
const TIME_ZONE_FILTER_AREA_CODES = Object.freeze(Object.fromEntries(
  Object.entries(US_AREA_CODE_TIME_ZONE_GROUPS).map(([timeZone, areaCodes]) => [
    normalizeWhitespace(timeZone).toLowerCase(),
    Array.isArray(areaCodes) ? areaCodes : []
  ])
))

export class SupabaseCrmDataService extends CrmDataService {
  constructor() {
    super()
  }

  async initializeWorkspace() {
    const [tagDefinitions, dispositionDefinitions, leadCount, memberCount, mailboxSenders] = await Promise.all([
      this.listTagDefinitions(),
      this.listDispositionDefinitions(),
      this.countLeadsForScope('leads'),
      this.countLeadsForScope('members'),
      this.listAvailableMailboxSenders()
    ])

    return {
      importHistory: [],
      allowedTags: tagDefinitions.filter((definition) => definition.isArchived !== true).map((definition) => definition.label),
      tagDefinitions,
      dispositionDefinitions,
      mailboxSenders,
      workspaceSummary: {
        leadCount,
        memberCount
      }
    }
  }

  async initialize() {
    const [leadRows, tagDefinitions, dispositionDefinitions, profileRows, mailboxSenders] = await Promise.all([
      this.fetchAllLeadRows(),
      this.listTagDefinitions(),
      this.listDispositionDefinitions(),
      this.fetchAllOptionalRows('profiles'),
      this.listAvailableMailboxSenders()
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
      dispositionDefinitions,
      mailboxSenders
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
      query = applyStoredStatusFilter(query, normalizedStatusFilter)
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
    const [existing, existingLeadRow] = payload.id
      ? await Promise.all([
        this.getClientById(payload.id),
        this.fetchLeadRowById(payload.id)
      ])
      : [null, null]
    const client = this.normalizeManualClient(payload, existing, payload.actor ?? null)
    const dispositionDefinitions = await this.listDispositionDefinitions()
    const supabase = await getSupabase()
    let leadId = String(existing?.id ?? '').trim()

    if (existing) {
      const updatePayload = buildLeadUpdatePayload(client, { dispositionDefinitions, existingLead: existing })

      if (shouldPreserveStoredLeadStatus({
        payload,
        client,
        existingLead: existing,
        existingLeadRow
      })) {
        delete updatePayload.status
      }

      const { error } = await supabase
        .from('leads')
        .update(updatePayload)
        .eq('id', existing.id)

      if (error) {
        if (isLeadWorkflowConstraintError(error)) {
          const recovered = await this.tryRecoverLeadStatusUpdate({
            supabase,
            leadId: existing.id,
            updatePayload,
            client,
            existingLead: existing,
            existingLeadRow
          })

          if (!recovered) {
            throw new Error(describeLeadWriteError(error))
          }
        } else {
          throw new Error(describeLeadWriteError(error))
        }
      }
    } else {
      const insertPayload = buildLeadInsertPayload(client, { dispositionDefinitions, existingLead: existing })
      let { data, error } = await supabase
        .from('leads')
        .insert(insertPayload)
        .select('id')
        .single()

      if (error) {
        if (isLeadWorkflowConstraintError(error)) {
          const recoveredLeadId = await this.tryRecoverLeadInsert({
            supabase,
            insertPayload,
            client
          })

          if (!recoveredLeadId) {
            throw new Error(describeLeadWriteError(error))
          }

          data = { id: recoveredLeadId }
          error = null
        } else {
          throw new Error(describeLeadWriteError(error))
        }
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
    const [leadTagRows, noteRows, historyRows, emailMessageRows, mailboxSenders] = await Promise.all([
      this.fetchOptionalRows('lead_tags', (query) => query.eq('lead_id', clientId)),
      this.fetchOptionalRows('notes', (query) => query.eq('lead_id', clientId).order('created_at', { ascending: false })),
      this.fetchLeadHistoryRows((query) => query.eq('lead_id', clientId)),
      this.listLeadEmailMessages(clientId),
      this.listAvailableMailboxSenders()
    ])
    const noteIds = noteRows.map((row) => String(row.id ?? '')).filter(Boolean)
    const noteVersionRows = noteIds.length
      ? await this.fetchOptionalRows('note_versions', (query) => query.in('note_id', noteIds).order('edited_at', { ascending: false }))
      : []
    const mailboxSendersById = new Map(mailboxSenders.map((sender) => [sender.id, sender]))

    return mapLeadRow(leadRow, {
      usersById: userMap,
      tagsByLeadId: buildLeadTagsMap(leadTagRows, tagDefinitions),
      notesByLeadId: buildLeadNotesMap(noteRows, buildNoteVersionsMap(noteVersionRows, userMap), userMap),
      historyByLeadId: buildLeadHistoryMap(historyRows, userMap),
      emailHistoryByLeadId: buildLeadEmailHistoryMap(emailMessageRows, userMap, mailboxSendersById),
      dispositionDefinitions
    })
  }

  async listAvailableMailboxSenders() {
    const supabase = await getSupabase()
    const config = await getSupabaseConfig()
    const { data, error } = await supabase
      .from('mailbox_senders')
      .select(MAILBOX_SENDER_SELECT_COLUMNS)
      .order('kind', { ascending: true })
      .order('sender_name', { ascending: true })

    if (error) {
      return []
    }

    return (data ?? []).map((row) => mapMailboxSenderRow(row, { storageBaseUrl: config.url })).filter((sender) => sender.id)
  }

  async listEmailMailboxes() {
    const supabase = await getSupabase()
    const [mailboxes, syncResponse] = await Promise.all([
      this.listAvailableMailboxSenders(),
      supabase
        .from('mailbox_sync_state')
        .select(MAILBOX_SYNC_STATE_SELECT_COLUMNS)
        .order('updated_at', { ascending: false })
    ])
    const syncStateByMailboxId = new Map()
    const syncRows = syncResponse.error ? [] : (syncResponse.data ?? [])

    ;(syncRows ?? []).forEach((row) => {
      const mappedRow = mapMailboxSyncStateRow(row)
      const current = syncStateByMailboxId.get(mappedRow.mailboxSenderId) || []
      current.push(mappedRow)
      syncStateByMailboxId.set(mappedRow.mailboxSenderId, current)
    })

    return mailboxes.map((mailbox) => ({
      ...mailbox,
      syncState: syncStateByMailboxId.get(mailbox.id) || []
    }))
  }

  async listEmailThreads({
    mailboxId = '',
    folder = 'INBOX',
    searchQuery = '',
    limit = 100
  } = {}) {
    const normalizedMailboxId = normalizeWhitespace(mailboxId)

    if (!normalizedMailboxId) {
      return []
    }

    const normalizedFolder = normalizeWhitespace(folder).toUpperCase() || 'INBOX'
    const supabase = await getSupabase()
    let query = supabase
      .from('email_threads')
      .select(EMAIL_THREAD_SELECT_COLUMNS)
      .eq('mailbox_sender_id', normalizedMailboxId)
      .order('latest_message_at', { ascending: false })
      .limit(Math.max(1, Number(limit) || 100))

    if (normalizedFolder !== 'ALL') {
      query = query.contains('folder_presence', [normalizedFolder])
    }

    const { data, error } = await query

    if (error) {
      throw new Error(error.message || 'Unable to load email conversations from Supabase.')
    }

    const normalizedSearchQuery = normalizeWhitespace(searchQuery).toLowerCase()

    return (data ?? [])
      .map(mapEmailThreadRow)
      .filter((thread) => thread.id)
      .filter((thread) => {
        if (!normalizedSearchQuery) {
          return true
        }

        const haystack = [
          thread.subject,
          thread.snippet,
          thread.participantSummary,
          thread.leadSummary
        ].join(' ').toLowerCase()

        return haystack.includes(normalizedSearchQuery)
      })
  }

  async getEmailThread(threadId) {
    const normalizedThreadId = normalizeWhitespace(threadId)

    if (!normalizedThreadId) {
      return null
    }

    const supabase = await getSupabase()
    const [threadResponse, messageResponse, profileRows, mailboxSenders] = await Promise.all([
      supabase
        .from('email_threads')
        .select(EMAIL_THREAD_SELECT_COLUMNS)
        .eq('id', normalizedThreadId)
        .maybeSingle(),
      supabase
        .from('email_messages')
        .select(EMAIL_MESSAGE_SELECT_COLUMNS)
        .eq('thread_id', normalizedThreadId)
        .order('received_at', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true }),
      this.fetchOptionalRows('profiles'),
      this.listAvailableMailboxSenders()
    ])

    if (threadResponse.error) {
      throw new Error(threadResponse.error.message || 'Unable to load the email thread.')
    }

    if (!threadResponse.data) {
      return null
    }

    const userMap = new Map(profileRows.map(mapProfileUser).map((user) => [user.id, user]))
    const mailboxSendersById = new Map(mailboxSenders.map((sender) => [sender.id, sender]))

    return {
      ...mapEmailThreadRow(threadResponse.data),
      messages: (messageResponse.data ?? [])
        .map((row) => mapEmailMessageRow(row, {
          usersById: userMap,
          mailboxSendersById
        }))
        .filter((entry) => entry.id)
    }
  }

  async listLeadEmailMessages(leadId) {
    const normalizedLeadId = normalizeWhitespace(leadId)

    if (!normalizedLeadId) {
      return []
    }

    const supabase = await getSupabase()
    const [messageResponse, profileRows, mailboxSenders] = await Promise.all([
      supabase
        .from('email_messages')
        .select(EMAIL_MESSAGE_SELECT_COLUMNS)
        .eq('lead_id', normalizedLeadId)
        .order('received_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(25),
      this.fetchOptionalRows('profiles'),
      this.listAvailableMailboxSenders()
    ])
    const messageRows = messageResponse.error ? [] : (messageResponse.data ?? [])
    const userMap = new Map(profileRows.map(mapProfileUser).map((user) => [user.id, user]))
    const mailboxSendersById = new Map(mailboxSenders.map((sender) => [sender.id, sender]))

    return messageRows
      .map((row) => mapEmailMessageRow(row, {
        usersById: userMap,
        mailboxSendersById
      }))
      .filter((entry) => entry.id)
      .sort((left, right) => Date.parse(right.receivedAt ?? right.sentAt ?? right.createdAt ?? 0) - Date.parse(left.receivedAt ?? left.sentAt ?? left.createdAt ?? 0))
  }

  async invokeAuthenticatedFunction(functionName, body = {}) {
    const supabase = await getSupabase()
    const config = await getSupabaseConfig()
    const { data: refreshedSessionData, error: refreshError } = await supabase.auth.refreshSession()

    if (refreshError) {
      throw new Error(refreshError.message || 'Unable to refresh your current CRM session.')
    }

    const accessToken = normalizeWhitespace(refreshedSessionData?.session?.access_token)

    if (!accessToken) {
      throw new Error('Your Supabase session expired. Please log out and sign in again, then retry.')
    }

    const { error: userError } = await supabase.auth.getUser(accessToken)

    if (userError) {
      throw new Error(userError.message || 'Your Supabase session is no longer valid. Please sign in again.')
    }

    const response = await fetch(`${config.url}/functions/v1/${encodeURIComponent(functionName)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.key,
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify(body)
    })

    const contentType = String(response.headers.get('content-type') || '').toLowerCase()
    let data = null

    try {
      data = contentType.includes('application/json')
        ? await response.json()
        : await response.text()
    } catch (_parseError) {
      data = null
    }

    if (!response.ok) {
      return {
        data: null,
        error: {
          message: typeof data === 'string' && normalizeWhitespace(data)
            ? normalizeWhitespace(data)
            : normalizeWhitespace(data?.error ?? data?.message) || `Edge Function returned status ${response.status}.`,
          context: {
            status: response.status,
            data
          }
        }
      }
    }

    return {
      data,
      error: null
    }
  }

  async savePersonalMailboxConnection(payload = {}) {
    const config = await getSupabaseConfig()
    const { data, error } = await this.invokeAuthenticatedFunction('crm-save-mailbox', {
      kind: 'personal',
      senderName: normalizeWhitespace(payload.senderName),
      signatureMode: normalizeMailboxSignatureMode(payload.signatureMode),
      signatureTemplate: normalizeMailboxSignatureTemplate(payload.signatureTemplate),
      signatureHtmlOverride: String(payload.signatureHtmlOverride ?? ''),
      signatureText: String(payload.signatureText ?? ''),
      smtpUsername: normalizeWhitespace(payload.smtpUsername),
      smtpPassword: String(payload.smtpPassword ?? '')
    })

    if (error) {
      throw new Error(await describeFunctionInvokeError(error, 'Unable to save your mailbox connection.'))
    }

    if (data?.error) {
      throw new Error(data.error)
    }

    return mapMailboxSenderRow(data?.sender || {}, { storageBaseUrl: config.url })
  }

  async saveSupportMailboxConnection(payload = {}) {
    const config = await getSupabaseConfig()
    const { data, error } = await this.invokeAuthenticatedFunction('crm-save-mailbox', {
      kind: 'support',
      senderEmail: normalizeWhitespace(payload.senderEmail).toLowerCase(),
      senderName: normalizeWhitespace(payload.senderName),
      signatureMode: normalizeMailboxSignatureMode(payload.signatureMode),
      signatureTemplate: normalizeMailboxSignatureTemplate(payload.signatureTemplate),
      signatureHtmlOverride: String(payload.signatureHtmlOverride ?? ''),
      signatureText: String(payload.signatureText ?? ''),
      smtpUsername: normalizeWhitespace(payload.smtpUsername),
      smtpPassword: String(payload.smtpPassword ?? '')
    })

    if (error) {
      throw new Error(await describeFunctionInvokeError(error, 'Unable to save the support mailbox.'))
    }

    if (data?.error) {
      throw new Error(data.error)
    }

    return mapMailboxSenderRow(data?.sender || {}, { storageBaseUrl: config.url })
  }

  async saveCallPreference(callPreference) {
    const { data, error } = await this.invokeAuthenticatedFunction('crm-save-profile-preferences', {
      callPreference: normalizeCallPreference(callPreference)
    })

    if (error) {
      throw new Error(await describeFunctionInvokeError(error, 'Unable to save your calling preference.'))
    }

    if (data?.error) {
      throw new Error(data.error)
    }

    return {
      callPreference: normalizeCallPreference(data?.profile?.callPreference ?? data?.profile?.call_preference ?? callPreference)
    }
  }

  async uploadSignatureHeadshot(mailboxSenderId, file, options = {}) {
    return this.uploadSignatureAsset(mailboxSenderId, 'headshot', file, options)
  }

  async uploadSignatureBanner(mailboxSenderId, file, options = {}) {
    return this.uploadSignatureAsset(mailboxSenderId, 'banner', file, options)
  }

  async uploadSignatureAsset(mailboxSenderId, assetKind, file, options = {}) {
    const normalizedAssetKind = normalizeWhitespace(assetKind).toLowerCase() === 'banner' ? 'banner' : 'headshot'
    const supabase = await getSupabase()
    const config = await getSupabaseConfig()
    const resolvedFile = file instanceof File ? file : null

    if (!resolvedFile) {
      throw new Error('Choose an image file before uploading.')
    }

    if (!/^image\/(png|jpeg|webp|gif)$/i.test(String(resolvedFile.type || ''))) {
      throw new Error('Upload a PNG, JPG, GIF, or WebP image.')
    }

    const normalizedMailboxId = normalizeWhitespace(mailboxSenderId)
    const path = buildSignatureAssetStoragePath({
      mailboxSenderId: normalizedMailboxId,
      senderKind: options.senderKind,
      ownerUserId: options.ownerUserId,
      senderEmail: options.senderEmail,
      assetKind: normalizedAssetKind,
      fileName: resolvedFile.name
    })

    const { error } = await supabase
      .storage
      .from('email-signatures')
      .upload(path, resolvedFile, {
        upsert: true,
        contentType: resolvedFile.type || undefined,
        cacheControl: '3600'
      })

    if (error) {
      throw new Error(error.message || 'Unable to upload the signature image.')
    }

    return {
      path,
      publicUrl: getSignatureAssetPublicUrl(path, config.url)
    }
  }

  async saveCallPreference(callPreference) {
    const { data, error } = await this.invokeAuthenticatedFunction('crm-save-profile-preferences', {
      callPreference: normalizeCallPreference(callPreference)
    })

    if (error) {
      throw new Error(await describeFunctionInvokeError(error, 'Unable to save your calling preference.'))
    }

    if (data?.error) {
      throw new Error(data.error)
    }

    return {
      callPreference: normalizeCallPreference(data?.profile?.callPreference ?? data?.profile?.call_preference ?? callPreference)
    }
  }

  async listEmailTemplates() {
    const supabase = await getSupabase()
    const { data, error } = await supabase
      .from('crm_email_templates')
      .select('id, name, subject, body_text, body_html, updated_at')
      .order('updated_at', { ascending: false })

    if (error) {
      throw new Error(error.message || 'Unable to load email templates.')
    }

    return (data || []).map(mapEmailTemplateRow)
  }

  async saveEmailTemplate({ name, subject = '', bodyText = '', bodyHtml = '' } = {}) {
    const supabase = await getSupabase()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user?.id) {
      throw new Error('Sign in to save templates.')
    }

    const trimmedName = String(name ?? '').trim()

    if (!trimmedName) {
      throw new Error('Enter a template name.')
    }

    const subjectValue = String(subject ?? '')
    const bodyValue = String(bodyText ?? '')
    const bodyHtmlValue = String(bodyHtml ?? '')

    if (subjectValue.length > 160) {
      throw new Error('Subject must be 160 characters or fewer (same as sent email).')
    }

    if (bodyValue.length > 20000) {
      throw new Error('Message is too long for a template.')
    }

    if (bodyHtmlValue.length > 20000) {
      throw new Error('HTML message is too long for a template.')
    }

    const { data: existingRows, error: listError } = await supabase
      .from('crm_email_templates')
      .select('id, name')
      .eq('user_id', user.id)

    if (listError) {
      throw new Error(listError.message || 'Unable to save the template.')
    }

    const lower = trimmedName.toLowerCase()
    const match = (existingRows || []).find((row) => String(row.name || '').trim().toLowerCase() === lower)

    if (match?.id) {
      const { error: updateError } = await supabase
        .from('crm_email_templates')
        .update({
          subject: subjectValue,
          body_text: bodyValue,
          body_html: bodyHtmlValue
        })
        .eq('id', match.id)
        .eq('user_id', user.id)

      if (updateError) {
        throw new Error(updateError.message || 'Unable to update the template.')
      }

      return { id: match.id, updated: true }
    }

    const { data: inserted, error: insertError } = await supabase
      .from('crm_email_templates')
      .insert({
        user_id: user.id,
        name: trimmedName,
        subject: subjectValue,
        body_text: bodyValue,
        body_html: bodyHtmlValue
      })
      .select('id')
      .maybeSingle()

    if (insertError) {
      throw new Error(insertError.message || 'Unable to save the template.')
    }

    return { id: inserted?.id, updated: false }
  }

  async deleteEmailTemplate(templateId = '') {
    const supabase = await getSupabase()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user?.id) {
      throw new Error('Sign in to manage templates.')
    }

    const id = normalizeWhitespace(templateId)

    if (!id) {
      throw new Error('Choose a template to delete.')
    }

    const { error } = await supabase
      .from('crm_email_templates')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)

    if (error) {
      throw new Error(error.message || 'Unable to delete the template.')
    }

    return { ok: true }
  }

  async sendEmail({
    leadId,
    recipientEmail = '',
    recipientEmails = [],
    senderMode = 'personal',
    threadId = '',
    inReplyTo = '',
    references = '',
    subject = '',
    bodyText = '',
    bodyHtml = ''
  } = {}) {
    const normalizedRecipientEmails = dedupeStrings(
      Array.isArray(recipientEmails)
        ? recipientEmails
        : String(recipientEmails || recipientEmail)
          .split(/[,\n;]/)
    )
      .map((value) => normalizeEmail(value))
      .filter(Boolean)

    const { data, error } = await this.invokeAuthenticatedFunction('crm-send-email', {
      leadId: normalizeWhitespace(leadId),
      recipientEmail: normalizeWhitespace(recipientEmail).toLowerCase(),
      recipientEmails: normalizedRecipientEmails,
      senderMode: normalizeWhitespace(senderMode) === 'support' ? 'support' : 'personal',
      threadId: normalizeWhitespace(threadId),
      inReplyTo: normalizeWhitespace(inReplyTo),
      references: normalizeWhitespace(references),
      subject: normalizeWhitespace(subject),
      bodyText: String(bodyText ?? ''),
      bodyHtml: String(bodyHtml ?? '')
    })

    if (error) {
      throw new Error(await describeFunctionInvokeError(error, 'Unable to send the email.'))
    }

    if (data?.error) {
      throw new Error(data.error)
    }

    return {
      ...mapEmailMessageRow(data?.message || {}, {
        usersById: new Map(),
        mailboxSendersById: new Map()
      }),
      loggedToLead: data?.loggedToLead === true,
      warning: normalizeWhitespace(data?.warning)
    }
  }

  async sendLeadEmail(payload = {}) {
    return this.sendEmail(payload)
  }

  async syncEmailMailbox({ mailboxId = '', folders = [], forceFullResync = false } = {}) {
    const normalizedMailboxId = normalizeWhitespace(mailboxId)

    if (!normalizedMailboxId) {
      throw new Error('Choose a mailbox before syncing email.')
    }

    const normalizedFolders = (Array.isArray(folders) ? folders : [folders])
      .map((folder) => normalizeWhitespace(folder).toUpperCase())
      .filter(Boolean)

    const { data, error } = await this.invokeAuthenticatedFunction('crm-sync-email', {
      mailboxId: normalizedMailboxId,
      folders: normalizedFolders.length ? normalizedFolders : ['INBOX', 'SENT'],
      forceFullResync: Boolean(forceFullResync)
    })

    if (error) {
      throw new Error(await describeFunctionInvokeError(error, 'Unable to sync the mailbox.'))
    }

    if (data?.error) {
      throw new Error(data.error)
    }

    return {
      mailboxId: normalizedMailboxId,
      syncedCount: Number(data?.syncedCount) || 0,
      createdCount: Number(data?.createdCount) || 0,
      updatedCount: Number(data?.updatedCount) || 0,
      folders: Array.isArray(data?.folders) ? data.folders : normalizedFolders,
      syncState: Array.isArray(data?.syncState)
        ? data.syncState.map(mapMailboxSyncStateRow)
        : []
    }
  }

  async markEmailThreadRead({ threadId = '', mailboxId = '' } = {}) {
    const normalizedThreadId = normalizeWhitespace(threadId)
    const normalizedMailboxId = normalizeWhitespace(mailboxId)

    if (!normalizedThreadId || !normalizedMailboxId) {
      return
    }

    const supabase = await getSupabase()
    const [{ error: messageError }, { error: threadError }] = await Promise.all([
      supabase
        .from('email_messages')
        .update({ is_read: true })
        .eq('thread_id', normalizedThreadId)
        .eq('sender_mailbox_id', normalizedMailboxId)
        .eq('direction', 'incoming'),
      supabase
        .from('email_threads')
        .update({ unread_count: 0 })
        .eq('id', normalizedThreadId)
        .eq('mailbox_sender_id', normalizedMailboxId)
    ])

    if (messageError) {
      throw new Error(messageError.message || 'Unable to mark the email thread as read.')
    }

    if (threadError) {
      throw new Error(threadError.message || 'Unable to update the email thread.')
    }
  }

  async toggleEmailThreadStar({ threadId = '', mailboxId = '', isStarred = false } = {}) {
    const normalizedThreadId = normalizeWhitespace(threadId)
    const normalizedMailboxId = normalizeWhitespace(mailboxId)

    if (!normalizedThreadId || !normalizedMailboxId) {
      return
    }

    const supabase = await getSupabase()
    const { error } = await supabase
      .from('email_threads')
      .update({ is_starred: isStarred === true })
      .eq('id', normalizedThreadId)
      .eq('mailbox_sender_id', normalizedMailboxId)

    if (error) {
      throw new Error(error.message || 'Unable to update the email thread star.')
    }
  }

  async deleteEmailThread({ threadId = '', mailboxId = '' } = {}) {
    const normalizedThreadId = normalizeWhitespace(threadId)
    const normalizedMailboxId = normalizeWhitespace(mailboxId)

    if (!normalizedThreadId) {
      throw new Error('Choose a thread to delete.')
    }

    const supabase = await getSupabase()

    const { error: messageError } = await supabase
      .from('email_messages')
      .delete()
      .eq('thread_id', normalizedThreadId)
      .eq('sender_mailbox_id', normalizedMailboxId)

    if (messageError) {
      throw new Error(messageError.message || 'Unable to delete the email messages.')
    }

    const { error: threadError } = await supabase
      .from('email_threads')
      .delete()
      .eq('id', normalizedThreadId)
      .eq('mailbox_sender_id', normalizedMailboxId)

    if (threadError) {
      throw new Error(threadError.message || 'Unable to delete the email thread.')
    }
  }

  async listCalendarEvents({ rangeStart = '', rangeEnd = '', visibilityScope = 'visible' } = {}) {
    const normalizedVisibilityScope = normalizeCalendarVisibilityScope(visibilityScope)
    const currentUserId = await this.getAuthenticatedUserId()
    const normalizedRangeStart = normalizeCalendarQueryDateTime(rangeStart)
    const normalizedRangeEnd = normalizeCalendarQueryDateTime(rangeEnd)

    if ((normalizedVisibilityScope === 'mine' || normalizedVisibilityScope === 'shared') && !currentUserId) {
      return []
    }

    if (normalizedVisibilityScope === 'shared') {
      const shareRows = await this.fetchAllOptionalRows('calendar_event_shares', (query) =>
        query.eq('shared_with_user_id', currentUserId)
      )
      const eventIds = dedupeStrings((shareRows ?? []).map((row) => row.event_id))

      if (!eventIds.length) {
        return []
      }

      const eventRows = await this.fetchAllOptionalRowsByIds(
        'calendar_events',
        'id',
        eventIds,
        (query) => {
          let nextQuery = query

          if (normalizedRangeStart) {
            nextQuery = nextQuery.gte('start_at', normalizedRangeStart)
          }

          if (normalizedRangeEnd) {
            nextQuery = nextQuery.lte('start_at', normalizedRangeEnd)
          }

          return nextQuery.order('start_at', { ascending: true, nullsFirst: false })
        },
        CALENDAR_EVENT_SELECT_COLUMNS,
        'Unable to load shared calendar events from Supabase.'
      )

      return this.hydrateCalendarEvents(eventRows)
    }

    const eventRows = await this.fetchAllOptionalRows(
      'calendar_events',
      (query) => {
        let nextQuery = query

        if (normalizedVisibilityScope === 'mine') {
          nextQuery = nextQuery.eq('owner_user_id', currentUserId)
        }

        if (normalizedRangeStart) {
          nextQuery = nextQuery.gte('start_at', normalizedRangeStart)
        }

        if (normalizedRangeEnd) {
          nextQuery = nextQuery.lte('start_at', normalizedRangeEnd)
        }

        return nextQuery.order('start_at', { ascending: true, nullsFirst: false })
      },
      CALENDAR_EVENT_SELECT_COLUMNS,
      'Unable to load calendar events from Supabase.'
    )

    return this.hydrateCalendarEvents(eventRows)
  }

  async listLeadCalendarEvents(leadId) {
    const normalizedLeadId = normalizeWhitespace(leadId)

    if (!normalizedLeadId) {
      return []
    }

    const eventRows = await this.fetchAllOptionalRows(
      'calendar_events',
      (query) => query
        .eq('lead_id', normalizedLeadId)
        .order('start_at', { ascending: true, nullsFirst: false }),
      CALENDAR_EVENT_SELECT_COLUMNS,
      'Unable to load follow-up events for this client.'
    )

    return this.hydrateCalendarEvents(eventRows)
  }

  async getCalendarEventById(eventId) {
    const normalizedEventId = normalizeWhitespace(eventId)

    if (!normalizedEventId) {
      return null
    }

    const eventRows = await this.fetchAllOptionalRows(
      'calendar_events',
      (query) => query.eq('id', normalizedEventId).limit(1),
      CALENDAR_EVENT_SELECT_COLUMNS,
      'Unable to load the calendar event from Supabase.'
    )

    if (!eventRows.length) {
      return null
    }

    const [event] = await this.hydrateCalendarEvents(eventRows)
    return event || null
  }

  async createCalendarEvent(payload) {
    const access = await this.assertActiveCalendarProfileAccess('schedule follow-up events')
    const normalizedEvent = buildCalendarEventPayload(payload, {
      actorUserId: access.userId,
      defaultOwnerUserId: access.userId
    })
    const supabase = await getSupabase()
    const { data, error } = await supabase
      .from('calendar_events')
      .insert({
        lead_id: normalizedEvent.leadId,
        owner_user_id: normalizedEvent.ownerUserId,
        created_by_user_id: normalizedEvent.createdByUserId,
        title: normalizedEvent.title,
        action_text: normalizedEvent.actionText || null,
        notes: normalizedEvent.notes || null,
        start_at: normalizedEvent.startAt,
        end_at: normalizedEvent.endAt || null,
        event_time_zone: normalizedEvent.eventTimeZone,
        status: normalizedEvent.status,
        visibility: normalizedEvent.visibility,
        completed_at: normalizedEvent.completedAt,
        canceled_at: normalizedEvent.canceledAt,
        created_at: normalizedEvent.createdAt,
        updated_at: normalizedEvent.updatedAt
      })
      .select('id')
      .single()

    if (error) {
      throw new Error(describeCalendarWriteError(error))
    }

    const eventId = normalizeWhitespace(data?.id)

    if (!eventId) {
      throw new Error('Supabase did not return the new calendar event id.')
    }

    await this.replaceCalendarEventShares(eventId, normalizedEvent.sharedWithUserIds)
    await this.touchLead(normalizedEvent.leadId, { id: access.userId }, normalizedEvent.updatedAt)
    return this.getCalendarEventById(eventId)
  }

  async updateCalendarEvent(eventId, payload) {
    const normalizedEventId = normalizeWhitespace(eventId)

    if (!normalizedEventId) {
      throw new Error('Choose a calendar event before saving changes.')
    }

    const access = await this.assertActiveCalendarProfileAccess('edit follow-up events')
    const existingEvent = await this.getCalendarEventById(normalizedEventId)

    if (!existingEvent) {
      throw new Error('That follow-up event is no longer available.')
    }

    const normalizedEvent = buildCalendarEventPayload(payload, {
      existingEvent,
      actorUserId: access.userId,
      defaultOwnerUserId: existingEvent.ownerUserId || access.userId
    })
    const supabase = await getSupabase()
    const { error } = await supabase
      .from('calendar_events')
      .update({
        lead_id: normalizedEvent.leadId,
        title: normalizedEvent.title,
        action_text: normalizedEvent.actionText || null,
        notes: normalizedEvent.notes || null,
        start_at: normalizedEvent.startAt,
        end_at: normalizedEvent.endAt || null,
        event_time_zone: normalizedEvent.eventTimeZone,
        status: normalizedEvent.status,
        visibility: normalizedEvent.visibility,
        completed_at: normalizedEvent.completedAt,
        canceled_at: normalizedEvent.canceledAt,
        updated_at: normalizedEvent.updatedAt
      })
      .eq('id', normalizedEventId)

    if (error) {
      throw new Error(describeCalendarWriteError(error))
    }

    await this.replaceCalendarEventShares(normalizedEventId, normalizedEvent.sharedWithUserIds)
    await this.touchLead(normalizedEvent.leadId, { id: access.userId }, normalizedEvent.updatedAt)
    return this.getCalendarEventById(normalizedEventId)
  }

  async updateCalendarEventStatus(eventId, status) {
    const normalizedEventId = normalizeWhitespace(eventId)

    if (!normalizedEventId) {
      throw new Error('Choose a calendar event before updating its status.')
    }

    const access = await this.assertActiveCalendarProfileAccess('update follow-up event status')
    const existingEvent = await this.getCalendarEventById(normalizedEventId)

    if (!existingEvent) {
      throw new Error('That follow-up event is no longer available.')
    }

    const normalizedStatus = normalizeCalendarEventStatus(status)
    const updatedAt = new Date().toISOString()
    const supabase = await getSupabase()
    const { error } = await supabase
      .from('calendar_events')
      .update({
        status: normalizedStatus,
        completed_at: normalizedStatus === 'completed' ? updatedAt : null,
        canceled_at: normalizedStatus === 'canceled' ? updatedAt : null,
        updated_at: updatedAt
      })
      .eq('id', normalizedEventId)

    if (error) {
      throw new Error(describeCalendarWriteError(error))
    }

    await this.touchLead(existingEvent.leadId, { id: access.userId }, updatedAt)
    return this.getCalendarEventById(normalizedEventId)
  }

  async replaceCalendarEventShares(eventId, userIds) {
    const normalizedEventId = normalizeWhitespace(eventId)

    if (!normalizedEventId) {
      throw new Error('Choose a calendar event before updating shares.')
    }

    const access = await this.assertActiveCalendarProfileAccess('manage follow-up sharing')
    const normalizedUserIds = dedupeStrings(Array.isArray(userIds) ? userIds : [userIds])
      .map((value) => normalizeWhitespace(value))
      .filter((value) => value && value !== access.userId)
    const supabase = await getSupabase()
    const { error: deleteError } = await supabase
      .from('calendar_event_shares')
      .delete()
      .eq('event_id', normalizedEventId)

    if (deleteError) {
      throw new Error(describeCalendarWriteError(deleteError))
    }

    if (!normalizedUserIds.length) {
      return []
    }

    const { error } = await supabase
      .from('calendar_event_shares')
      .insert(normalizedUserIds.map((sharedWithUserId) => ({
        event_id: normalizedEventId,
        shared_with_user_id: sharedWithUserId,
        shared_by_user_id: access.userId
      })))

    if (error && !isDuplicateRowError(error)) {
      throw new Error(describeCalendarWriteError(error))
    }

    return normalizedUserIds
  }

  async hydrateCalendarEvents(eventRows = []) {
    const normalizedEventRows = Array.isArray(eventRows) ? eventRows : []

    if (!normalizedEventRows.length) {
      return []
    }

    const eventIds = dedupeStrings(normalizedEventRows.map((row) => row.id))
    const leadIds = dedupeStrings(normalizedEventRows.map((row) => row.lead_id))
    const [profileRows, shareRows, leadRows] = await Promise.all([
      this.fetchOptionalRows('profiles'),
      eventIds.length ? this.fetchAllOptionalRowsByIds('calendar_event_shares', 'event_id', eventIds) : Promise.resolve([]),
      leadIds.length
        ? this.fetchAllOptionalRowsByIds('leads', 'id', leadIds, (query) => query, CALENDAR_LEAD_SELECT_COLUMNS)
        : Promise.resolve([])
    ])

    const usersById = new Map(profileRows.map(mapProfileUser).map((user) => [user.id, user]))
    const sharesByEventId = buildCalendarEventSharesMap(shareRows, usersById)
    const leadsById = buildCalendarLeadSummaryMap(leadRows)

    return normalizedEventRows
      .map((row) => mapCalendarEventRow(row, { usersById, sharesByEventId, leadsById }))
      .filter((event) => Boolean(event.id))
      .sort(sortCalendarEventsByStart)
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

  async fetchLeadRowById(clientId) {
    const normalizedId = String(clientId ?? '').trim()

    if (!normalizedId) {
      return null
    }

    const [leadRow] = await this.fetchLeadRows((query) => query.eq('id', normalizedId).limit(1))
    return leadRow || null
  }

  async tryRecoverLeadStatusUpdate({
    supabase,
    leadId,
    updatePayload,
    client,
    existingLead,
    existingLeadRow
  } = {}) {
    const normalizedLeadId = String(leadId ?? '').trim()

    if (!normalizedLeadId) {
      return false
    }

    const candidatePayloads = buildLeadStatusRecoveryPayloads({
      updatePayload,
      client,
      existingLead,
      existingLeadRow
    })
    const followUpPayload = omitLeadWorkflowFields(updatePayload)

    for (const candidate of candidatePayloads) {
      const { error } = await supabase
        .from('leads')
        .update(candidate)
        .eq('id', normalizedLeadId)

      if (!error) {
        if (Object.keys(followUpPayload).length) {
          const { error: followUpError } = await supabase
            .from('leads')
            .update(followUpPayload)
            .eq('id', normalizedLeadId)

          if (followUpError) {
            if (!isLeadWorkflowConstraintError(followUpError)) {
              throw new Error(describeLeadWriteError(followUpError))
            }

            continue
          }
        }

        return true
      }

      if (!isLeadWorkflowConstraintError(error)) {
        throw new Error(describeLeadWriteError(error))
      }
    }

    return false
  }

  async tryRecoverLeadInsert({
    supabase,
    insertPayload,
    client
  } = {}) {
    const candidatePayloads = buildLeadInsertRecoveryPayloads({
      insertPayload,
      client
    })

    for (const candidate of candidatePayloads) {
      const { data, error } = await supabase
        .from('leads')
        .insert(candidate)
        .select('id')
        .single()

      if (!error) {
        const recoveredLeadId = String(data?.id ?? '').trim()
        if (recoveredLeadId) {
          return recoveredLeadId
        }
      }

      if (!isLeadWorkflowConstraintError(error)) {
        throw new Error(describeLeadWriteError(error))
      }
    }

    return ''
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

  async getAuthenticatedUserId() {
    const supabase = await getSupabase()
    const { data, error } = await supabase.auth.getUser()

    if (error) {
      throw new Error(error.message || 'Unable to verify the signed-in CRM user.')
    }

    return normalizeWhitespace(data?.user?.id)
  }

  async assertActiveCalendarProfileAccess(actionLabel = 'manage calendar events') {
    const supabase = await getSupabase()
    const userId = await this.getAuthenticatedUserId()

    if (!userId) {
      throw new Error('You must be signed in to manage follow-up events.')
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

    if (!isActive) {
      throw new Error(`Only active CRM users can ${actionLabel}.`)
    }

    return {
      userId,
      role,
      isActive
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
    const fieldLabel = formatLeadHistoryFieldLabel(fieldName)
    const oldValue = normalizeLeadHistoryFieldValue(
      fieldName,
      row.old_value ?? row.oldValue ?? row.previous_value ?? row.previousValue,
      usersById
    )
    const newValue = normalizeLeadHistoryFieldValue(
      fieldName,
      row.new_value ?? row.newValue ?? row.nextValue,
      usersById
    )
    const changedAt = row.changed_at ?? row.changedAt ?? row.created_at ?? row.createdAt ?? ''

    if (!leadId) {
      return
    }

    const current = map.get(leadId) || []
    current.push({
      id: String(row.id ?? uid('activity')),
      type: normalizeLeadHistoryType(row.type ?? row.action_type, fieldName),
      fieldName: fieldName || 'unknown',
      fieldLabel,
      oldValue,
      previousValue: oldValue,
      newValue,
      nextValue: newValue,
      message: normalizeWhitespace(row.message ?? buildLeadHistoryMessage(fieldName, oldValue, newValue, fieldLabel)),
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

function buildCalendarLeadSummaryMap(rows = []) {
  return (rows ?? []).reduce((map, row) => {
    const leadId = String(row.id ?? '').trim()
    const firstName = normalizeWhitespace(row.first_name)
    const lastName = normalizeWhitespace(row.last_name)
    const fullName = normalizeWhitespace(row.full_name) || buildFullName(firstName, lastName)
    const phoneKey = normalizePhone(row.phone)

    if (!leadId) {
      return map
    }

    map.set(leadId, {
      id: leadId,
      fullName: fullName || normalizeEmail(row.email) || formatPhone(phoneKey) || 'Unnamed lead',
      email: normalizeEmail(row.email),
      phone: formatPhone(phoneKey) || normalizeWhitespace(row.phone),
      lifecycleType: resolveLeadRowLifecycle(row.lifecycle, []),
      timeZone: normalizeTimeZoneLabel(row.timezone) || normalizeWhitespace(row.timezone) || 'Unknown'
    })
    return map
  }, new Map())
}

function buildCalendarEventSharesMap(rows, usersById = new Map()) {
  const map = new Map()

  ;(rows ?? []).forEach((row) => {
    const eventId = String(row.event_id ?? row.eventId ?? '').trim()
    const sharedWithUserId = normalizeWhitespace(row.shared_with_user_id ?? row.sharedWithUserId)

    if (!eventId || !sharedWithUserId) {
      return
    }

    const current = map.get(eventId) || []
    current.push({
      userId: sharedWithUserId,
      name: normalizeWhitespace(usersById.get(sharedWithUserId)?.name ?? ''),
      email: normalizeWhitespace(usersById.get(sharedWithUserId)?.email ?? ''),
      sharedByUserId: normalizeWhitespace(row.shared_by_user_id ?? row.sharedByUserId),
      createdAt: row.created_at ?? row.createdAt ?? ''
    })
    map.set(eventId, current)
  })

  map.forEach((entries, eventId) => {
    map.set(eventId, entries.sort((left, right) =>
      (left.name || left.email || left.userId).localeCompare(right.name || right.email || right.userId)
    ))
  })

  return map
}

function mapCalendarEventRow(row, { usersById = new Map(), sharesByEventId = new Map(), leadsById = new Map() } = {}) {
  const eventId = String(row.id ?? '').trim()
  const leadId = normalizeWhitespace(row.lead_id ?? row.leadId)
  const ownerUserId = normalizeWhitespace(row.owner_user_id ?? row.ownerUserId)
  const createdByUserId = normalizeWhitespace(row.created_by_user_id ?? row.createdByUserId)
  const leadSummary = leadsById.get(leadId) || null
  const shareEntries = sharesByEventId.get(eventId) || []
  const title = normalizeWhitespace(row.title)

  return {
    id: eventId,
    leadId,
    ownerUserId,
    ownerName: normalizeWhitespace(usersById.get(ownerUserId)?.name ?? ''),
    createdByUserId,
    createdByName: normalizeWhitespace(usersById.get(createdByUserId)?.name ?? ''),
    title: title || buildDefaultCalendarEventTitle(leadSummary?.fullName),
    actionText: normalizeWhitespace(row.action_text ?? row.actionText),
    notes: normalizeNotes(row.notes),
    startAt: row.start_at ?? row.startAt ?? '',
    endAt: row.end_at ?? row.endAt ?? '',
    eventTimeZone: normalizeTimeZoneLabel(row.event_time_zone ?? row.eventTimeZone) || normalizeWhitespace(row.event_time_zone ?? row.eventTimeZone) || 'Unknown',
    status: normalizeCalendarEventStatus(row.status),
    visibility: normalizeCalendarEventVisibility(row.visibility),
    sharedWithUserIds: shareEntries.map((entry) => entry.userId),
    sharedWithUsers: shareEntries,
    createdAt: row.created_at ?? row.createdAt ?? '',
    updatedAt: row.updated_at ?? row.updatedAt ?? '',
    completedAt: row.completed_at ?? row.completedAt ?? '',
    canceledAt: row.canceled_at ?? row.canceledAt ?? '',
    leadName: leadSummary?.fullName || '',
    leadEmail: leadSummary?.email || '',
    leadPhone: leadSummary?.phone || '',
    leadLifecycleType: leadSummary?.lifecycleType || '',
    leadTimeZone: leadSummary?.timeZone || 'Unknown'
  }
}

function sortCalendarEventsByStart(left, right) {
  return (Date.parse(left?.startAt ?? 0) || 0) - (Date.parse(right?.startAt ?? 0) || 0)
}

function normalizeCalendarVisibilityScope(value) {
  const normalized = normalizeWhitespace(value).toLowerCase()

  if (normalized === 'mine') {
    return 'mine'
  }

  if (normalized === 'shared') {
    return 'shared'
  }

  if (normalized === 'all') {
    return 'all'
  }

  return 'visible'
}

function normalizeCalendarEventStatus(value) {
  const normalized = normalizeWhitespace(value).toLowerCase()
  return CALENDAR_EVENT_STATUS_OPTIONS.includes(normalized) ? normalized : 'scheduled'
}

function normalizeCalendarEventVisibility(value) {
  return normalizeWhitespace(value).toLowerCase() === 'shared' ? 'shared' : 'private'
}

function normalizeCalendarQueryDateTime(value) {
  const normalized = normalizeWhitespace(value)

  if (!normalized) {
    return ''
  }

  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function normalizeCalendarEventDateTime(value, label = 'event time') {
  const normalized = normalizeWhitespace(value)

  if (!normalized) {
    return ''
  }

  const date = new Date(normalized)

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Choose a valid ${label}.`)
  }

  return date.toISOString()
}

function buildCalendarEventPayload(payload, { existingEvent = null, actorUserId = '', defaultOwnerUserId = '' } = {}) {
  const now = new Date().toISOString()
  const leadId = normalizeWhitespace(payload?.leadId ?? existingEvent?.leadId)
  const title = normalizeWhitespace(payload?.title ?? existingEvent?.title)
  const startAt = normalizeCalendarEventDateTime(payload?.startAt ?? existingEvent?.startAt, 'start time')
  const rawEndAt = payload && Object.prototype.hasOwnProperty.call(payload, 'endAt')
    ? payload?.endAt
    : existingEvent?.endAt
  const endAt = normalizeCalendarEventDateTime(rawEndAt, 'end time')
  const eventTimeZone = normalizeTimeZoneLabel(payload?.eventTimeZone)
    || normalizeWhitespace(payload?.eventTimeZone)
    || normalizeTimeZoneLabel(existingEvent?.eventTimeZone)
    || normalizeWhitespace(existingEvent?.eventTimeZone)
    || 'Unknown'
  const visibility = normalizeCalendarEventVisibility(payload?.visibility ?? existingEvent?.visibility)
  const requestedShareIds = dedupeStrings(
    Array.isArray(payload?.sharedWithUserIds)
      ? payload.sharedWithUserIds
      : (payload?.sharedWithUserIds ? [payload.sharedWithUserIds] : (existingEvent?.sharedWithUserIds || []))
  )
    .map((value) => normalizeWhitespace(value))
    .filter((value) => value && value !== (existingEvent?.ownerUserId || actorUserId || defaultOwnerUserId))
  const sharedWithUserIds = visibility === 'shared' ? requestedShareIds : []

  if (!leadId) {
    throw new Error('Choose a lead or member before scheduling a follow-up.')
  }

  if (!title) {
    throw new Error('Add a title for the follow-up event.')
  }

  if (!startAt) {
    throw new Error('Choose a valid start time.')
  }

  if (endAt && Date.parse(endAt) < Date.parse(startAt)) {
    throw new Error('The end time must be after the start time.')
  }

  if (visibility === 'shared' && !sharedWithUserIds.length) {
    throw new Error('Choose at least one coworker before sharing this follow-up.')
  }

  return {
    leadId,
    ownerUserId: normalizeWhitespace(existingEvent?.ownerUserId || defaultOwnerUserId || actorUserId),
    createdByUserId: normalizeWhitespace(existingEvent?.createdByUserId || actorUserId || defaultOwnerUserId),
    title,
    actionText: normalizeWhitespace(payload?.actionText ?? existingEvent?.actionText),
    notes: normalizeNotes(payload?.notes ?? existingEvent?.notes),
    startAt,
    endAt,
    eventTimeZone,
    status: normalizeCalendarEventStatus(payload?.status ?? existingEvent?.status),
    visibility,
    sharedWithUserIds,
    completedAt: normalizeCalendarEventStatus(payload?.status ?? existingEvent?.status) === 'completed'
      ? (existingEvent?.completedAt || now)
      : null,
    canceledAt: normalizeCalendarEventStatus(payload?.status ?? existingEvent?.status) === 'canceled'
      ? (existingEvent?.canceledAt || now)
      : null,
    createdAt: existingEvent?.createdAt || now,
    updatedAt: now
  }
}

function buildDefaultCalendarEventTitle(leadName = '') {
  return `Follow-up with ${normalizeWhitespace(leadName) || 'Client'}`
}

async function describeFunctionInvokeError(error, fallbackMessage) {
  const context = error?.context

  if (context) {
    if (typeof context === 'object' && !('clone' in context)) {
      const message = normalizeWhitespace(context?.data?.error ?? context?.data?.message ?? '')

      if (message) {
        return message
      }
    }

    try {
      const payload = await (typeof context.clone === 'function' ? context.clone() : context).json()
      const message = normalizeWhitespace(payload?.error ?? payload?.message ?? '')

      if (message) {
        return message
      }
    } catch (_jsonError) {
      // Ignore JSON parse issues and fall back to text or the error message.
    }

    try {
      const text = normalizeWhitespace(await (typeof context.clone === 'function' ? context.clone() : context).text())

      if (text) {
        return text
      }
    } catch (_textError) {
      // Ignore text parse issues and fall back to the original error message.
    }
  }

  return normalizeWhitespace(error?.message) || fallbackMessage
}

function mapMailboxSenderRow(row, { storageBaseUrl = '' } = {}) {
  const signatureTemplate = normalizeMailboxSignatureTemplate(row.signature_template ?? row.signatureTemplate)

  return {
    id: String(row.id ?? '').trim(),
    kind: normalizeWhitespace(row.kind).toLowerCase() === 'support' ? 'support' : 'personal',
    ownerUserId: normalizeWhitespace(row.owner_user_id ?? row.ownerUserId) || '',
    senderEmail: normalizeWhitespace(row.sender_email ?? row.senderEmail).toLowerCase(),
    senderName: normalizeWhitespace(row.sender_name ?? row.senderName),
    signatureMode: normalizeMailboxSignatureMode(row.signature_mode ?? row.signatureMode),
    signatureTemplate: {
      ...signatureTemplate,
      headshotUrl: getSignatureAssetPublicUrl(signatureTemplate.headshotPath, storageBaseUrl),
      ctaImageUrl: getSignatureAssetPublicUrl(signatureTemplate.ctaImagePath, storageBaseUrl)
    },
    signatureHtmlOverride: String(row.signature_html_override ?? row.signatureHtmlOverride ?? '').trim(),
    signatureText: String(row.signature_text ?? row.signatureText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim(),
    imapInboxFolder: normalizeWhitespace(row.imap_inbox_folder ?? row.imapInboxFolder) || 'INBOX',
    imapSentFolder: normalizeWhitespace(row.imap_sent_folder ?? row.imapSentFolder) || 'Sent',
    isActive: row.is_active !== false && row.isActive !== false,
    lastVerifiedAt: row.last_verified_at ?? row.lastVerifiedAt ?? '',
    createdAt: row.created_at ?? row.createdAt ?? '',
    updatedAt: row.updated_at ?? row.updatedAt ?? ''
  }
}

function normalizeMailboxSignatureMode(value) {
  const normalized = normalizeWhitespace(value).toLowerCase()

  if (normalized === 'template') {
    return 'template'
  }

  if (normalized === 'html_override') {
    return 'html_override'
  }

  return 'plain_text'
}

function normalizeMailboxSignatureTemplate(value) {
  const template = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
  const socialLinks = Array.isArray(template.socialLinks)
    ? template.socialLinks
    : (Array.isArray(template.social_links) ? template.social_links : [])

  return {
    displayName: normalizeWhitespace(template.displayName ?? template.display_name),
    jobTitle: normalizeWhitespace(template.jobTitle ?? template.job_title),
    phone: normalizeWhitespace(template.phone),
    email: normalizeWhitespace(template.email).toLowerCase(),
    websiteUrl: normalizeSignatureHttpUrl(template.websiteUrl ?? template.website_url),
    headshotPath: normalizeSignatureAssetPath(template.headshotPath ?? template.headshot_path),
    socialLinks: normalizeMailboxSignatureSocialLinks(socialLinks),
    ctaImagePath: normalizeSignatureAssetPath(template.ctaImagePath ?? template.cta_image_path),
    ctaHeadline: normalizeWhitespace(template.ctaHeadline ?? template.cta_headline),
    ctaSubtext: normalizeWhitespace(template.ctaSubtext ?? template.cta_subtext),
    ctaUrl: normalizeSignatureHttpUrl(template.ctaUrl ?? template.cta_url),
    disclaimerText: String(template.disclaimerText ?? template.disclaimer_text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  }
}

function normalizeSignatureHttpUrl(value) {
  const normalized = normalizeWhitespace(value)

  if (!normalized) {
    return ''
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)
    ? normalized
    : `https://${normalized.replace(/^\/+/, '')}`

  try {
    const url = new URL(withProtocol)
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : ''
  } catch (_error) {
    return ''
  }
}

function normalizeMailboxSignatureSocialLinks(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => {
      const item = entry && typeof entry === 'object' && !Array.isArray(entry)
        ? entry
        : {}

      return {
        network: normalizeWhitespace(item.network).toLowerCase(),
        url: normalizeWhitespace(item.url),
        label: normalizeWhitespace(item.label)
      }
    })
    .filter((entry) => entry.network && entry.url)
    .slice(0, 4)
}

function normalizeSignatureAssetPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\.\.+/g, '')
}

function buildSignatureAssetStoragePath({
  mailboxSenderId = '',
  senderKind = 'personal',
  ownerUserId = '',
  senderEmail = '',
  assetKind = 'headshot',
  fileName = ''
} = {}) {
  const normalizedMailboxSenderId = normalizeWhitespace(mailboxSenderId)
  const normalizedKind = normalizeWhitespace(senderKind).toLowerCase() === 'support' ? 'support' : 'personal'
  const normalizedOwnerUserId = normalizeWhitespace(ownerUserId) || 'unknown-user'
  const normalizedSenderEmail = normalizeWhitespace(senderEmail).toLowerCase().replace(/[^a-z0-9@._-]+/g, '')
  const fileExtension = inferSignatureAssetExtension(fileName)
  const scope = normalizedMailboxSenderId
    ? `sender-${normalizedMailboxSenderId}`
    : (normalizedKind === 'support'
      ? 'support-shared'
      : `${normalizedOwnerUserId}-${normalizedSenderEmail || 'mailbox'}`)

  return `${normalizedKind}/${scope}/${assetKind}.${fileExtension}`
}

function inferSignatureAssetExtension(fileName = '') {
  const normalizedName = String(fileName ?? '').trim().toLowerCase()

  if (normalizedName.endsWith('.png')) {
    return 'png'
  }

  if (normalizedName.endsWith('.webp')) {
    return 'webp'
  }

  if (normalizedName.endsWith('.gif')) {
    return 'gif'
  }

  return 'jpg'
}

function getSignatureAssetPublicUrl(path = '', baseUrl = '') {
  const normalizedPath = normalizeSignatureAssetPath(path)

  if (!normalizedPath) {
    return ''
  }

  const encodedPath = normalizedPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  const normalizedBaseUrl = normalizeWhitespace(baseUrl)

  if (!normalizedBaseUrl) {
    return ''
  }

  return `${normalizedBaseUrl.replace(/\/$/, '')}/storage/v1/object/public/email-signatures/${encodedPath}`
}

function mapEmailMessageRow(row, { usersById = new Map(), mailboxSendersById = new Map() } = {}) {
  const senderMailboxId = normalizeWhitespace(row.sender_mailbox_id ?? row.senderMailboxId)
  const createdByUserId = normalizeWhitespace(row.created_by_user_id ?? row.createdByUserId)
  const sender = mailboxSendersById.get(senderMailboxId) || null
  const toEmails = normalizeEmailAddressList(row.to_emails ?? row.toEmails)
  const participants = normalizeEmailParticipants(row.participants)
  const toEmail = normalizeWhitespace(row.to_email ?? row.toEmail).toLowerCase() || toEmails[0] || ''
  const status = normalizeWhitespace(row.status) || 'failed'
  const direction = normalizeWhitespace(row.direction) || 'outgoing'

  return {
    id: String(row.id ?? '').trim(),
    leadId: normalizeWhitespace(row.lead_id ?? row.leadId),
    threadId: normalizeWhitespace(row.thread_id ?? row.threadId),
    senderMailboxId,
    senderKind: normalizeWhitespace(row.sender_kind ?? row.senderKind) === 'support' ? 'support' : 'personal',
    senderName: normalizeWhitespace(row.from_name ?? row.fromName ?? sender?.senderName ?? ''),
    senderEmail: normalizeWhitespace(row.from_email ?? row.fromEmail ?? sender?.senderEmail ?? '').toLowerCase(),
    senderDisplayName: normalizeWhitespace(usersById.get(createdByUserId)?.name ?? row.from_name ?? row.fromName ?? sender?.senderName ?? ''),
    createdByUserId,
    createdByName: normalizeWhitespace(usersById.get(createdByUserId)?.name ?? ''),
    toEmail,
    toEmails,
    subject: normalizeWhitespace(row.subject),
    bodyText: String(row.body_text ?? row.bodyText ?? ''),
    bodyHtml: String(row.body_html ?? row.bodyHtml ?? ''),
    provider: normalizeWhitespace(row.provider) || 'smtp',
    providerMessageId: normalizeWhitespace(row.provider_message_id ?? row.providerMessageId),
    status,
    displayStatus: direction === 'incoming' ? 'received' : status,
    errorMessage: normalizeWhitespace(row.error_message ?? row.errorMessage),
    direction,
    folder: normalizeWhitespace(row.folder) || 'Sent',
    isRead: row.is_read !== false && row.isRead !== false,
    isStarred: row.is_starred === true || row.isStarred === true,
    receivedAt: row.received_at ?? row.receivedAt ?? '',
    messageIdHeader: normalizeWhitespace(row.message_id_header ?? row.messageIdHeader),
    inReplyTo: normalizeWhitespace(row.in_reply_to ?? row.inReplyTo),
    referencesHeader: normalizeWhitespace(row.references_header ?? row.referencesHeader),
    snippet: normalizeWhitespace(row.snippet)
      || String(row.body_text ?? row.bodyText ?? '').replace(/\s+/g, ' ').trim().slice(0, 220)
      || String(row.body_html ?? row.bodyHtml ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220),
    participants,
    source: normalizeWhitespace(row.source) || 'crm',
    sentAt: row.sent_at ?? row.sentAt ?? '',
    createdAt: row.created_at ?? row.createdAt ?? '',
    updatedAt: row.updated_at ?? row.updatedAt ?? ''
  }
}

function mapEmailThreadRow(row) {
  const participants = normalizeEmailParticipants(row.participants)
  const lastMessageDirection = normalizeWhitespace(row.last_message_direction ?? row.lastMessageDirection) || 'outgoing'
  const lastMessageStatus = normalizeWhitespace(row.last_message_status ?? row.lastMessageStatus) || 'sent'

  return {
    id: String(row.id ?? '').trim(),
    mailboxSenderId: normalizeWhitespace(row.mailbox_sender_id ?? row.mailboxSenderId),
    leadId: normalizeWhitespace(row.lead_id ?? row.leadId),
    subject: normalizeWhitespace(row.subject) || 'No subject',
    snippet: normalizeWhitespace(row.snippet),
    participants,
    participantSummary: formatEmailParticipantSummary(participants),
    leadSummary: normalizeWhitespace(row.lead_summary ?? row.leadSummary),
    folderPresence: normalizeEmailFolderPresence(row.folder_presence ?? row.folderPresence),
    latestMessageId: normalizeWhitespace(row.latest_message_id ?? row.latestMessageId),
    latestMessageAt: row.latest_message_at ?? row.latestMessageAt ?? '',
    unreadCount: Math.max(0, Number(row.unread_count ?? row.unreadCount) || 0),
    isStarred: row.is_starred === true || row.isStarred === true,
    lastMessageDirection,
    lastMessageStatus,
    lastMessageDisplayStatus: lastMessageDirection === 'incoming' ? 'received' : lastMessageStatus,
    createdAt: row.created_at ?? row.createdAt ?? '',
    updatedAt: row.updated_at ?? row.updatedAt ?? ''
  }
}

function mapMailboxSyncStateRow(row) {
  return {
    mailboxSenderId: normalizeWhitespace(row.mailbox_sender_id ?? row.mailboxSenderId),
    folder: normalizeWhitespace(row.folder).toUpperCase() || 'INBOX',
    lastSyncedAt: row.last_synced_at ?? row.lastSyncedAt ?? '',
    lastUid: Number(row.last_uid ?? row.lastUid) || 0,
    lastError: normalizeWhitespace(row.last_error ?? row.lastError),
    syncStatus: normalizeWhitespace(row.sync_status ?? row.syncStatus) || 'idle',
    syncedMessageCount: Math.max(0, Number(row.synced_message_count ?? row.syncedMessageCount) || 0),
    createdAt: row.created_at ?? row.createdAt ?? '',
    updatedAt: row.updated_at ?? row.updatedAt ?? ''
  }
}

function mapEmailTemplateRow(row) {
  return {
    id: normalizeWhitespace(row.id),
    name: String(row.name ?? ''),
    subject: String(row.subject ?? ''),
    bodyText: String(row.body_text ?? row.bodyText ?? ''),
    bodyHtml: String(row.body_html ?? row.bodyHtml ?? ''),
    updatedAt: row.updated_at ?? row.updatedAt ?? ''
  }
}

function buildLeadEmailHistoryMap(rows, usersById = new Map(), mailboxSendersById = new Map()) {
  const map = new Map()

  ;(rows ?? []).forEach((row) => {
    const leadId = normalizeWhitespace(row.lead_id ?? row.leadId)

    if (!leadId) {
      return
    }

    const current = map.get(leadId) || []
    current.push(mapEmailMessageRow(row, {
      usersById,
      mailboxSendersById
    }))
    map.set(leadId, current)
  })

  map.forEach((entries, leadId) => {
    map.set(leadId, entries.sort((left, right) => Date.parse(right.receivedAt ?? right.sentAt ?? right.createdAt ?? 0) - Date.parse(left.receivedAt ?? left.sentAt ?? left.createdAt ?? 0)))
  })

  return map
}

function normalizeEmailAddressList(value) {
  if (Array.isArray(value)) {
    return dedupeStrings(value.map((entry) => normalizeEmail(entry)).filter(Boolean))
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) {
        return dedupeStrings(parsed.map((entry) => normalizeEmail(entry)).filter(Boolean))
      }
    } catch (_error) {
      return dedupeStrings(value.split(/[,\n;]/).map((entry) => normalizeEmail(entry)).filter(Boolean))
    }
  }

  return []
}

function normalizeEmailParticipants(value) {
  const rawEntries = Array.isArray(value)
    ? value
    : (() => {
      if (typeof value !== 'string') {
        return []
      }

      try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : []
      } catch (_error) {
        return []
      }
    })()

  return rawEntries
    .map((entry) => ({
      email: normalizeEmail(entry?.email),
      name: normalizeWhitespace(entry?.name),
      role: normalizeWhitespace(entry?.role).toLowerCase() === 'from' ? 'from' : 'to'
    }))
    .filter((entry) => entry.email)
}

function formatEmailParticipantSummary(participants = []) {
  const labels = dedupeStrings(
    (Array.isArray(participants) ? participants : [])
      .map((participant) => normalizeWhitespace(participant?.name) || normalizeWhitespace(participant?.email))
      .filter(Boolean)
  )

  if (!labels.length) {
    return 'Unknown sender'
  }

  if (labels.length === 1) {
    return labels[0]
  }

  return `${labels[0]} +${labels.length - 1}`
}

function normalizeEmailFolderPresence(value) {
  const folders = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',') : [])

  return dedupeStrings(folders.map((folder) => normalizeWhitespace(folder).toUpperCase()).filter(Boolean))
}

function mapLeadRow(row, { usersById, tagsByLeadId, notesByLeadId, historyByLeadId, emailHistoryByLeadId = new Map(), dispositionDefinitions = [] }) {
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
  const emailHistory = emailHistoryByLeadId.get(leadId) || []
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
    activityLog,
    emailHistory
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
    status: serializeLeadStatus(client.status),
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
    status: serializeLeadStatus(client.status),
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

function shouldPreserveStoredLeadStatus({ payload, client, existingLead, existingLeadRow } = {}) {
  if (!existingLead || !existingLeadRow) {
    return false
  }

  const payloadIncludesStatus = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'status'))
  const nextStatus = normalizeStatus(payload?.status ?? client?.status)
  const displayedStatus = normalizeStatus(existingLead.status)
  const storedStatusRaw = normalizeWhitespace(existingLeadRow.status)
  const serializedNextStatus = normalizeWhitespace(serializeStatusForStorage(client?.status ?? payload?.status))

  if (!storedStatusRaw) {
    return false
  }

  if (payloadIncludesStatus && displayedStatus && nextStatus !== displayedStatus) {
    return false
  }

  if (normalizeWhitespace(storedStatusRaw).toLowerCase() === serializedNextStatus.toLowerCase()) {
    return false
  }

  return true
}

function applyStoredStatusFilter(query, status) {
  const normalizedStatus = normalizeStatus(status)
  const statusVariants = dedupeStrings([
    serializeStatusForStorage(normalizedStatus),
    normalizedStatus,
    ...getLeadStatusRecoveryVariants(normalizedStatus)
  ])

  if (!statusVariants.length) {
    return query
  }

  if (statusVariants.length === 1) {
    return query.eq('status', statusVariants[0])
  }

  return query.in('status', statusVariants)
}

function buildLeadStatusRecoveryPayloads({ updatePayload, client, existingLead, existingLeadRow } = {}) {
  const normalizedStatus = normalizeStatus(client?.status ?? updatePayload?.status)
  const normalizedLifecycle = normalizeLifecycle(client?.lifecycleType ?? updatePayload?.lifecycle)
  const existingRawStatus = normalizeWhitespace(existingLeadRow?.status)
  const existingRawLifecycle = normalizeWhitespace(existingLeadRow?.lifecycle)
  const desiredStatus = normalizeWhitespace(updatePayload?.status)
  const desiredLifecycle = normalizeWhitespace(updatePayload?.lifecycle) || normalizedLifecycle
  const preferredStatus = serializeLeadStatus(normalizedStatus)
  const basePayload = {
    updated_at: updatePayload?.updated_at ?? new Date().toISOString()
  }
  const preferredLifecycle = normalizedStatus === 'won' || normalizedLifecycle === 'member'
    ? 'member'
    : 'lead'
  const statusVariants = dedupeStrings([
    desiredStatus,
    existingRawStatus,
    preferredStatus,
    serializeStatusForStorage(normalizedStatus),
    normalizedStatus,
    ...getLeadStatusRecoveryVariants(normalizedStatus)
  ])
  const lifecycleVariants = dedupeStrings([
    desiredLifecycle,
    existingRawLifecycle,
    normalizeLifecycle(existingLead?.lifecycleType),
    preferredLifecycle,
    'lead',
    'member'
  ])
  const candidates = []

  const addCandidate = (status, lifecycle) => {
    const normalizedCandidateStatus = normalizeWhitespace(status)
    const normalizedCandidateLifecycle = normalizeWhitespace(lifecycle)

    if (!normalizedCandidateStatus || !normalizedCandidateLifecycle) {
      return
    }

    candidates.push({
      ...basePayload,
      status: normalizedCandidateStatus,
      lifecycle: normalizedCandidateLifecycle
    })
  }

  addCandidate(desiredStatus || preferredStatus, desiredLifecycle)

  if (existingRawStatus) {
    addCandidate(existingRawStatus, desiredLifecycle)
  }

  statusVariants.forEach((statusVariant) => {
    addCandidate(statusVariant, preferredLifecycle)
    addCandidate(statusVariant, desiredLifecycle)
    lifecycleVariants.forEach((lifecycleVariant) => addCandidate(statusVariant, lifecycleVariant))
  })

  const seen = new Set()

  return candidates.filter((candidate) => {
    const key = JSON.stringify({
      status: candidate.status ?? null,
      lifecycle: candidate.lifecycle ?? null
    })

    if (seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function buildLeadInsertRecoveryPayloads({ insertPayload, client } = {}) {
  const basePayload = {
    ...(insertPayload && typeof insertPayload === 'object' ? insertPayload : {})
  }
  const candidateWorkflowPayloads = buildLeadStatusRecoveryPayloads({
    updatePayload: {
      status: insertPayload?.status,
      lifecycle: insertPayload?.lifecycle,
      updated_at: insertPayload?.updated_at,
      created_at: insertPayload?.created_at
    },
    client,
    existingLead: null,
    existingLeadRow: null
  })

  const workflowCandidates = candidateWorkflowPayloads.map((candidate) => ({
    ...basePayload,
    status: candidate.status,
    lifecycle: candidate.lifecycle,
    updated_at: candidate.updated_at ?? basePayload.updated_at
  }))

  // Let the live table default the workflow columns if a legacy check
  // constraint still rejects every explicit status candidate.
  const defaultBackedCandidates = [
    omitLeadWorkflowFields(basePayload),
    (() => {
      const nextPayload = { ...basePayload }
      delete nextPayload.status
      return nextPayload
    })()
  ]

  return dedupeLeadWritePayloads([
    ...workflowCandidates,
    ...defaultBackedCandidates
  ])
}

function omitLeadWorkflowFields(updatePayload = {}) {
  const nextPayload = { ...updatePayload }
  delete nextPayload.status
  delete nextPayload.lifecycle
  return nextPayload
}

function isLeadWorkflowConstraintError(error) {
  const message = normalizeWhitespace(error?.message || '').toLowerCase()
  const details = normalizeWhitespace(error?.details || '').toLowerCase()
  const hint = normalizeWhitespace(error?.hint || '').toLowerCase()
  const haystack = `${message} ${details} ${hint}`

  if (haystack.includes('leads_status_check') || haystack.includes('leads_lifecycle')) {
    return true
  }

  if (haystack.includes('violates check constraint') && (haystack.includes('status') || haystack.includes('lifecycle'))) {
    return true
  }

  if (haystack.includes('invalid input value for enum') && (haystack.includes('status') || haystack.includes('lifecycle'))) {
    return true
  }

  return false
}

function describeLeadWriteError(error) {
  const message = normalizeWhitespace(error?.message || '')

  if (message.toLowerCase().includes('leads_status_check')) {
    return 'This lead has a status value the database will not accept right now. The CRM retried the legacy write variants automatically, but the live leads.status constraint still rejected them.'
  }

  if (message.toLowerCase().includes('row-level security policy') && message.toLowerCase().includes('table "leads"')) {
    return 'Supabase blocked this lead save because the CRM lead write policy is missing. Run the latest CRM lead RLS migration, then try saving again.'
  }

  const hint = normalizeWhitespace(error?.hint || '')

  return [message, hint].filter(Boolean).join(' ') || 'Unable to save the lead to Supabase.'
}

function describeCalendarWriteError(error) {
  if (isMissingRelationError(error)) {
    return 'Run the CRM calendar migration in Supabase before scheduling follow-ups.'
  }

  return normalizeWhitespace(error?.message) || 'Unable to save the calendar event to Supabase.'
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

function formatLeadHistoryFieldLabel(fieldName) {
  const normalizedFieldName = normalizeLeadHistoryFieldName(fieldName)
  const key = normalizeWhitespace(normalizedFieldName).toLowerCase()

  if (key === 'assigned_rep_id' || key === 'assigned_to') {
    return 'Assigned Rep'
  }

  if (key === 'timezone' || key === 'time_zone') {
    return 'Time Zone'
  }

  if (!normalizedFieldName) {
    return 'Unknown Field'
  }

  return normalizedFieldName
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => {
      if (!word) {
        return ''
      }

      if (word.toLowerCase() === 'id') {
        return 'ID'
      }

      return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`
    })
    .join(' ')
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

function normalizeLeadHistoryFieldValue(fieldName, value, usersById = new Map()) {
  const normalizedFieldName = normalizeLeadHistoryFieldName(fieldName)
  const normalizedValue = normalizeLeadHistoryValue(value)
  const rawValue = normalizeWhitespace(value)

  if (normalizedFieldName === 'status') {
    return serializeLeadStatus(normalizeStatus(normalizedValue))
  }

  if (normalizedFieldName === 'lifecycle') {
    return normalizeLifecycle(normalizedValue)
  }

  if (normalizedFieldName === 'assigned_rep_id' || normalizedFieldName === 'assigned_to') {
    if (!rawValue || normalizedValue === '—') {
      return 'Unassigned'
    }

    return normalizeWhitespace(usersById.get(rawValue)?.name ?? normalizedValue) || 'Unassigned'
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

function buildLeadHistoryMessage(fieldName, oldValue, newValue, fieldLabel = formatLeadHistoryFieldLabel(fieldName)) {
  const normalizedFieldLabel = fieldLabel || 'Field'
  return `${normalizedFieldLabel} changed from ${oldValue} to ${newValue}.`
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
    groups.push(buildTimeZoneFilterConditions(timeZones))
  }

  const areaCodes = normalizeAreaCodeFilterValues(filters?.multi?.areaCodes)
  if (areaCodes.length) {
    groups.push(dedupeStrings(areaCodes.flatMap((value) => buildPhoneAreaCodeConditions('phone', value))))
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

function buildPhoneAreaCodeConditions(column, value) {
  const digits = String(value ?? '').replace(/\D/g, '').slice(0, 3)

  if (digits.length !== 3) {
    return []
  }

  const patterns = dedupeStrings([
    `${digits}*`,
    `(${digits})*`,
    `${digits} *`,
    `${digits}-*`,
    `${digits}.*`,
    `1${digits}*`,
    `1 ${digits}*`,
    `1-${digits}*`,
    `1.${digits}*`,
    `1(${digits})*`,
    `1 (${digits})*`,
    `+1${digits}*`,
    `+1 ${digits}*`,
    `+1-${digits}*`,
    `+1.${digits}*`,
    `+1(${digits})*`,
    `+1 (${digits})*`
  ])

  return patterns.map((pattern) => `${column}.ilike.${pattern}`)
}

function buildTimeZoneFilterConditions(values = []) {
  return dedupeStrings(values.flatMap((value) => {
    const canonicalTimeZone = normalizeTimeZoneLabel(value) || sanitizePostgrestValue(value)

    if (!canonicalTimeZone) {
      return []
    }

    if (canonicalTimeZone.toLowerCase() === 'unknown') {
      return [
        buildIlikeCondition('timezone', canonicalTimeZone),
        'timezone.is.null'
      ]
    }

    const conditions = [
      `and(timezone_overridden.is.true,${buildIlikeCondition('timezone', canonicalTimeZone)})`
    ]
    const areaCodes = TIME_ZONE_FILTER_AREA_CODES[canonicalTimeZone.toLowerCase()] || []
    const phoneConditions = dedupeStrings(areaCodes.flatMap((areaCode) => buildPhoneAreaCodeConditions('phone', areaCode)))

    if (phoneConditions.length) {
      conditions.push(`and(or(timezone_overridden.is.false,timezone_overridden.is.null),or(${phoneConditions.join(',')}))`)
    }

    conditions.push(`and(or(timezone_overridden.is.false,timezone_overridden.is.null),phone.is.null,${buildIlikeCondition('timezone', canonicalTimeZone)})`)

    return conditions.filter(Boolean)
  }))
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

  if (!normalized) {
    return 'new'
  }

  if (normalized.includes('qual')) {
    return 'qualified'
  }

  if (normalized.includes('contact')) {
    return 'contacted'
  }

  if (normalized.includes('inactive') || normalized.includes('lost')) {
    return 'inactive'
  }

  if (normalized.includes('won') || normalized === 'member') {
    return 'won'
  }

  return CRM_STATUS_OPTIONS.includes(normalized) ? normalized : 'new'
}

function serializeStatusForStorage(value) {
  const normalizedStatus = normalizeStatus(value)

  if (normalizedStatus === 'inactive') {
    return 'lost'
  }

  return normalizedStatus
}

function getLeadStatusRecoveryVariants(normalizedStatus) {
  switch (normalizeStatus(normalizedStatus)) {
    case 'contacted':
      return ['contacted', 'Contacted', 'CONTACTED']
    case 'qualified':
      return ['qualified', 'Qualified', 'QUALIFIED']
    case 'won':
      return ['won', 'WON', 'Won', 'member', 'Member', 'MEMBER']
    case 'inactive':
      return ['lost', 'inactive', 'Inactive', 'Lost', 'INACTIVE']
    case 'new':
    default:
      return ['new', 'New', 'NEW']
  }
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

function isMissingRelationError(error) {
  const code = normalizeWhitespace(error?.code)
  const message = normalizeWhitespace(error?.message).toLowerCase()
  return code === '42P01' || message.includes('does not exist')
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

function dedupeLeadWritePayloads(payloads = []) {
  const seen = new Set()

  return payloads.filter((payload) => {
    const key = JSON.stringify({
      status: Object.prototype.hasOwnProperty.call(payload, 'status') ? payload.status : '__omitted__',
      lifecycle: Object.prototype.hasOwnProperty.call(payload, 'lifecycle') ? payload.lifecycle : '__omitted__',
      assignedRepId: Object.prototype.hasOwnProperty.call(payload, 'assigned_rep_id') ? payload.assigned_rep_id : '__omitted__'
    })

    if (seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
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

  if (role === 'support') {
    return 'support'
  }

  if (role === 'senior_rep') {
    return 'senior'
  }

  return 'sales'
}

function normalizeCallPreference(value) {
  return normalizeWhitespace(value).toLowerCase() === 'google_voice'
    ? 'google_voice'
    : 'system_default'
}
