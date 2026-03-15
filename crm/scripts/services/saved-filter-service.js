const SAVED_FILTERS_KEY = 'bluechip_crm_saved_filters_v1';

export class SavedFilterService {
    listAll() {
        try {
            const raw = localStorage.getItem(SAVED_FILTERS_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (_error) {
            return [];
        }
    }

    listVisible(session) {
        const filters = this.listAll();

        if (!session) {
            return [];
        }

        if (session.role === 'admin') {
            return filters.sort(sortByUpdatedAtDesc);
        }

        return filters
            .filter((filter) => filter.visibility === 'shared' || filter.createdByUserId === session.id)
            .sort(sortByUpdatedAtDesc);
    }

    saveFilter(session, payload) {
        if (!session) {
            throw new Error('You must be logged in to save a filter.');
        }

        const filters = this.listAll();
        const now = new Date().toISOString();
        const existing = payload.id ? filters.find((filter) => filter.id === payload.id) : null;

        if (existing && session.role !== 'admin' && existing.createdByUserId !== session.id) {
            throw new Error('You can only update your own saved filters.');
        }

        const nextFilter = {
            id: existing?.id ?? `crm-filter-${crypto.randomUUID()}`,
            name: String(payload.name ?? '').trim(),
            createdByUserId: existing?.createdByUserId ?? session.id,
            createdByName: existing?.createdByName ?? session.name,
            visibility: payload.visibility === 'shared' ? 'shared' : 'private',
            filterPayload: payload.filterPayload,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now
        };

        if (!nextFilter.name) {
            throw new Error('Saved filters need a name.');
        }

        const nextFilters = existing
            ? filters.map((filter) => (filter.id === nextFilter.id ? nextFilter : filter))
            : [...filters, nextFilter];

        localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(nextFilters));
        return nextFilter;
    }

    deleteFilter(session, filterId) {
        const filters = this.listAll();
        const existing = filters.find((filter) => filter.id === filterId);

        if (!existing) {
            return;
        }

        if (session?.role !== 'admin' && existing.createdByUserId !== session?.id) {
            throw new Error('You can only delete your own saved filters.');
        }

        const nextFilters = filters.filter((filter) => filter.id !== filterId);
        localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(nextFilters));
    }
}

function sortByUpdatedAtDesc(left, right) {
    return Date.parse(right.updatedAt ?? 0) - Date.parse(left.updatedAt ?? 0);
}
