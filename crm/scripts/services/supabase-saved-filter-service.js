import { getSupabase } from '../../../src/lib/supabase-browser.js'

export class SupabaseSavedFilterService {
  async listVisible(session) {
    if (!session) {
      return []
    }

    const supabase = await getSupabase()
    const { data, error } = await supabase
      .from('saved_filters')
      .select('*')
      .order('updated_at', { ascending: false })

    if (error) {
      throw new Error(error.message || 'Unable to load saved filters from Supabase.')
    }

    const filters = await this.hydrateCreatorNames((data ?? []).map(mapSavedFilterRow))

    if (session.role === 'admin') {
      return filters
    }

    return filters.filter((filter) => filter.visibility === 'shared' || filter.createdByUserId === session.id)
  }

  async saveFilter(session, payload) {
    if (!session) {
      throw new Error('You must be logged in to save a filter.')
    }

    const existing = payload.id ? await this.getFilterRow(payload.id) : null

    if (existing && session.role !== 'admin' && String(existing.created_by ?? '').trim() !== session.id) {
      throw new Error('You can only update your own saved filters.')
    }

    const now = new Date().toISOString()
    const record = {
      name: String(payload.name ?? '').trim(),
      created_by: String(existing?.created_by ?? session.id).trim(),
      visibility: payload.visibility === 'shared' ? 'shared' : 'private',
      filter_payload: payload.filterPayload,
      created_at: existing?.created_at ?? now,
      updated_at: now
    }

    if (!record.name) {
      throw new Error('Saved filters need a name.')
    }

    const supabase = await getSupabase()
    let data = null
    let error = null

    if (existing) {
      ;({ data, error } = await supabase
        .from('saved_filters')
        .update(record)
        .eq('id', existing.id)
        .select('*')
        .single())
    } else {
      ;({ data, error } = await supabase
        .from('saved_filters')
        .insert(record)
        .select('*')
        .single())
    }

    if (error) {
      throw new Error(error.message || 'Unable to save the filter to Supabase.')
    }

    return this.hydrateSingleCreatorName(mapSavedFilterRow(data))
  }

  async deleteFilter(session, filterId) {
    const existing = await this.getFilterRow(filterId)

    if (!existing) {
      return
    }

    if (session?.role !== 'admin' && String(existing.created_by ?? '').trim() !== session?.id) {
      throw new Error('You can only delete your own saved filters.')
    }

    const supabase = await getSupabase()
    const { error } = await supabase
      .from('saved_filters')
      .delete()
      .eq('id', filterId)

    if (error) {
      throw new Error(error.message || 'Unable to delete the saved filter.')
    }
  }

  async getFilterRow(filterId) {
    if (!filterId) {
      return null
    }

    const supabase = await getSupabase()
    const { data, error } = await supabase
      .from('saved_filters')
      .select('*')
      .eq('id', filterId)
      .maybeSingle()

    if (error) {
      throw new Error(error.message || 'Unable to load the saved filter.')
    }

    return data ?? null
  }

  async hydrateCreatorNames(filters) {
    const creatorIds = [...new Set((filters ?? []).map((filter) => filter.createdByUserId).filter(Boolean))]

    if (!creatorIds.length) {
      return filters
    }

    try {
      const supabase = await getSupabase()
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', creatorIds)

      if (error) {
        return filters
      }

      const namesById = new Map((data ?? []).map((row) => [
        String(row.id ?? '').trim(),
        String(row.full_name ?? row.email ?? '').trim()
      ]))

      return filters.map((filter) => ({
        ...filter,
        createdByName: namesById.get(filter.createdByUserId) || filter.createdByName || filter.createdByUserId || 'CRM user'
      }))
    } catch (_error) {
      return filters
    }
  }

  async hydrateSingleCreatorName(filter) {
    const [hydratedFilter] = await this.hydrateCreatorNames([filter])
    return hydratedFilter || filter
  }
}

function mapSavedFilterRow(row) {
  return {
    id: String(row.id ?? '').trim(),
    name: row.name,
    createdByUserId: String(row.created_by ?? row.createdByUserId ?? '').trim(),
    createdByName: row.createdByName ?? '',
    visibility: row.visibility === 'shared' ? 'shared' : 'private',
    filterPayload: row.filter_payload ?? row.filterPayload ?? {},
    createdAt: row.created_at ?? row.createdAt ?? '',
    updatedAt: row.updated_at ?? row.updatedAt ?? ''
  }
}
