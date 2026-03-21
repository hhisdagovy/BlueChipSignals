import { buildAutoMapping, parseCsvText } from './import/csv-utils.js';
import {
    CRM_STATUS_OPTIONS,
    CRM_TIME_ZONE_OPTIONS,
    getImportFieldDefinitions
} from './services/crm-data-service.js';
import { SupabaseAuthService } from './services/supabase-auth-service.js';
import { SupabaseCrmDataService } from './services/supabase-crm-data-service.js';
import {
    PERMISSIONS,
    canEditLeadField,
    canEditNoteEntry,
    canEnterLeadEditMode,
    canManageSavedFilter as canManageSavedFilterForSession,
    hasPermission,
    isAdminSession,
    isSalesWorkspaceSession,
    isSeniorRepSession
} from './services/permissions.js';
import { SupabaseSavedFilterService } from './services/supabase-saved-filter-service.js';
import {
    dedupeStrings,
    downloadTextFile,
    escapeHtml,
    extractAreaCode,
    formatDate,
    formatDateTime,
    isToday,
    normalizePhone,
    parseAreaCodes,
    parseMultiValueList,
    parseTags,
    normalizeWhitespace,
    titleCase,
    truncate
} from './utils/formatters.js';

const authService = new SupabaseAuthService();
const dataService = new SupabaseCrmDataService();
const savedFilterService = new SupabaseSavedFilterService();
const importFields = getImportFieldDefinitions();
const ADVANCED_SUBSCRIPTION_TYPE_FILTER_OPTIONS = ['Single channel', 'Full Bundle'];

const refs = {
    authGate: document.getElementById('auth-gate'),
    shell: document.getElementById('crm-shell'),
    sidebar: document.getElementById('crm-sidebar'),
    topbar: document.getElementById('crm-topbar'),
    overviewPanel: document.getElementById('crm-overview-panel'),
    calendarPanel: document.getElementById('crm-calendar-panel'),
    emailPanel: document.getElementById('crm-email-panel'),
    clientsPanel: document.getElementById('crm-clients-panel'),
    membersPanel: document.getElementById('crm-members-panel'),
    adminPanel: document.getElementById('crm-admin-panel'),
    leadDetailPanel: document.getElementById('crm-lead-detail-panel'),
    importsPanel: document.getElementById('crm-imports-panel'),
    settingsPanel: document.getElementById('crm-settings-panel'),
    drawer: document.getElementById('crm-drawer'),
    modalLayer: document.getElementById('crm-modal-layer')
};

const MULTI_FILTER_CONFIG = [
    {
        key: 'areaCodes',
        label: 'Area code',
        placeholder: '305, 786, 212',
        hint: 'Type or paste comma/newline separated area codes.',
        parser: parseAreaCodes
    },
    {
        key: 'firstNames',
        label: 'First name',
        placeholder: 'John, Bill, Bob',
        hint: 'Matches normalized first names using OR logic within the group.',
        parser: parseMultiValueList
    },
    {
        key: 'lastNames',
        label: 'Last name',
        placeholder: 'Smith, Patel, Grant',
        hint: 'Matches normalized last names using OR logic within the group.',
        parser: parseMultiValueList
    },
    {
        key: 'subscriptionTypes',
        label: 'Subscription type',
        hint: 'Choose one of the supported subscription bundles.',
        parser: parseMultiValueList,
        control: 'select',
        options: ADVANCED_SUBSCRIPTION_TYPE_FILTER_OPTIONS
    },
    {
        key: 'timeZones',
        label: 'Time zone',
        hint: 'Choose from the supported CRM time zone labels.',
        parser: parseMultiValueList,
        control: 'select',
        options: CRM_TIME_ZONE_OPTIONS
    }
];

const MULTI_FILTER_LOOKUP = Object.fromEntries(MULTI_FILTER_CONFIG.map((config) => [config.key, config]));
const DEFAULT_MULTI_FILTER_SECTION_KEY = MULTI_FILTER_CONFIG[0]?.key || 'savedViews';
const WORKSPACE_UI_STATE_STORAGE_KEY = 'crm:workspace-ui-state';
const WORKSPACE_PAGE_CACHE_TTL_MS = 2 * 60 * 1000;
const WORKSPACE_PAGE_CACHE_MAX_ENTRIES = 24;
const SEARCH_SUGGESTION_DEBOUNCE_MS = 180;
const WORKSPACE_VIEWS = new Set(['overview', 'calendar', 'email', 'clients', 'assigned-leads', 'members', 'admin', 'lead-detail', 'imports', 'settings']);
const WORKSPACE_PAGE_SIZES = [25, 50, 100, 250];
const CALENDAR_EVENT_STATUS_OPTIONS = ['scheduled', 'completed', 'canceled', 'missed'];
const CALENDAR_EVENT_VISIBILITY_OPTIONS = ['private', 'shared'];
const CALENDAR_DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ADMIN_TABS = Object.freeze([
    { id: 'team', icon: 'fa-users', label: 'Team' },
    { id: 'tags', icon: 'fa-tags', label: 'Tags' },
    { id: 'dispositions', icon: 'fa-list-check', label: 'Dispositions' },
    { id: 'activity', icon: 'fa-chart-column', label: 'Activity' },
    { id: 'imports', icon: 'fa-file-arrow-up', label: 'Imports' }
]);
const CALL_PREFERENCE_OPTIONS = Object.freeze([
    { value: 'system_default', label: 'System default' },
    { value: 'google_voice', label: 'Google Voice' }
]);
const GOOGLE_VOICE_HELP_URL = 'https://support.google.com/voice/answer/3379129?hl=en';
const GOOGLE_VOICE_WEB_CALL_BASE_URL = 'https://voice.google.com/u/0/calls?a=nc,';
const visibleClientsCache = {
    clientsRef: null,
    filtersKey: '',
    sortKey: '',
    result: []
};
const workspacePageCache = new Map();

function createDefaultMultiFilters() {
    return {
        areaCodes: [],
        firstNames: [],
        lastNames: [],
        subscriptionTypes: [],
        timeZones: []
    };
}

function createDefaultFilterAccordionState() {
    return Object.fromEntries([
        ...MULTI_FILTER_CONFIG.map((config) => [config.key, false]),
        ['savedViews', false]
    ]);
}

function createDefaultFilters() {
    return {
        status: 'all',
        tag: 'all',
        multi: createDefaultMultiFilters()
    };
}

function createEmptyWorkspaceResult() {
    return {
        rows: [],
        totalCount: 0,
        isLoading: false,
        loaded: false,
        requestId: 0,
        cacheKey: ''
    };
}

function createEmptyWorkspaceSummary() {
    return {
        leadCount: 0,
        memberCount: 0
    };
}

function createDefaultCalendarClientPickerState() {
    return {
        query: '',
        selectedLeadId: '',
        selectedLeadName: '',
        selectedLeadMeta: '',
        suggestions: [],
        isOpen: false,
        isLoading: false,
        activeIndex: -1,
        lastQuery: ''
    };
}

function createDefaultCalendarState() {
    return {
        monthCursor: getMonthCursorValue(new Date()),
        selectedDate: getDateKey(new Date()),
        view: 'week',
        filter: 'mine',
        events: [],
        leadEventsByLeadId: {},
        isLoading: false,
        rangeStart: '',
        rangeEnd: '',
        clientPicker: createDefaultCalendarClientPickerState(),
        formDraft: null
    };
}

function createDefaultEmailComposerState() {
    return {
        leadId: '',
        threadId: '',
        inReplyTo: '',
        references: '',
        composeMode: 'new',
        recipientEmail: '',
        recipientName: '',
        senderMode: 'personal',
        subject: '',
        bodyText: ''
    };
}

function createDefaultEmailWorkspaceState() {
    return {
        initialized: false,
        isLoading: false,
        isSyncing: false,
        selectedMailboxId: '',
        selectedFolder: 'INBOX',
        selectedThreadId: '',
        selectedThread: null,
        threads: [],
        mailboxes: [],
        searchQuery: '',
        previewMode: 'thread',
        syncStatus: []
    };
}

function createDefaultMailboxSignatureDraftState() {
    return {
        personal: null,
        support: null
    };
}

function shouldShowSignaturePreviewByDefault() {
    return typeof window === 'undefined' ? true : window.innerWidth >= 1100;
}

function createDefaultSettingsUiState() {
    return {
        selectedSettingsSection: 'account',
        expandedMailboxEditorKind: '',
        expandedSignatureSubpanel: 'identity',
        showSignaturePreview: shouldShowSignaturePreviewByDefault()
    };
}

function getValidAdminTab(tabId) {
    return ADMIN_TABS.some((tab) => tab.id === tabId) ? tabId : 'team';
}

const state = {
    session: authService.getSession(),
    authUser: authService.getAuthUser(),
    profile: authService.getProfile(),
    authRemember: authService.getRememberPreference(),
    authResolved: false,
    authSubmitting: false,
    calendar: createDefaultCalendarState(),
    clients: [],
    allowedTags: [],
    tagDefinitions: [],
    dispositionDefinitions: [],
    users: [],
    mailboxSenders: [],
    mailboxSignatureDrafts: createDefaultMailboxSignatureDraftState(),
    ...createDefaultSettingsUiState(),
    savedFilters: [],
    importHistory: [],
    workspaceSummary: createEmptyWorkspaceSummary(),
    currentView: 'overview',
    lastWorkspaceView: 'clients',
    workspaceSearch: '',
    lookupQuery: '',
    searchSuggestions: [],
    searchSuggestionsOpen: false,
    searchSuggestionsLoading: false,
    searchSuggestionsQuery: '',
    activeSuggestionIndex: -1,
    activeSearchSurface: 'desktop',
    activeSearchCaret: null,
    searchShellExpanded: false,
    filters: normalizeFilterState(createDefaultFilters()),
    sort: {
        field: 'updatedAt',
        direction: 'desc'
    },
    page: 1,
    pageSize: 50,
    workspaceResults: {
        leads: createEmptyWorkspaceResult(),
        members: createEmptyWorkspaceResult()
    },
    sidebarOpen: false,
    desktopNavOpen: false,
    mobileSearchOpen: false,
    filtersPanelOpen: false,
    filterAccordionOpen: createDefaultFilterAccordionState(),
    filterAccordionInitialized: false,
    selectedLeadIds: [],
    bulkAssignRepId: '',
    drawerMode: null,
    drawerClientId: null,
    drawerEventId: null,
    drawerDate: '',
    emailComposer: createDefaultEmailComposerState(),
    emailWorkspace: createDefaultEmailWorkspaceState(),
    detailClientId: null,
    detailEditMode: false,
    detailEditSnapshot: null,
    editingNoteId: null,
    editingTagDefinitionId: null,
    editingDispositionDefinitionId: null,
    adminTab: 'team',
    adminUserSearch: '',
    adminUserFilter: 'all',
    modal: null,
    importFlow: null,
    activeSavedFilterId: null,
    notice: null,
    clientCacheMode: 'partial',
    workspaceLoaded: false,
    isLoading: false
};

restorePersistedWorkspaceUiState();

let noticeTimer = null;
const inlineFeedbackTimers = new Map();
let workspaceRefreshTimer = null;
let refreshDataPromise = null;
let searchSuggestionsTimer = null;
let searchSuggestionsRequestId = 0;
let calendarClientSuggestionsTimer = null;
let calendarClientSuggestionsRequestId = 0;
let calendarClientFocusRestorePending = false;
let emailWorkspaceAutoRefreshTimer = null;

bootstrap();

function getSessionStorage() {
    try {
        return window.sessionStorage;
    } catch (_error) {
        return null;
    }
}

function restorePersistedWorkspaceUiState() {
    const storage = getSessionStorage();

    if (!storage) {
        return;
    }

    try {
        const rawValue = storage.getItem(WORKSPACE_UI_STATE_STORAGE_KEY);

        if (!rawValue) {
            return;
        }

        const persisted = JSON.parse(rawValue);
        const restoredCurrentView = WORKSPACE_VIEWS.has(persisted.currentView) ? persisted.currentView : state.currentView;
        const restoredLastWorkspaceView = ['members', 'assigned-leads'].includes(persisted.lastWorkspaceView)
            ? persisted.lastWorkspaceView
            : 'clients';

        state.currentView = restoredCurrentView === 'imports' ? 'admin' : restoredCurrentView;
        state.lastWorkspaceView = restoredLastWorkspaceView;
        if (restoredCurrentView === 'imports') {
            state.adminTab = 'imports';
        }
        state.page = Math.max(1, Number(persisted.page) || 1);
        state.pageSize = WORKSPACE_PAGE_SIZES.includes(Number(persisted.pageSize)) ? Number(persisted.pageSize) : state.pageSize;
        state.workspaceSearch = typeof persisted.workspaceSearch === 'string'
            ? persisted.workspaceSearch
            : (typeof persisted.search === 'string' ? persisted.search : state.workspaceSearch);
        state.filters = normalizeFilterState(persisted.filters || state.filters);
        state.sort = {
            field: typeof persisted.sort?.field === 'string' ? persisted.sort.field : state.sort.field,
            direction: persisted.sort?.direction === 'asc' ? 'asc' : 'desc'
        };
        state.detailClientId = typeof persisted.detailClientId === 'string' ? persisted.detailClientId : null;

        if (state.currentView === 'lead-detail' && !state.detailClientId) {
            state.currentView = state.lastWorkspaceView;
        }
    } catch (_error) {
        storage.removeItem(WORKSPACE_UI_STATE_STORAGE_KEY);
    }
}

function persistWorkspaceUiState() {
    const storage = getSessionStorage();

    if (!storage) {
        return;
    }

    try {
        storage.setItem(WORKSPACE_UI_STATE_STORAGE_KEY, JSON.stringify({
            currentView: state.currentView,
            lastWorkspaceView: state.lastWorkspaceView,
            page: state.page,
            pageSize: state.pageSize,
            workspaceSearch: state.workspaceSearch,
            filters: state.filters,
            sort: state.sort,
            detailClientId: state.detailClientId || ''
        }));
    } catch (_error) {
        // Ignore sessionStorage write failures so CRM rendering never blocks on persistence.
    }
}

function buildWorkspacePageCacheKey(scope) {
    return JSON.stringify({
        scope: scope === 'members' ? 'members' : 'leads',
        assignmentState: getLeadAssignmentStateForScope(scope),
        page: state.page,
        pageSize: state.pageSize,
        search: normalizeWhitespace(state.workspaceSearch),
        filters: normalizeFilterState(state.filters),
        sort: {
            field: state.sort.field,
            direction: state.sort.direction
        }
    });
}

function shouldUseLocalWorkspaceFiltering(filters = state.filters) {
    return Array.isArray(filters?.multi?.timeZones) && filters.multi.timeZones.length > 0;
}

function isAssignedLeadsView(view = state.currentView) {
    return view === 'assigned-leads';
}

function isLeadsWorkspaceView(view = state.currentView) {
    return view === 'clients' || view === 'assigned-leads';
}

function isWorkspaceListView(view = state.currentView) {
    return isLeadsWorkspaceView(view) || view === 'members';
}

function getWorkspaceContextView(scope = getDefaultScopeForView()) {
    if (scope === 'members') {
        return 'members';
    }

    if (isLeadsWorkspaceView(state.currentView)) {
        return state.currentView;
    }

    return state.lastWorkspaceView === 'assigned-leads' ? 'assigned-leads' : 'clients';
}

function getLeadAssignmentStateForScope(scope = getDefaultScopeForView()) {
    if (scope === 'members' || !hasPermission(state.session, PERMISSIONS.ASSIGN_LEADS)) {
        return 'all';
    }

    return getWorkspaceContextView(scope) === 'assigned-leads' ? 'assigned' : 'unassigned';
}

function getCachedWorkspacePage(cacheKey) {
    const cachedEntry = workspacePageCache.get(cacheKey);

    if (!cachedEntry) {
        return null;
    }

    if ((Date.now() - cachedEntry.cachedAt) > WORKSPACE_PAGE_CACHE_TTL_MS) {
        workspacePageCache.delete(cacheKey);
        return null;
    }

    return cachedEntry.value;
}

function setCachedWorkspacePage(cacheKey, value) {
    workspacePageCache.set(cacheKey, {
        cachedAt: Date.now(),
        value
    });

    while (workspacePageCache.size > WORKSPACE_PAGE_CACHE_MAX_ENTRIES) {
        const oldestKey = workspacePageCache.keys().next().value;
        workspacePageCache.delete(oldestKey);
    }
}

function clearVisibleClientsCache() {
    visibleClientsCache.clientsRef = null;
    visibleClientsCache.filtersKey = '';
    visibleClientsCache.sortKey = '';
    visibleClientsCache.result = [];
}

function pruneClientCache() {
    const keepIds = new Set([
        state.detailClientId,
        state.drawerClientId,
        ...state.workspaceResults.leads.rows.map((client) => client.id),
        ...state.workspaceResults.members.rows.map((client) => client.id)
    ].filter(Boolean));

    if (!keepIds.size) {
        state.clients = [];
        return;
    }

    state.clients = state.clients.filter((client) => keepIds.has(client.id));
}

function invalidateWorkspacePageCache() {
    workspacePageCache.clear();
    state.workspaceResults = {
        leads: createEmptyWorkspaceResult(),
        members: createEmptyWorkspaceResult()
    };
    state.clientCacheMode = 'partial';
    pruneClientCache();
    clearVisibleClientsCache();
}

function getWorkspaceSummaryCount(scope = 'leads') {
    return scope === 'members'
        ? (state.workspaceSummary.memberCount || 0)
        : (state.workspaceSummary.leadCount || 0);
}

function updateWorkspaceSummaryCount(scope, totalCount) {
    if (scope === 'members') {
        state.workspaceSummary.memberCount = totalCount;
        return;
    }

    state.workspaceSummary.leadCount = totalCount;
}

function canUpdateWorkspaceSummaryFromActivePage() {
    return !normalizeWhitespace(state.workspaceSearch)
        && state.filters.status === 'all'
        && state.filters.tag === 'all'
        && Object.values(state.filters.multi).every((values) => values.length === 0);
}

function getPublicAuthMessage(message, fallback) {
    const normalized = String(message ?? '').trim();

    if (!normalized) {
        return fallback;
    }

    const lower = normalized.toLowerCase();

    if (lower.includes('invalid login credentials')) {
        return 'Invalid email or password. Please try again.';
    }

    if (lower.includes('email not confirmed')) {
        return 'Your account needs to be confirmed before you can sign in.';
    }

    if (
        lower.includes('supabase')
        || lower.includes('session')
        || lower.includes('auth user')
        || lower.includes('profile row')
        || lower.includes('rls policy')
    ) {
        return fallback;
    }

    return normalized;
}

function buildAuthRefreshKey({ session, authUser, profile }) {
    return JSON.stringify({
        sessionId: String(session?.id ?? ''),
        sessionRole: String(session?.role ?? ''),
        sessionCallPreference: String(session?.callPreference ?? ''),
        authUserId: String(authUser?.id ?? ''),
        profileId: String(profile?.id ?? ''),
        profileRole: String(profile?.role ?? ''),
        profileActive: profile?.isActive !== false,
        profileCallPreference: String(profile?.callPreference ?? '')
    });
}

function shouldRefreshWorkspaceForAuthEvent({ event, previousAuthKey, nextAuthKey }) {
    if (!state.workspaceLoaded) {
        return true;
    }

    if (!previousAuthKey || previousAuthKey !== nextAuthKey) {
        return true;
    }

    return event === 'USER_UPDATED';
}

async function bootstrap() {
    render();

    try {
        await authService.bindAuthListener(handleAuthStateChange);
        state.session = await authService.initialize();
        state.authUser = authService.getAuthUser();
        state.profile = authService.getProfile();
    } catch (error) {
        state.session = null;
        state.authUser = null;
        state.profile = null;
        flashNotice(
            getPublicAuthMessage(error.message, 'Unable to open the CRM sign-in page right now. Please refresh and try again.'),
            'error'
        );
    } finally {
        state.authResolved = true;
    }

    render();

    if (state.session) {
        await refreshData();
    }
}

async function refreshData() {
    if (refreshDataPromise) {
        return refreshDataPromise;
    }

    refreshDataPromise = (async () => {
        if (!state.session) {
            state.isLoading = false;
            render();
            return;
        }

        state.isLoading = true;
        render();

        try {
            const refreshedSession = await authService.updateSessionFromUser(state.session?.id);

            if (state.session && !refreshedSession) {
                await authService.logout();
                state.session = null;
                state.authUser = null;
                state.profile = null;
                state.isLoading = false;
                resetAuthenticatedCrmState();
                flashNotice('Your CRM session is no longer active.', 'error');
                return;
            }

            state.authUser = authService.getAuthUser();
            state.profile = authService.getProfile();
            if (state.currentView === 'admin' && !hasActiveAdminProfile()) {
                state.currentView = state.lastWorkspaceView || 'clients';
            }
            if (state.currentView === 'assigned-leads' && !hasPermission(state.session, PERMISSIONS.ASSIGN_LEADS)) {
                state.currentView = 'clients';
            }
            if (state.lastWorkspaceView === 'assigned-leads' && !hasPermission(state.session, PERMISSIONS.ASSIGN_LEADS)) {
                state.lastWorkspaceView = 'clients';
            }
            const usersPromise = authService.listUsers();
            state.session = refreshedSession || state.session;
            const savedFiltersPromise = savedFilterService.listVisible(state.session);

            if (state.currentView === 'admin' || shouldUseLocalWorkspaceFiltering()) {
                applyFullClientDataSnapshot(await dataService.initialize());
            } else {
                applyWorkspaceMetadataSnapshot(await dataService.initializeWorkspace());
            }
            [state.users, state.savedFilters] = await Promise.all([usersPromise, savedFiltersPromise]);

            if (state.calendar.filter === 'all' && !hasActiveAdminProfile()) {
                state.calendar.filter = 'mine';
            }
            await refreshCalendarEvents({ force: true, renderWhileLoading: false });
            if (state.currentView === 'email' && hasPermission(state.session, PERMISSIONS.SEND_EMAIL)) {
                await ensureEmailWorkspaceLoaded({ force: true, renderWhileLoading: false, preserveThread: true });
            } else {
                clearEmailWorkspaceAutoRefresh();
            }

            if (supportsServerWorkspacePaging() && state.currentView !== 'admin') {
                const workspaceScope = state.lastWorkspaceView === 'members' ? 'members' : 'leads';
                await refreshWorkspacePage(workspaceScope, { renderWhileLoading: false });
            }

            if (state.detailClientId) {
                const detailedLead = await dataService.getClientById(state.detailClientId);

                if (detailedLead && canAccessClient(detailedLead)) {
                    mergeClientCache([detailedLead]);
                    await loadLeadCalendarEvents(state.detailClientId, { force: true });
                }
            }

            if (state.detailClientId && !getAccessibleClientById(state.detailClientId)) {
                state.detailClientId = null;
                state.detailEditMode = false;
                state.editingNoteId = null;
                if (state.currentView === 'lead-detail') {
                    state.currentView = state.lastWorkspaceView || 'clients';
                }
            }

            state.workspaceLoaded = true;
        } catch (error) {
            flashNotice(error.message || 'Unable to load the CRM workspace.', 'error');
        } finally {
            state.isLoading = false;
            render();
        }
    })();

    try {
        return await refreshDataPromise;
    } finally {
        refreshDataPromise = null;
    }
}

function applyWorkspaceMetadataSnapshot({
    importHistory = [],
    allowedTags = [],
    tagDefinitions = [],
    dispositionDefinitions = [],
    mailboxSenders = [],
    workspaceSummary = createEmptyWorkspaceSummary()
} = {}) {
    state.allowedTags = allowedTags;
    state.tagDefinitions = tagDefinitions;
    state.dispositionDefinitions = dispositionDefinitions;
    state.mailboxSenders = mailboxSenders;
    state.importHistory = importHistory;
    state.emailWorkspace.mailboxes = [];
    state.emailWorkspace.syncStatus = [];
    state.emailWorkspace.initialized = false;
    state.workspaceSummary = {
        leadCount: Number(workspaceSummary.leadCount) || 0,
        memberCount: Number(workspaceSummary.memberCount) || 0
    };
    state.clientCacheMode = 'partial';
    pruneClientCache();
    clearVisibleClientsCache();
    if (normalizeWhitespace(state.filters.tag).toLowerCase() !== 'all' && !getActiveTagLabels().some((tag) => tag.toLowerCase() === state.filters.tag.toLowerCase())) {
        state.filters.tag = 'all';
    }
    if (state.editingTagDefinitionId && !state.tagDefinitions.some((definition) => definition.id === state.editingTagDefinitionId)) {
        state.editingTagDefinitionId = null;
    }
    if (state.editingDispositionDefinitionId && !state.dispositionDefinitions.some((definition) => definition.id === state.editingDispositionDefinitionId)) {
        state.editingDispositionDefinitionId = null;
    }
    state.selectedLeadIds = state.selectedLeadIds.filter((clientId) => Boolean(getAccessibleClientById(clientId)));
}

function applyFullClientDataSnapshot({
    clients = [],
    importHistory = [],
    allowedTags = [],
    tagDefinitions = [],
    dispositionDefinitions = [],
    mailboxSenders = []
} = {}) {
    state.clients = clients;
    state.allowedTags = allowedTags;
    state.tagDefinitions = tagDefinitions;
    state.dispositionDefinitions = dispositionDefinitions;
    state.mailboxSenders = mailboxSenders;
    state.importHistory = importHistory;
    state.emailWorkspace.mailboxes = [];
    state.emailWorkspace.syncStatus = [];
    state.emailWorkspace.initialized = false;
    state.workspaceSummary = {
        leadCount: clients.filter((client) => client.lifecycleType !== 'member').length,
        memberCount: clients.filter((client) => client.lifecycleType === 'member').length
    };
    state.clientCacheMode = 'full';
    clearVisibleClientsCache();
    if (normalizeWhitespace(state.filters.tag).toLowerCase() !== 'all' && !getActiveTagLabels().some((tag) => tag.toLowerCase() === state.filters.tag.toLowerCase())) {
        state.filters.tag = 'all';
    }
    if (state.editingTagDefinitionId && !state.tagDefinitions.some((definition) => definition.id === state.editingTagDefinitionId)) {
        state.editingTagDefinitionId = null;
    }
    if (state.editingDispositionDefinitionId && !state.dispositionDefinitions.some((definition) => definition.id === state.editingDispositionDefinitionId)) {
        state.editingDispositionDefinitionId = null;
    }
    state.selectedLeadIds = state.selectedLeadIds.filter((clientId) => Boolean(getAccessibleClientById(clientId)));
}

async function loadFullClientDataset() {
    if (!state.session || state.clientCacheMode === 'full') {
        return;
    }

    state.isLoading = true;
    render();

    try {
        applyFullClientDataSnapshot(await dataService.initialize());
    } catch (error) {
        flashNotice(error.message || 'Unable to load the full CRM dataset.', 'error');
    } finally {
        state.isLoading = false;
        render();
    }
}

function buildCalendarLoadRange(anchorDate = getMonthCursorDate()) {
    return {
        rangeStart: new Date(anchorDate.getFullYear(), anchorDate.getMonth() - 12, 1, 0, 0, 0, 0).toISOString(),
        rangeEnd: new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 13, 0, 23, 59, 59, 999).toISOString()
    };
}

async function refreshCalendarEvents({ anchorDate = getMonthCursorDate(), force = false, renderWhileLoading = false } = {}) {
    if (!state.session || typeof dataService.listCalendarEvents !== 'function') {
        state.calendar.events = [];
        state.calendar.isLoading = false;
        return;
    }

    const range = buildCalendarLoadRange(anchorDate);

    if (
        !force
        && state.calendar.rangeStart === range.rangeStart
        && state.calendar.rangeEnd === range.rangeEnd
        && Array.isArray(state.calendar.events)
        && state.calendar.events.length
    ) {
        return;
    }

    state.calendar.isLoading = true;
    if (renderWhileLoading) {
        renderPanels();
    }

    try {
        state.calendar.events = await dataService.listCalendarEvents(range);
        state.calendar.rangeStart = range.rangeStart;
        state.calendar.rangeEnd = range.rangeEnd;
    } finally {
        state.calendar.isLoading = false;
        if (renderWhileLoading) {
            renderPanels();
        }
    }
}

async function ensureCalendarEventsForDate(anchorDate) {
    const date = anchorDate instanceof Date ? anchorDate : new Date(anchorDate);

    if (Number.isNaN(date.getTime())) {
        return;
    }

    const selectedTime = date.getTime();
    const rangeStartTime = Date.parse(state.calendar.rangeStart || 0);
    const rangeEndTime = Date.parse(state.calendar.rangeEnd || 0);

    if (!rangeStartTime || !rangeEndTime || selectedTime < rangeStartTime || selectedTime > rangeEndTime) {
        await refreshCalendarEvents({ anchorDate: date, force: true, renderWhileLoading: false });
    }
}

async function loadLeadCalendarEvents(leadId, { force = false } = {}) {
    const normalizedLeadId = normalizeWhitespace(leadId);

    if (!normalizedLeadId || typeof dataService.listLeadCalendarEvents !== 'function') {
        return [];
    }

    if (!force && Array.isArray(state.calendar.leadEventsByLeadId[normalizedLeadId])) {
        return state.calendar.leadEventsByLeadId[normalizedLeadId];
    }

    const events = await dataService.listLeadCalendarEvents(normalizedLeadId);
    state.calendar.leadEventsByLeadId[normalizedLeadId] = events;
    return events;
}

function syncShellState() {
    const shouldLockBodyScroll = state.sidebarOpen && isMobileNavViewport();
    document.body.classList.toggle('crm-nav-open', shouldLockBodyScroll);

    if (!refs.shell) {
        return;
    }

    refs.shell.classList.toggle('sidebar-open', state.sidebarOpen);
    refs.shell.classList.toggle('drawer-open', isDrawerOpen());
}

function setSidebarOpen(isOpen) {
    state.sidebarOpen = isOpen;
    syncShellState();
}

function render() {
    persistWorkspaceUiState();

    if (!state.authResolved) {
        refs.authGate.classList.remove('hidden');
        refs.shell.classList.add('hidden');
        refs.authGate.innerHTML = renderAuthGate();
        refs.drawer.classList.add('hidden');
        refs.modalLayer.classList.add('hidden');
        document.body.classList.remove('crm-nav-open');
        refs.shell.classList.remove('drawer-open', 'sidebar-open');
        return;
    }

    if (!state.session) {
        refs.authGate.classList.remove('hidden');
        refs.shell.classList.add('hidden');
        refs.authGate.innerHTML = renderAuthGate();
        refs.drawer.classList.add('hidden');
        refs.modalLayer.classList.add('hidden');
        document.body.classList.remove('crm-nav-open');
        refs.shell.classList.remove('drawer-open', 'sidebar-open');
        return;
    }

    refs.authGate.classList.add('hidden');
    refs.shell.classList.remove('hidden');
    syncShellState();

    renderSidebar();
    renderTopbar();
    renderPanels();
    renderDrawer();
    renderModal();
}

function renderAuthGate() {
    const isCheckingSession = !state.authResolved;
    const isAuthenticating = state.authSubmitting;

    return `
        <div class="login-wrapper">
            <div class="login-container">
                <div class="login-inner">
                    <div class="login-header">
                        <div class="login-brand">
                            <img src="../assets/images/Crest logo.png" alt="Blue Chip Signals">
                        </div>
                        <p>
                            <span>Blue Chip Signals Workspace</span>
                            <span>Employee Access Only</span>
                        </p>
                    </div>

                    ${state.notice ? `
                        <div class="${state.notice.kind === 'error' ? 'error-message' : 'success-message'}">
                            ${escapeHtml(state.notice.message)}
                        </div>
                    ` : ''}

                    <form id="login-form">
                        <div class="form-group">
                            <label for="crm-login-email">Email Address</label>
                            <input
                                type="email"
                                id="crm-login-email"
                                name="email"
                                placeholder="Enter your email"
                                autocomplete="email"
                                required
                                ${isAuthenticating ? 'disabled' : ''}
                            >
                        </div>

                        <div class="form-group">
                            <label for="crm-login-password">Password</label>
                            <div class="password-wrapper">
                                <input
                                    type="password"
                                    id="crm-login-password"
                                    name="password"
                                    placeholder="Enter your password"
                                    autocomplete="current-password"
                                    required
                                    ${isAuthenticating ? 'disabled' : ''}
                                >
                                <button
                                    type="button"
                                    class="password-toggle"
                                    data-action="toggle-auth-password"
                                    aria-label="Show password"
                                    aria-pressed="false"
                                    ${isAuthenticating ? 'disabled' : ''}
                                >
                                    <i class="fas fa-eye"></i>
                                </button>
                            </div>
                        </div>

                        <div class="login-status-row">
                            <label class="remember-me" for="crm-login-remember">
                                <input
                                    type="checkbox"
                                    id="crm-login-remember"
                                    name="remember"
                                    ${state.authRemember ? 'checked' : ''}
                                    ${isAuthenticating ? 'disabled' : ''}
                                >
                                <span>Remember me</span>
                            </label>

                            ${isCheckingSession ? `
                                <div class="login-status">
                                    <i class="fa-solid fa-spinner fa-spin"></i>
                                    <span>Checking your session...</span>
                                </div>
                            ` : ''}
                        </div>

                        <div class="auth-login-actions">
                            <button type="submit" class="login-button" ${isAuthenticating ? 'disabled' : ''}>
                                <i class="fas ${isAuthenticating ? 'fa-circle-notch fa-spin' : 'fa-sign-in-alt'}"></i>
                                ${isAuthenticating ? 'Signing In...' : 'Log In'}
                            </button>
                            <button type="button" class="crm-button-ghost auth-return-button" data-action="return-main-site" ${isAuthenticating ? 'disabled' : ''}>
                                <i class="fa-solid fa-arrow-left"></i> Back to Main Site
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    `;
}

async function handleAuthStateChange({ event, session, authUser, profile, error }) {
    const previousAuthKey = buildAuthRefreshKey({
        session: state.session,
        authUser: state.authUser,
        profile: state.profile
    });

    if (error) {
        state.session = null;
        state.authUser = null;
        state.profile = null;
        resetAuthenticatedCrmState();
        state.authResolved = true;
        flashNotice(
            getPublicAuthMessage(error.message, 'Unable to verify your CRM access right now. Please sign in again.'),
            'error'
        );
        render();
        return;
    }

    state.session = session;
    state.authUser = authUser;
    state.profile = profile;
    state.authResolved = true;
    state.authSubmitting = false;

    if (!session) {
        resetAuthenticatedCrmState();
        render();
        return;
    }

    const nextAuthKey = buildAuthRefreshKey({ session, authUser, profile });

    if (!shouldRefreshWorkspaceForAuthEvent({ event, previousAuthKey, nextAuthKey })) {
        return;
    }

    await refreshData();
}

function supportsServerWorkspacePaging() {
    return typeof dataService.listClientsPage === 'function' && !shouldUseLocalWorkspaceFiltering();
}

function getWorkspaceResult(scope) {
    return state.workspaceResults[scope === 'members' ? 'members' : 'leads'];
}

function getWorkspacePageRows(scope) {
    if (!supportsServerWorkspacePaging()) {
        return getPaginatedClients(getVisibleClients(scope));
    }

    const workspace = getWorkspaceResult(scope);
    return workspace.rows;
}

function getWorkspaceDisplayCount(scope, options = {}) {
    if (!supportsServerWorkspacePaging()) {
        return getScopedClients(scope, options).length;
    }

    const workspace = getWorkspaceResult(scope);

    if (!options.ignoreSearch && !options.ignoreFilters && (workspace.loaded || workspace.isLoading)) {
        return workspace.totalCount;
    }

    if (options.ignoreSearch || options.ignoreFilters) {
        if (state.clientCacheMode === 'full') {
            return getScopedClients(scope, options).length;
        }

        return getWorkspaceSummaryCount(scope);
    }

    return workspace.totalCount || getWorkspaceSummaryCount(scope);
}

async function refreshWorkspacePage(scope = getDefaultScopeForView(), { renderWhileLoading = true, force = false } = {}) {
    if (!state.session) {
        return;
    }

    if (!supportsServerWorkspacePaging()) {
        if (shouldUseLocalWorkspaceFiltering() && state.clientCacheMode !== 'full') {
            await loadFullClientDataset();
            return;
        }

        renderSidebar();
        renderPanels();
        return;
    }

    const normalizedScope = scope === 'members' ? 'members' : 'leads';
    const assignmentState = getLeadAssignmentStateForScope(normalizedScope);
    const workspace = getWorkspaceResult(normalizedScope);
    const activeFilterGroup = document.activeElement?.matches?.('.filter-token-input')
        ? document.activeElement.dataset.filterGroup
        : '';
    const activeSearchSurface = document.activeElement?.matches?.('.crm-search')
        ? getSearchSurfaceFromElement(document.activeElement)
        : '';
    const activeSearchCaret = document.activeElement?.matches?.('.crm-search')
        ? (document.activeElement.selectionStart ?? document.activeElement.value.length)
        : null;
    const cacheKey = buildWorkspacePageCacheKey(normalizedScope);
    const cachedPage = force ? null : getCachedWorkspacePage(cacheKey);

    if (cachedPage) {
        workspace.rows = cachedPage.clients;
        workspace.totalCount = cachedPage.totalCount;
        workspace.loaded = true;
        workspace.isLoading = false;
        workspace.cacheKey = cacheKey;
        mergeClientCache(cachedPage.clients);
        if (assignmentState === 'all' && canUpdateWorkspaceSummaryFromActivePage()) {
            updateWorkspaceSummaryCount(normalizedScope, cachedPage.totalCount);
        }
        const syncedSearchUi = activeSearchSurface
            ? syncToolbarSearchUi({ activeSurface: activeSearchSurface, caretPosition: activeSearchCaret })
            : false;
        if (!syncedSearchUi) {
            renderTopbar();
        }
        renderSidebar();
        renderPanels();

        if (activeFilterGroup) {
            focusFilterInput(activeFilterGroup);
        }
        if (activeSearchSurface && !syncedSearchUi) {
            focusToolbarSearchInput(activeSearchSurface, activeSearchCaret);
        }
        return;
    }

    const requestId = workspace.requestId + 1;

    workspace.requestId = requestId;
    workspace.isLoading = true;

    if (renderWhileLoading) {
        renderPanels();
    }

    try {
        const result = await dataService.listClientsPage({
            scope: normalizedScope,
            assignmentState,
            page: state.page,
            pageSize: state.pageSize,
            search: state.workspaceSearch,
            sort: state.sort,
            filters: state.filters,
            tagDefinitions: state.tagDefinitions
        });

        if (workspace.requestId !== requestId) {
            return;
        }

        const totalPages = Math.max(1, Math.ceil(result.totalCount / state.pageSize));

        if (result.totalCount > 0 && !result.clients.length && state.page > totalPages) {
            state.page = totalPages;
            await refreshWorkspacePage(normalizedScope, { renderWhileLoading });
            return;
        }

        workspace.rows = result.clients;
        workspace.totalCount = result.totalCount;
        workspace.loaded = true;
        workspace.cacheKey = cacheKey;
        setCachedWorkspacePage(cacheKey, {
            clients: result.clients,
            totalCount: result.totalCount
        });
        if (assignmentState === 'all' && canUpdateWorkspaceSummaryFromActivePage()) {
            updateWorkspaceSummaryCount(normalizedScope, result.totalCount);
        }
        mergeClientCache(result.clients);
    } catch (error) {
        if (workspace.requestId !== requestId) {
            return;
        }
        flashNotice(error.message || `Unable to load ${normalizedScope}.`, 'error');
    } finally {
        if (workspace.requestId !== requestId) {
            return;
        }

        workspace.isLoading = false;
        const syncedSearchUi = activeSearchSurface
            ? syncToolbarSearchUi({ activeSurface: activeSearchSurface, caretPosition: activeSearchCaret })
            : false;
        if (!syncedSearchUi) {
            renderTopbar();
        }
        renderSidebar();
        renderPanels();

        if (activeFilterGroup) {
            focusFilterInput(activeFilterGroup);
        }
        if (activeSearchSurface && !syncedSearchUi) {
            focusToolbarSearchInput(activeSearchSurface, activeSearchCaret);
        }
    }
}

function queueWorkspaceRefresh(scope = getDefaultScopeForView()) {
    if (!supportsServerWorkspacePaging()) {
        return;
    }

    window.clearTimeout(workspaceRefreshTimer);
    workspaceRefreshTimer = window.setTimeout(() => {
        refreshWorkspacePage(scope, { renderWhileLoading: false });
    }, 180);
}

function mergeClientCache(incomingClients) {
    if (!Array.isArray(incomingClients) || !incomingClients.length) {
        return;
    }

    const clientsById = new Map(state.clients.map((client) => [client.id, client]));

    incomingClients.forEach((client) => {
        clientsById.set(client.id, {
            ...clientsById.get(client.id),
            ...client
        });
    });

    state.clients = [...clientsById.values()];
}

function getPrimaryNavItems() {
    return [
        { view: 'overview', label: 'Dashboard', icon: 'fa-chart-line', badge: null },
        { view: 'calendar', label: 'Calendar', icon: 'fa-calendar-days', badge: null },
        hasPermission(state.session, PERMISSIONS.SEND_EMAIL)
            ? { view: 'email', label: 'Email', icon: 'fa-envelope-open-text', badge: null }
            : null,
        { view: 'clients', label: 'Leads', icon: 'fa-address-book', badge: getWorkspaceDisplayCount('leads').toLocaleString() },
        hasActiveAdminProfile()
            ? { view: 'admin', label: 'Admin', icon: 'fa-shield-halved', badge: null }
            : null,
        { view: 'settings', label: getSettingsNavLabel(), icon: 'fa-user', badge: null }
    ].filter(Boolean);
}

function getSettingsNavLabel() {
    const fullName = normalizeWhitespace(state.session?.name || '');

    if (!fullName) {
        return 'Settings';
    }

    const [firstName] = fullName.split(/\s+/);
    return firstName || 'Settings';
}

function getActivePrimaryNavView() {
    if (state.currentView === 'lead-detail') {
        return 'clients';
    }

    if (state.currentView === 'members') {
        return 'clients';
    }

    if (state.currentView === 'assigned-leads') {
        return 'clients';
    }

    if (state.currentView === 'calendar') {
        return 'calendar';
    }

    if (state.currentView === 'email') {
        return 'email';
    }

    if (state.currentView === 'imports') {
        return 'admin';
    }

    if (state.currentView === 'settings') {
        return 'settings';
    }

    return state.currentView;
}

function getActivePrimaryNavItem(items = getPrimaryNavItems(), activeView = getActivePrimaryNavView()) {
    return items.find((item) => item.view === activeView) || items[0] || {
        view: 'overview',
        label: 'Navigation',
        icon: 'fa-bars-staggered',
        badge: null
    };
}

function renderDesktopPrimaryNav(items = getPrimaryNavItems(), activeView = getActivePrimaryNavView()) {
    const activeItem = getActivePrimaryNavItem(items, activeView);

    return `
        <div class="crm-primary-nav" role="navigation" aria-label="CRM navigation">
            <div class="crm-desktop-nav ${state.desktopNavOpen ? 'is-open' : ''}">
                <button
                    class="crm-desktop-nav-trigger"
                    type="button"
                    data-action="toggle-desktop-nav"
                    aria-haspopup="menu"
                    aria-expanded="${state.desktopNavOpen ? 'true' : 'false'}"
                    aria-label="Toggle CRM navigation menu"
                >
                    <span class="crm-desktop-nav-trigger-icon">
                        <i class="fa-solid fa-bars-staggered"></i>
                    </span>
                    <span class="crm-desktop-nav-trigger-copy">
                        <span class="crm-desktop-nav-trigger-label">Navigation</span>
                        <span class="crm-desktop-nav-trigger-value">${escapeHtml(activeItem.label)}</span>
                    </span>
                    <span class="crm-desktop-nav-trigger-chevron">
                        <i class="fa-solid fa-chevron-down"></i>
                    </span>
                </button>

                <div class="crm-desktop-nav-panel" role="menu" aria-label="CRM navigation menu">
                    ${items.map((item, index) => `
                        <button
                            class="crm-desktop-nav-link ${activeView === item.view ? 'active' : ''}"
                            type="button"
                            data-action="set-view"
                            data-view="${item.view}"
                            style="--crm-nav-index:${index};"
                            role="menuitem"
                        >
                            <span class="crm-desktop-nav-link-icon">
                                <i class="fa-solid ${escapeHtml(item.icon || 'fa-circle')}"></i>
                            </span>
                            <span class="crm-desktop-nav-link-label">${escapeHtml(item.label)}</span>
                            ${item.badge ? `<span class="crm-desktop-nav-link-badge">${escapeHtml(item.badge)}</span>` : ''}
                        </button>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
}

function getLeadDetailNavigationContext() {
    const detailScope = state.lastWorkspaceView === 'members' ? 'members' : 'leads';
    const visibleSet = getLeadNavigationSet(detailScope);
    const currentIndex = visibleSet.findIndex((item) => item.id === state.detailClientId);
    const backLabel = state.lastWorkspaceView === 'members'
        ? 'Members'
        : (state.lastWorkspaceView === 'assigned-leads' ? 'Assigned Leads' : 'Leads');

    return {
        detailScope,
        visibleSet,
        currentIndex,
        previousLead: currentIndex > 0 ? visibleSet[currentIndex - 1] : null,
        nextLead: currentIndex >= 0 && currentIndex < visibleSet.length - 1 ? visibleSet[currentIndex + 1] : null,
        backLabel
    };
}

function isMobileNavViewport() {
    return window.matchMedia('(max-width: 768px)').matches;
}

function isWorkspaceSearchView(view = state.currentView) {
    return isWorkspaceListView(view);
}

function getToolbarSearchValue(view = state.currentView) {
    return isWorkspaceSearchView(view) ? state.workspaceSearch : state.lookupQuery;
}

function hasActiveToolbarSearch() {
    return Boolean(normalizeWhitespace(getToolbarSearchValue()));
}

function getSearchSurfaceFromElement(element) {
    return element?.hasAttribute?.('data-mobile-search-input') ? 'mobile' : 'desktop';
}

function shouldShowMobileSearch() {
    return !state.sidebarOpen && (state.mobileSearchOpen || hasActiveToolbarSearch());
}

function getClampedInputCaret(input, caretPosition = null) {
    const valueLength = input?.value?.length ?? 0;

    if (typeof caretPosition !== 'number' || Number.isNaN(caretPosition)) {
        return valueLength;
    }

    return Math.max(0, Math.min(caretPosition, valueLength));
}

function restoreInputCaret(input, caretPosition = null) {
    if (!input) {
        return null;
    }

    const caret = getClampedInputCaret(input, caretPosition);

    if (typeof input.setSelectionRange === 'function') {
        input.setSelectionRange(caret, caret);
    }

    return caret;
}

function focusToolbarSearchInput(surface = 'mobile', caretPosition = null) {
    requestAnimationFrame(() => {
        const selector = surface === 'desktop'
            ? '[data-desktop-search-input]'
            : '[data-mobile-search-input]';
        const input = refs.topbar?.querySelector(selector);

        if (!input) {
            return;
        }

        input.focus();
        const caret = restoreInputCaret(input, caretPosition);
        state.activeSearchSurface = surface;
        state.activeSearchCaret = caret;
    });
}

function syncToolbarSearchShell(surface = 'desktop', caretPosition = null) {
    if (!refs.topbar) {
        return false;
    }

    const shellSelector = surface === 'mobile'
        ? '.crm-search-shell-mobile'
        : '.crm-search-shell-desktop';
    const shell = refs.topbar.querySelector(shellSelector);

    if (!shell) {
        return false;
    }

    const listId = surface === 'mobile' ? 'crm-mobile-search-suggestions' : 'crm-desktop-search-suggestions';
    const activeId = state.activeSuggestionIndex >= 0 ? `${listId}-${state.activeSuggestionIndex}` : '';
    const isExpanded = state.searchShellExpanded || shouldShowSearchSuggestions();
    const input = shell.querySelector('.crm-search');

    shell.classList.toggle('is-expanded', isExpanded);

    if (input) {
        const nextValue = getToolbarSearchValue();
        const isActiveInput = document.activeElement === input;
        const nextCaret = isActiveInput
            ? getClampedInputCaret(
                input,
                typeof caretPosition === 'number'
                    ? caretPosition
                    : (input.selectionStart ?? input.value.length)
            )
            : null;

        if (input.value !== nextValue) {
            input.value = nextValue;
        }

        input.setAttribute('aria-expanded', shouldShowSearchSuggestions() ? 'true' : 'false');
        input.setAttribute('aria-controls', listId);
        input.setAttribute('aria-activedescendant', activeId);

        if (isActiveInput) {
            const restoredCaret = restoreInputCaret(input, nextCaret);
            state.activeSearchSurface = surface;
            state.activeSearchCaret = restoredCaret;
        }
    }

    const currentPanel = shell.querySelector('[data-search-suggestions]');
    const nextPanelMarkup = renderToolbarSuggestionList(surface).trim();

    if (!nextPanelMarkup) {
        currentPanel?.remove();
        return true;
    }

    const template = document.createElement('template');
    template.innerHTML = nextPanelMarkup;
    const nextPanel = template.content.firstElementChild;

    if (!nextPanel) {
        currentPanel?.remove();
        return true;
    }

    if (currentPanel) {
        currentPanel.replaceWith(nextPanel);
    } else {
        shell.appendChild(nextPanel);
    }

    return true;
}

function syncToolbarSearchUi({
    activeSurface = state.activeSearchSurface,
    caretPosition = state.activeSearchCaret
} = {}) {
    const syncedDesktop = syncToolbarSearchShell('desktop', activeSurface === 'desktop' ? caretPosition : null);
    const syncedMobile = syncToolbarSearchShell('mobile', activeSurface === 'mobile' ? caretPosition : null);
    return syncedDesktop || syncedMobile;
}

function shouldShowSearchSuggestions() {
    return !state.sidebarOpen
        && state.searchSuggestionsOpen
        && Boolean(normalizeWhitespace(getToolbarSearchValue()));
}

function setSearchShellExpanded(isExpanded) {
    state.searchShellExpanded = isExpanded;
}

function resetToolbarSuggestions({ clearResults = false } = {}) {
    window.clearTimeout(searchSuggestionsTimer);
    searchSuggestionsRequestId += 1;
    state.searchSuggestionsOpen = false;
    state.searchSuggestionsLoading = false;
    state.activeSuggestionIndex = -1;
    setSearchShellExpanded(false);

    if (clearResults) {
        state.searchSuggestions = [];
        state.searchSuggestionsQuery = '';
    }
}

function queueToolbarSuggestions({ immediate = false, surface = state.activeSearchSurface } = {}) {
    const query = normalizeWhitespace(getToolbarSearchValue());

    window.clearTimeout(searchSuggestionsTimer);

    if (!query) {
        resetToolbarSuggestions({ clearResults: true });
        if (!syncToolbarSearchUi({ activeSurface: surface, caretPosition: state.activeSearchCaret })) {
            renderTopbar();
        }
        return;
    }

    const requestId = ++searchSuggestionsRequestId;
    state.searchSuggestionsOpen = true;
    state.searchSuggestionsLoading = true;
    state.searchSuggestionsQuery = query;

    const runLookup = async () => {
        try {
            const suggestions = await dataService.searchClientSuggestions({ query, limit: 10 });

            if (requestId !== searchSuggestionsRequestId || normalizeWhitespace(getToolbarSearchValue()) !== query) {
                return;
            }

            state.searchSuggestions = suggestions;
            state.activeSuggestionIndex = suggestions.length ? 0 : -1;
        } catch (error) {
            if (requestId !== searchSuggestionsRequestId) {
                return;
            }

            state.searchSuggestions = [];
            state.activeSuggestionIndex = -1;
            flashNotice(error.message || 'Unable to load search suggestions.', 'error');
        } finally {
            if (requestId !== searchSuggestionsRequestId) {
                return;
            }

            state.searchSuggestionsLoading = false;
            const syncedSearchUi = syncToolbarSearchUi({
                activeSurface: surface,
                caretPosition: state.activeSearchCaret
            });

            if (!syncedSearchUi) {
                renderTopbar();
                focusToolbarSearchInput(surface, state.activeSearchCaret);
            }
        }
    };

    if (immediate) {
        runLookup();
        return;
    }

    searchSuggestionsTimer = window.setTimeout(runLookup, SEARCH_SUGGESTION_DEBOUNCE_MS);
}

function getSearchSuggestionMeta(suggestion) {
    return [
        suggestion.phone || '',
        suggestion.email || '',
        suggestion.businessName || ''
    ].filter(Boolean).join(' · ');
}

function renderToolbarSuggestionList(surface = 'desktop') {
    if (!shouldShowSearchSuggestions()) {
        return '';
    }

    const listId = surface === 'mobile' ? 'crm-mobile-search-suggestions' : 'crm-desktop-search-suggestions';
    const activeId = state.activeSuggestionIndex >= 0 ? `${listId}-${state.activeSuggestionIndex}` : '';

    return `
        <div class="crm-search-suggestion-panel" data-search-suggestions>
            <div class="crm-search-suggestion-head">
                <span>Matches</span>
                <span>${state.searchSuggestionsLoading ? 'Searching...' : `${state.searchSuggestions.length} showing`}</span>
            </div>
            <div
                id="${listId}"
                class="crm-search-suggestion-list"
                role="listbox"
                aria-label="CRM search suggestions"
                data-active-descendant="${escapeHtml(activeId)}"
            >
                ${state.searchSuggestionsLoading ? `
                    <div class="crm-search-suggestion-empty">
                        <i class="fa-solid fa-circle-notch fa-spin"></i>
                        Looking up leads and members...
                    </div>
                ` : state.searchSuggestions.length ? state.searchSuggestions.map((suggestion, index) => `
                    <button
                        id="${listId}-${index}"
                        type="button"
                        class="crm-search-suggestion-item ${index === state.activeSuggestionIndex ? 'active' : ''}"
                        data-action="select-search-suggestion"
                        data-client-id="${escapeHtml(suggestion.id)}"
                    >
                        <span class="crm-search-suggestion-copy">
                            <span class="crm-search-suggestion-label">
                                ${escapeHtml(suggestion.fullName || 'Unnamed lead')}
                                <span class="crm-search-suggestion-type ${suggestion.lifecycleType === 'member' ? 'member' : 'lead'}">
                                    ${escapeHtml(titleCase(suggestion.lifecycleType || 'lead'))}
                                </span>
                            </span>
                            <span class="crm-search-suggestion-meta">${escapeHtml(getSearchSuggestionMeta(suggestion) || buildClientMetaLine(suggestion))}</span>
                        </span>
                    </button>
                `).join('') : `
                    <div class="crm-search-suggestion-empty">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        No matching leads or members.
                    </div>
                `}
            </div>
        </div>
    `;
}

function renderPreviewField(label, value, { fullWidth = false } = {}) {
    const isRichValue = value && typeof value === 'object' && !Array.isArray(value);
    const fieldMarkup = isRichValue && typeof value.html === 'string'
        ? value.html
        : escapeHtml(isRichValue ? (value.text || '—') : (value || '—'));

    return `
        <div class="crm-search-preview-field ${fullWidth ? 'is-full' : ''}">
            <span class="crm-search-preview-field-label">${escapeHtml(label)}</span>
            <div class="crm-search-preview-field-value">${fieldMarkup}</div>
        </div>
    `;
}

function buildPhoneHref(phoneValue) {
    const displayValue = normalizeWhitespace(phoneValue);
    const digits = normalizePhone(displayValue);

    if (!displayValue || digits.length < 7) {
        return '';
    }

    if (digits.length === 10) {
        return `tel:+1${digits}`;
    }

    if (digits.length === 11) {
        return `tel:+${digits}`;
    }

    return `tel:${digits}`;
}

function buildGoogleVoicePhoneHref(phoneValue) {
    const telHref = buildPhoneHref(phoneValue);
    const dialTarget = telHref.replace(/^tel:/, '');

    if (!dialTarget) {
        return '';
    }

    return `${GOOGLE_VOICE_WEB_CALL_BASE_URL}${encodeURIComponent(dialTarget)}`;
}

function isLikelyMobileCallingDevice() {
    const userAgent = navigator.userAgent || '';
    return /android|iphone|ipad|ipod|iemobile|opera mini/i.test(userAgent);
}
function normalizeCallPreference(value) {
    return normalizeWhitespace(value).toLowerCase() === 'google_voice'
        ? 'google_voice'
        : 'system_default';
}

function getCurrentCallPreference() {
    return normalizeCallPreference(state.profile?.callPreference || state.session?.callPreference);
}

function getCallPreferenceLabel(callPreference = getCurrentCallPreference()) {
    return normalizeCallPreference(callPreference) === 'google_voice'
        ? 'Google Voice'
        : 'System default';
}

function buildPhoneCallLabel(displayValue, callPreference = getCurrentCallPreference()) {
    return normalizeCallPreference(callPreference) === 'google_voice'
        ? `Call ${displayValue} with Google Voice`
        : `Call ${displayValue}`;
}

function renderPhoneModeBadge(callPreference = getCurrentCallPreference()) {
    return normalizeCallPreference(callPreference) === 'google_voice'
        ? '<span class="crm-phone-link-badge">Voice</span>'
        : '';
}

function renderPhoneUtilityActions(displayValue, { variant = 'inline', callPreference = getCurrentCallPreference() } = {}) {
    const normalizedDisplayValue = normalizeWhitespace(displayValue);

    if (!normalizedDisplayValue) {
        return '';
    }

    const resolvedCallPreference = normalizeCallPreference(callPreference);
    const actionClassName = variant === 'field'
        ? 'crm-phone-utility-actions is-field'
        : 'crm-phone-utility-actions';
    const utilityActions = resolvedCallPreference === 'google_voice'
        ? [
            `
                <a
                    class="crm-phone-utility-button"
                    href="${buildPhoneHref(normalizedDisplayValue)}"
                    aria-label="${escapeHtml(`Call ${normalizedDisplayValue} with your system default phone app`)}"
                    title="Use system default for this call"
                >
                    <i class="fa-solid fa-mobile-screen-button" aria-hidden="true"></i>
                </a>
            `.replace(/\s+/g, ' ').trim(),
            `
                <button
                    class="crm-phone-utility-button"
                    type="button"
                    data-action="copy-phone-number"
                    data-phone="${escapeHtml(normalizedDisplayValue)}"
                    aria-label="${escapeHtml(`Copy ${normalizedDisplayValue}`)}"
                    title="Copy number"
                >
                    <i class="fa-solid fa-copy" aria-hidden="true"></i>
                </button>
            `.replace(/\s+/g, ' ').trim()
        ]
        : [
            `
                <a
                    class="crm-phone-utility-button"
                    href="${GOOGLE_VOICE_HELP_URL}"
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open Google Voice calling help"
                    title="Google Voice help"
                >
                    <i class="fa-solid fa-circle-question" aria-hidden="true"></i>
                </a>
            `.replace(/\s+/g, ' ').trim(),
            `
                <button
                    class="crm-phone-utility-button"
                    type="button"
                    data-action="copy-phone-number"
                    data-phone="${escapeHtml(normalizedDisplayValue)}"
                    aria-label="${escapeHtml(`Copy ${normalizedDisplayValue}`)}"
                    title="Copy number"
                >
                    <i class="fa-solid fa-copy" aria-hidden="true"></i>
                </button>
            `.replace(/\s+/g, ' ').trim()
        ];

    return `<span class="${actionClassName}">${utilityActions.join('')}</span>`;
}

function buildPhoneActionTarget(phoneValue, callPreference = getCurrentCallPreference()) {
    const resolvedCallPreference = normalizeCallPreference(callPreference);
    const systemDefaultHref = buildPhoneHref(phoneValue);

    if (!systemDefaultHref) {
        return {
            href: '',
            target: '',
            rel: ''
        };
    }

    if (resolvedCallPreference !== 'google_voice' || isLikelyMobileCallingDevice()) {
        return {
            href: systemDefaultHref,
            target: '',
            rel: ''
        };
    }

    const googleVoiceHref = buildGoogleVoicePhoneHref(phoneValue);

    return {
        href: googleVoiceHref || systemDefaultHref,
        target: googleVoiceHref ? '_blank' : '',
        rel: googleVoiceHref ? 'noreferrer' : ''
    };
}

function renderPhoneActionGroup(
    phoneValue,
    {
        placeholder = '—',
        className = 'crm-phone-link',
        includeIcon = false,
        variant = 'inline',
        callPreference = getCurrentCallPreference()
    } = {}
) {
    const displayValue = normalizeWhitespace(phoneValue);

    if (!displayValue) {
        return escapeHtml(placeholder);
    }

    const targetConfig = buildPhoneActionTarget(displayValue, callPreference);
    const href = targetConfig.href;

    if (!href) {
        return escapeHtml(displayValue);
    }

    const resolvedCallPreference = normalizeCallPreference(callPreference);
    const callLabel = buildPhoneCallLabel(displayValue, resolvedCallPreference);
    const title = resolvedCallPreference === 'google_voice'
        ? (isLikelyMobileCallingDevice()
            ? `${callLabel}. On mobile, CRM uses your device's normal phone flow.`
            : `${callLabel}. This opens Google Voice in a new tab if you are signed into the correct Google account.`)
        : callLabel;
    const wrapperClasses = [
        'crm-phone-action-group',
        variant === 'field' ? 'is-field' : '',
        resolvedCallPreference === 'google_voice' ? 'is-google-voice' : ''
    ].filter(Boolean).join(' ');
    const primaryClasses = [
        className,
        includeIcon || resolvedCallPreference === 'google_voice' ? 'has-icon' : '',
        resolvedCallPreference === 'google_voice' ? 'is-google-voice' : ''
    ].filter(Boolean).join(' ');
    const phoneIcon = resolvedCallPreference === 'google_voice' ? 'fa-phone-volume' : 'fa-phone';

    return `
        <span class="${wrapperClasses}">
            <a class="${primaryClasses}" href="${href}" ${targetConfig.target ? `target="${targetConfig.target}"` : ''} ${targetConfig.rel ? `rel="${targetConfig.rel}"` : ''} aria-label="${escapeHtml(callLabel)}" title="${escapeHtml(title)}">
                <span class="crm-phone-primary-copy"><span>${escapeHtml(displayValue)}</span>${renderPhoneModeBadge(resolvedCallPreference)}</span>
                ${includeIcon || resolvedCallPreference === 'google_voice' ? `<i class="fa-solid ${phoneIcon}" aria-hidden="true"></i>` : ''}
            </a>
            ${renderPhoneUtilityActions(displayValue, { variant, callPreference: resolvedCallPreference })}
        </span>
    `.replace(/\s+/g, ' ').trim();
}

async function copyTextToClipboard(value, { promptLabel = 'Copy this value:' } = {}) {
    const normalizedValue = String(value ?? '');

    if (!normalizedValue) {
        throw new Error('Nothing is available to copy right now.');
    }

    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(normalizedValue);
            return 'clipboard';
        }
    } catch (_error) {
        // Fall back to a hidden textarea so copy still works in more browsers.
    }

    const textArea = document.createElement('textarea');
    textArea.value = normalizedValue;
    textArea.setAttribute('readonly', 'readonly');
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    textArea.style.pointerEvents = 'none';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
        if (document.execCommand('copy')) {
            return 'clipboard';
        }
    } finally {
        document.body.removeChild(textArea);
    }

    window.prompt(promptLabel, normalizedValue);
    return 'prompt';
}

function normalizeEmailAddress(emailValue) {
    const displayValue = normalizeWhitespace(emailValue).toLowerCase();

    if (!displayValue || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(displayValue)) {
        return '';
    }

    return displayValue;
}

function renderEmailLink(
    emailValue,
    {
        placeholder = '—',
        className = 'crm-email-link',
        includeIcon = false,
        clientId = '',
        recipientName = ''
    } = {}
) {
    const displayValue = normalizeWhitespace(emailValue).toLowerCase();

    if (!displayValue) {
        return escapeHtml(placeholder);
    }

    const normalizedEmail = normalizeEmailAddress(displayValue);

    if (!normalizedEmail) {
        return escapeHtml(displayValue);
    }

    const classes = [className, 'crm-email-trigger', includeIcon ? 'has-icon' : ''].filter(Boolean).join(' ');
    const emailLabel = `Compose email to ${normalizedEmail}`;

    return `
        <button
            class="${classes}"
            type="button"
            data-action="open-email-composer"
            data-recipient-email="${escapeHtml(normalizedEmail)}"
            ${clientId ? `data-client-id="${escapeHtml(clientId)}"` : ''}
            ${recipientName ? `data-recipient-name="${escapeHtml(recipientName)}"` : ''}
            aria-label="${escapeHtml(emailLabel)}"
            title="${escapeHtml(emailLabel)}"
        >${includeIcon ? '<i class="fa-solid fa-envelope" aria-hidden="true"></i>' : ''}<span>${escapeHtml(normalizedEmail)}</span></button>
    `.replace(/\s+/g, ' ').trim();
}

function renderPhoneLink(phoneValue, { placeholder = '—', className = 'crm-phone-link', includeIcon = false } = {}) {
    return renderPhoneActionGroup(phoneValue, {
        placeholder,
        className,
        includeIcon,
        variant: 'inline'
    });
}

function renderReadOnlyPhoneField(label, name, value) {
    const displayValue = normalizeWhitespace(value);
    const href = buildPhoneHref(displayValue);
    const controlMarkup = href
        ? renderPhoneActionGroup(displayValue, {
            className: 'crm-input crm-contact-field is-callable',
            includeIcon: true,
            variant: 'field'
        })
        : `<div class="crm-input crm-contact-field is-static"><span>${escapeHtml(displayValue || '—')}</span></div>`;

    return `
        <div class="form-field">
            <span class="form-label">${escapeHtml(label)}</span>
            <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value || '')}">
            ${controlMarkup}
        </div>
    `;
}

function renderReadOnlyEmailField(label, name, value, { clientId = '', recipientName = '' } = {}) {
    const displayValue = normalizeWhitespace(value).toLowerCase();
    const normalizedEmail = normalizeEmailAddress(displayValue);
    const emailLabel = `Compose email to ${normalizedEmail}`;
    const controlMarkup = normalizedEmail
        ? `
            <button
                class="crm-input crm-contact-field crm-contact-field-button is-callable"
                type="button"
                data-action="open-email-composer"
                data-recipient-email="${escapeHtml(normalizedEmail)}"
                ${clientId ? `data-client-id="${escapeHtml(clientId)}"` : ''}
                ${recipientName ? `data-recipient-name="${escapeHtml(recipientName)}"` : ''}
                aria-label="${escapeHtml(emailLabel)}"
                title="${escapeHtml(emailLabel)}"
            ><span>${escapeHtml(normalizedEmail)}</span><i class="fa-solid fa-envelope" aria-hidden="true"></i></button>
        `.replace(/\s+/g, ' ').trim()
        : `<div class="crm-input crm-contact-field is-static"><span>${escapeHtml(displayValue || '—')}</span></div>`;

    return `
        <div class="form-field">
            <span class="form-label">${escapeHtml(label)}</span>
            <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value || '')}">
            ${controlMarkup}
        </div>
    `;
}

function renderPreviewTextPanel(title, body, meta = '') {
    return `
        <section class="crm-search-preview-section crm-search-preview-section-full crm-search-preview-section-text">
            <div class="crm-search-preview-section-head">
                <span class="crm-search-preview-section-title">${escapeHtml(title)}</span>
            </div>
            <div class="crm-search-preview-text-panel">
                <div class="crm-search-preview-copy">${escapeHtml(body || '—')}</div>
                ${meta ? `<div class="crm-search-preview-panel-meta">${escapeHtml(meta)}</div>` : ''}
            </div>
        </section>
    `;
}

function renderToolbarSearchField(surface = 'desktop') {
    const searchId = surface === 'mobile' ? 'crm-mobile-global-search' : 'crm-desktop-global-search';
    const shellClass = surface === 'mobile' ? 'crm-search-shell-mobile' : 'crm-search-shell-desktop';
    const dataAttribute = surface === 'mobile' ? 'data-mobile-search-input' : 'data-desktop-search-input';
    const listId = surface === 'mobile' ? 'crm-mobile-search-suggestions' : 'crm-desktop-search-suggestions';
    const activeId = state.activeSuggestionIndex >= 0 ? `${listId}-${state.activeSuggestionIndex}` : '';
    const isExpanded = state.searchShellExpanded || shouldShowSearchSuggestions();

    return `
        <div class="search-shell ${shellClass} ${isExpanded ? 'is-expanded' : ''}">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input
                id="${searchId}"
                class="crm-search"
                type="search"
                placeholder="Search by first name, last name, full name, email, or phone"
                value="${escapeHtml(getToolbarSearchValue())}"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded="${shouldShowSearchSuggestions() ? 'true' : 'false'}"
                aria-controls="${listId}"
                aria-activedescendant="${escapeHtml(activeId)}"
                ${dataAttribute}
            >
            ${renderToolbarSuggestionList(surface)}
        </div>
    `;
}

function renderSidebar() {
    refs.sidebar.innerHTML = '';
}

function renderTopbar() {
    const items = getPrimaryNavItems();
    const activeView = getActivePrimaryNavView();
    const mobileSearchVisible = shouldShowMobileSearch();

    refs.topbar.innerHTML = `
        <div class="crm-toolbar">
            <div class="crm-toolbar-row">
                <button
                    class="crm-mobile-toggle ${state.sidebarOpen ? 'is-open' : ''}"
                    data-action="toggle-sidebar"
                    aria-label="Toggle CRM navigation"
                    aria-expanded="${state.sidebarOpen ? 'true' : 'false'}"
                >
                    <span class="crm-mobile-toggle-bar"></span>
                    <span class="crm-mobile-toggle-bar"></span>
                    <span class="crm-mobile-toggle-bar"></span>
                </button>

                <div class="crm-toolbar-left">
                    <button class="crm-toolbar-brand" type="button" data-action="set-view" data-view="overview" aria-label="Go to CRM overview">
                        <img src="../assets/images/Crest logo.png" alt="Blue Chip Signals logo">
                    </button>

                    ${renderToolbarSearchField('desktop')}
                </div>

                <div class="crm-toolbar-right">
                    ${renderDesktopPrimaryNav(items, activeView)}
                </div>

                <button
                    class="crm-mobile-search-toggle ${mobileSearchVisible ? 'active' : ''}"
                    data-action="toggle-mobile-search"
                    aria-label="Toggle search"
                    aria-expanded="${mobileSearchVisible ? 'true' : 'false'}"
                >
                    <i class="fa-solid fa-magnifying-glass"></i>
                </button>
            </div>

            <div class="crm-mobile-search-row ${mobileSearchVisible ? 'active' : ''}">
                ${renderToolbarSearchField('mobile')}
            </div>

            <div
                class="crm-mobile-menu-panel ${state.sidebarOpen ? 'active' : ''}"
                role="dialog"
                aria-modal="true"
                aria-label="CRM navigation"
                aria-hidden="${state.sidebarOpen ? 'false' : 'true'}"
            >
                <div class="crm-mobile-menu-links" role="navigation" aria-label="CRM navigation">
                    ${items.map((item, index) => `
                        <button
                            class="crm-mobile-menu-link ${activeView === item.view ? 'active' : ''}"
                            data-action="set-view"
                            data-view="${item.view}"
                            style="--crm-menu-index:${index};"
                        >
                            <span>${item.label}</span>
                        </button>
                    `).join('')}
                </div>
            </div>
        </div>

        ${state.notice ? `
            <div class="crm-alert crm-alert-${state.notice.kind}">
                <div>${escapeHtml(state.notice.message)}</div>
                <button class="crm-button-ghost crm-alert-dismiss" data-action="dismiss-notice">
                    Dismiss
                </button>
            </div>
        ` : ''}
    `;
}

function renderLeadDetailUtilityRow() {
    if (state.currentView !== 'lead-detail') {
        return '';
    }

    const { previousLead, nextLead, backLabel } = getLeadDetailNavigationContext();

    return `
        <div class="crm-detail-utility">
            <div class="crm-detail-utility-left">
                <button class="crm-button-ghost crm-detail-floating-button" data-action="back-to-list">
                    <span class="crm-detail-floating-icon"><i class="fa-solid fa-arrow-left"></i></span>
                    <span>Back to ${escapeHtml(backLabel)}</span>
                </button>
            </div>

            <div class="crm-detail-utility-right">
                <button class="crm-button-ghost crm-detail-floating-button" data-action="navigate-lead" data-direction="prev" ${previousLead ? '' : 'disabled'}>
                    <span class="crm-detail-floating-icon"><i class="fa-solid fa-chevron-left"></i></span>
                    <span>Previous</span>
                </button>
                <button class="crm-button-ghost crm-detail-floating-button" data-action="navigate-lead" data-direction="next" ${nextLead ? '' : 'disabled'}>
                    <span>Next</span>
                    <span class="crm-detail-floating-icon"><i class="fa-solid fa-chevron-right"></i></span>
                </button>
            </div>
        </div>
    `;
}

function renderPanels() {
    persistWorkspaceUiState();
    if (state.currentView !== 'email') {
        clearEmailWorkspaceAutoRefresh();
    }
    const shouldRestoreAdvancedMenuScroll = state.filtersPanelOpen;
    const advancedMenuScrollTop = shouldRestoreAdvancedMenuScroll
        ? (document.querySelector('.lead-history-advanced-menu-scroll')?.scrollTop || 0)
        : 0;

    const panelStates = new Map([
        [refs.overviewPanel, state.currentView === 'overview'],
        [refs.calendarPanel, state.currentView === 'calendar'],
        [refs.emailPanel, state.currentView === 'email'],
        [refs.clientsPanel, isLeadsWorkspaceView(state.currentView)],
        [refs.membersPanel, state.currentView === 'members'],
        [refs.adminPanel, state.currentView === 'admin'],
        [refs.leadDetailPanel, state.currentView === 'lead-detail'],
        [refs.importsPanel, state.currentView === 'imports'],
        [refs.settingsPanel, state.currentView === 'settings']
    ]);

    panelStates.forEach((isActive, panel) => {
        panel.classList.toggle('hidden', !isActive);

        if (!isActive && panel.innerHTML) {
            panel.innerHTML = '';
        }
    });

    if (state.currentView === 'overview') {
        refs.overviewPanel.innerHTML = renderOverviewPanel();
    }

    if (state.currentView === 'calendar') {
        refs.calendarPanel.innerHTML = renderCalendarPage();
    }

    if (state.currentView === 'email') {
        refs.emailPanel.innerHTML = renderEmailWorkspacePage();
    }

    if (isLeadsWorkspaceView(state.currentView)) {
        refs.clientsPanel.innerHTML = renderClientsPanel('leads');
    }

    if (state.currentView === 'members') {
        refs.membersPanel.innerHTML = renderClientsPanel('members');
    }

    if (state.currentView === 'admin') {
        refs.adminPanel.innerHTML = renderAdminPanel();
    }

    if (state.currentView === 'lead-detail') {
        refs.leadDetailPanel.innerHTML = renderLeadDetailPage();
    }

    if (state.currentView === 'imports') {
        refs.importsPanel.innerHTML = renderImportsPanel();
    }

    if (state.currentView === 'settings') {
        refs.settingsPanel.innerHTML = renderSettingsPanel();
    }

    if (shouldRestoreAdvancedMenuScroll) {
        requestAnimationFrame(() => {
            const menuScroll = document.querySelector('.lead-history-advanced-menu-scroll');
            if (menuScroll) {
                menuScroll.scrollTop = advancedMenuScrollTop;
            }
        });
    }
}

function renderOverviewPanel() {
    if (state.isLoading) {
        return renderLoadingState('Loading workspace overview...');
    }

    if (!state.clients.length && !getWorkspaceSummaryCount('leads') && !getWorkspaceSummaryCount('members')) {
        return renderEmptyState({
            title: 'No leads yet',
            copy: 'Upload a CSV or create a lead manually to start filling the workspace.',
            actions: `
                ${hasPermission(state.session, PERMISSIONS.IMPORT_LEADS) ? '<button class="crm-button-secondary" data-action="open-import"><i class="fa-solid fa-file-arrow-up"></i> Upload Leads</button>' : ''}
                <button class="crm-button-ghost" data-action="new-client"><i class="fa-solid fa-user-plus"></i> New Lead</button>
            `
        });
    }

    const metrics = getDashboardMetrics();

    return `
        <div class="ov-page">
            <section class="ov-hero">
                <div class="ov-hero-inner">
                    <span class="ov-hero-label">Workspace Overview</span>
                    <h1>CRM <em>Overview</em></h1>
                    <div class="ov-feature">
                        <span class="ov-feature-label">Active Leads</span>
                        <div class="ov-feature-number">${metrics.totalLeads.toLocaleString()}</div>
                    </div>
                </div>
            </section>

            <hr class="ov-divider">

            <div class="ov-container">
                <div class="ov-stat-grid">
                    <article class="ov-stat-tile" id="ov-stat-leads">
                        <div class="ov-stat-tile-label">Total Leads</div>
                        <div class="ov-stat-tile-value">${metrics.totalLeads.toLocaleString()}</div>
                    </article>
                    <article class="ov-stat-tile" id="ov-stat-members">
                        <div class="ov-stat-tile-label">Members</div>
                        <div class="ov-stat-tile-value">${metrics.totalMembers.toLocaleString()}</div>
                    </article>
                    <article class="ov-stat-tile" id="ov-stat-status">
                        <div class="ov-stat-tile-label">Top Status</div>
                        <div class="ov-stat-tile-value">${metrics.topStatus.count.toLocaleString()}</div>
                        ${metrics.topStatus.label ? `<div class="ov-stat-tile-sub">${escapeHtml(metrics.topStatus.label)}</div>` : ''}
                    </article>
                    <article class="ov-stat-tile" id="ov-stat-tag">
                        <div class="ov-stat-tile-label">Top Tag</div>
                        <div class="ov-stat-tile-value">${metrics.topTag.count.toLocaleString()}</div>
                        ${metrics.topTag.label ? `<div class="ov-stat-tile-sub">${escapeHtml(metrics.topTag.label)}</div>` : ''}
                    </article>
                </div>

                <div class="ov-insight-row">
                    <div class="ov-insight-mini">
                        <div class="ov-insight-label">Member Share</div>
                        <div class="ov-insight-value">${metrics.memberShare}%</div>
                        <div class="ov-progress-track"><span class="ov-progress-fill" style="width:${metrics.memberShare}%"></span></div>
                    </div>
                    <div class="ov-insight-mini">
                        <div class="ov-insight-label">Statuses Tracked</div>
                        <div class="ov-insight-value">${metrics.statusCounts.length}</div>
                    </div>
                    <div class="ov-insight-mini">
                        <div class="ov-insight-label">Tagged Leads</div>
                        <div class="ov-insight-value">${metrics.taggedLeadCount.toLocaleString()}</div>
                    </div>
                </div>

                <div class="ov-card-grid">
                    <section class="ov-card">
                        <h3 class="ov-card-title"><i class="fa-solid fa-chart-simple"></i> Pipeline Snapshot</h3>
                        <ul class="ov-status-list">
                            ${metrics.statusCounts.map(([status, count]) => `
                                <li>
                                    <span class="status-pill ${escapeHtml(status)}">${escapeHtml(titleCase(status))}</span>
                                    <strong>${count.toLocaleString()}</strong>
                                </li>
                            `).join('')}
                        </ul>
                    </section>

                    <section class="ov-card">
                        <h3 class="ov-card-title"><i class="fa-solid fa-clock-rotate-left"></i> Recently Updated</h3>
                        ${metrics.recentlyUpdated.length ? `
                            <ul class="ov-activity-list">
                                ${metrics.recentlyUpdated.map((client) => `
                                    <li>
                                        <div class="ov-activity-main">
                                            <span class="ov-activity-title">${escapeHtml(client.fullName || 'Unnamed lead')}</span>
                                            <span class="ov-activity-meta">${client.email ? renderEmailLink(client.email, {
                                                placeholder: 'No contact info',
                                                clientId: client.id,
                                                recipientName: client.fullName || client.firstName || client.lastName || ''
                                            }) : renderPhoneLink(client.phone, { placeholder: 'No contact info' })}</span>
                                        </div>
                                        <span class="ov-meta-chip">${escapeHtml(formatDateTime(client.updatedAt))}</span>
                                    </li>
                                `).join('')}
                            </ul>
                        ` : '<div class="ov-card-empty">No recent lead activity yet.</div>'}
                    </section>

                    <section class="ov-card ov-card-wide">
                        <h3 class="ov-card-title"><i class="fa-solid fa-tags"></i> Tags In Rotation</h3>
                        <div class="ov-tag-cloud">
                            ${metrics.tagCounts.slice(0, 10).map(([tag, count]) => `
                                <span class="ov-tag-chip"><strong>${escapeHtml(tag)}</strong> ${count.toLocaleString()}</span>
                            `).join('') || '<span class="ov-card-empty">Tag data will appear here.</span>'}
                        </div>
                    </section>
                </div>
            </div>
        </div>
    `;
}

function renderCalendarPage() {
    const filteredEvents = getVisibleCalendarEvents();
    const selectedDate = getCalendarSelectedDate();
    const selectedDateKey = getDateKey(selectedDate);
    const monthDate = getMonthCursorDate();
    const selectedDateEvents = getCalendarEventsForDate(selectedDateKey, filteredEvents);
    const calendarTitle = state.calendar.view === 'month'
        ? formatCalendarStageMonthLabel(monthDate)
        : formatCalendarWeekRangeLabel(selectedDate);
    const inlineFilterButtons = [
        renderCalendarFilterButton('mine', 'Mine'),
        renderCalendarFilterButton('shared', 'Shared'),
        hasActiveAdminProfile() ? renderCalendarFilterButton('all', 'All') : ''
    ].filter(Boolean).join('');

    return `
        <div class="calendar-shell">
            <aside class="calendar-sidebar-rail">
                <button class="calendar-compose-button" type="button" data-action="open-calendar-event-drawer">
                    <i class="fa-solid fa-plus"></i>
                    <span>Schedule</span>
                </button>

                <div class="calendar-mini-card">
                    <div class="calendar-mini-toolbar">
                        <button class="calendar-mini-nav" type="button" data-action="calendar-prev-mini-month" aria-label="Previous mini month">
                            <i class="fa-solid fa-chevron-left"></i>
                        </button>
                        <div class="calendar-mini-label">${escapeHtml(formatCalendarMonthLabel(monthDate))}</div>
                        <button class="calendar-mini-nav" type="button" data-action="calendar-next-mini-month" aria-label="Next mini month">
                            <i class="fa-solid fa-chevron-right"></i>
                        </button>
                    </div>
                    <div class="calendar-mini-weekdays">
                        ${CALENDAR_DAY_LABELS.map((label) => `<span>${escapeHtml(label.slice(0, 1))}</span>`).join('')}
                    </div>
                    <div class="calendar-mini-grid">
                        ${buildCalendarGridDates(monthDate).map((day) => renderCalendarMiniDayCell(day, monthDate, filteredEvents)).join('')}
                    </div>
                </div>

                <div class="calendar-sidebar-events">
                    ${selectedDateEvents.length
                        ? selectedDateEvents.slice(0, 5).map((event) => renderCalendarCompactEvent(event)).join('')
                        : `
                            <button
                                class="calendar-empty-chip"
                                type="button"
                                data-action="open-calendar-event-drawer"
                                data-date="${escapeHtml(selectedDateKey)}"
                            >
                                <i class="fa-solid fa-calendar-plus"></i>
                                <span>${escapeHtml(formatCalendarFullDate(selectedDate))}</span>
                            </button>
                        `}
                </div>
            </aside>

            <section class="calendar-stage">
                <div class="calendar-stage-toolbar">
                    <div class="calendar-stage-toolbar-left">
                        <button class="calendar-toolbar-button" type="button" data-action="calendar-today">Today</button>
                        <div class="calendar-period-nav">
                            <button class="calendar-icon-button" type="button" data-action="calendar-prev-period" aria-label="Previous">
                                <i class="fa-solid fa-chevron-left"></i>
                            </button>
                            <button class="calendar-icon-button" type="button" data-action="calendar-next-period" aria-label="Next">
                                <i class="fa-solid fa-chevron-right"></i>
                            </button>
                        </div>
                        <div class="calendar-stage-title">${escapeHtml(calendarTitle)}</div>
                    </div>

                    <div class="calendar-stage-toolbar-right">
                        <div class="calendar-inline-filters" role="tablist" aria-label="Calendar visibility filter">
                            ${inlineFilterButtons}
                        </div>
                        <div class="calendar-view-switch" role="tablist" aria-label="Calendar view">
                            <button class="calendar-view-button ${state.calendar.view === 'week' ? 'active' : ''}" type="button" data-action="set-calendar-view" data-view="week">Week</button>
                            <button class="calendar-view-button ${state.calendar.view === 'month' ? 'active' : ''}" type="button" data-action="set-calendar-view" data-view="month">Month</button>
                        </div>
                    </div>
                </div>

                ${state.calendar.isLoading && !filteredEvents.length
                    ? renderLoadingState('Loading calendar events...')
                    : (state.calendar.view === 'month'
                        ? renderCalendarMonthStage(monthDate, filteredEvents)
                        : renderCalendarWeekView(selectedDate, filteredEvents))}
            </section>
        </div>
    `;
}

function renderCalendarFilterButton(filterValue, label) {
    const isActive = state.calendar.filter === filterValue;
    return `
        <button
            class="calendar-filter-chip ${isActive ? 'active' : ''}"
            type="button"
            data-action="set-calendar-filter"
            data-filter="${escapeHtml(filterValue)}"
            aria-pressed="${isActive ? 'true' : 'false'}"
        >
            ${escapeHtml(label)}
        </button>
    `;
}

function renderCalendarDayCell(day, monthDate, events = []) {
    const dateKey = getDateKey(day);
    const dayEvents = getCalendarEventsForDate(dateKey, events);
    const hiddenCount = Math.max(dayEvents.length - 3, 0);
    const isTodayCell = getDateKey(new Date()) === dateKey;
    const isSelected = state.calendar.selectedDate === dateKey;
    const isOutsideMonth = day.getMonth() !== monthDate.getMonth();

    return `
        <div
            class="calendar-day-cell ${isTodayCell ? 'today' : ''} ${isSelected ? 'selected' : ''} ${isOutsideMonth ? 'outside-month' : ''}"
            data-action="select-calendar-date"
            data-date="${escapeHtml(dateKey)}"
        >
            <div class="calendar-day-head">
                <span class="calendar-day-number">${day.getDate()}</span>
                <span class="calendar-day-count">${dayEvents.length ? `${dayEvents.length} event${dayEvents.length === 1 ? '' : 's'}` : ''}</span>
            </div>

            <div class="calendar-day-events">
                ${dayEvents.slice(0, 3).map((event) => `
                    <button
                        class="calendar-day-event ${escapeHtml(event.status)}"
                        type="button"
                        data-action="open-calendar-event-drawer"
                        data-event-id="${escapeHtml(event.id)}"
                    >
                        <span>${escapeHtml(formatCalendarTime(event.startAt))}</span>
                        <strong>${escapeHtml(truncate(event.title, 28))}</strong>
                    </button>
                `).join('')}
                ${hiddenCount ? `<div class="calendar-day-more">+${hiddenCount} more</div>` : ''}
            </div>
        </div>
    `;
}

function renderCalendarEventList(events = [], { emptyCopy = 'No follow-ups available.', showLeadName = true } = {}) {
    if (!events.length) {
        return `<div class="calendar-empty-state">${escapeHtml(emptyCopy)}</div>`;
    }

    return `
        <div class="calendar-event-list">
            ${events.map((event) => renderCalendarEventCard(event, { showLeadName })).join('')}
        </div>
    `;
}

function renderCalendarEventCard(event, { showLeadName = true } = {}) {
    const canManage = canManageCalendarEvent(event);
    const accessibleLead = getAccessibleClientById(event.leadId);
    const detailLine = [
        formatCalendarEventStamp(event),
        event.eventTimeZone || 'Unknown',
        event.ownerName ? `Owner: ${event.ownerName}` : '',
        event.visibility === 'shared'
            ? `Shared${event.sharedWithUsers?.length ? ` with ${event.sharedWithUsers.length}` : ''}`
            : 'Private'
    ].filter(Boolean).join(' · ');
    const summaryCopy = normalizeWhitespace(event.actionText || event.notes || '');

    return `
        <article class="calendar-event-card ${escapeHtml(event.status)}">
            <div class="calendar-event-head">
                <div>
                    <div class="calendar-event-badges">
                        <span class="calendar-status-pill ${escapeHtml(event.status)}">${escapeHtml(titleCase(event.status))}</span>
                        <span class="calendar-visibility-pill ${escapeHtml(event.visibility)}">${escapeHtml(titleCase(event.visibility))}</span>
                    </div>
                    <h3>${escapeHtml(event.title)}</h3>
                    ${showLeadName && event.leadName ? `<div class="calendar-event-lead">${escapeHtml(event.leadName)}</div>` : ''}
                    ${summaryCopy ? `<p>${escapeHtml(truncate(summaryCopy, 160))}</p>` : ''}
                </div>
                <button
                    class="crm-button-ghost"
                    type="button"
                    data-action="open-calendar-event-drawer"
                    data-event-id="${escapeHtml(event.id)}"
                >
                    <i class="fa-solid fa-arrow-up-right-from-square"></i> Open
                </button>
            </div>

            <div class="calendar-event-meta">${escapeHtml(detailLine)}</div>

            <div class="calendar-event-actions">
                ${accessibleLead ? `
                    <button
                        class="crm-button-ghost"
                        type="button"
                        data-action="open-lead-page"
                        data-client-id="${escapeHtml(accessibleLead.id)}"
                    >
                        <i class="fa-solid fa-user-large"></i> Open Client
                    </button>
                ` : ''}
                ${renderCalendarStatusActions(event, canManage)}
            </div>
        </article>
    `;
}

function renderCalendarStatusActions(event, canManage) {
    if (!canManage) {
        return '';
    }

    if (event.status === 'scheduled') {
        return `
            <button class="crm-button-secondary" type="button" data-action="set-calendar-event-status" data-event-id="${escapeHtml(event.id)}" data-status="completed">
                <i class="fa-solid fa-check"></i> Complete
            </button>
            <button class="crm-button-ghost" type="button" data-action="set-calendar-event-status" data-event-id="${escapeHtml(event.id)}" data-status="canceled">
                <i class="fa-solid fa-ban"></i> Cancel
            </button>
            ${Date.parse(event.startAt || 0) < Date.now() ? `
                <button class="crm-button-ghost" type="button" data-action="set-calendar-event-status" data-event-id="${escapeHtml(event.id)}" data-status="missed">
                    <i class="fa-solid fa-clock-rotate-left"></i> Mark Missed
                </button>
            ` : ''}
        `;
    }

    return `
        <button class="crm-button-secondary" type="button" data-action="open-calendar-event-drawer" data-event-id="${escapeHtml(event.id)}">
            <i class="fa-solid fa-pen"></i> Edit
        </button>
        <button class="crm-button-ghost" type="button" data-action="set-calendar-event-status" data-event-id="${escapeHtml(event.id)}" data-status="scheduled">
            <i class="fa-solid fa-rotate-right"></i> Reopen
        </button>
    `;
}

function renderCalendarCompactEvent(event) {
    return `
        <button
            class="calendar-sidebar-event ${escapeHtml(event.status)}"
            type="button"
            data-action="open-calendar-event-drawer"
            data-event-id="${escapeHtml(event.id)}"
        >
            <span>${escapeHtml(formatCalendarTime(event.startAt))}</span>
            <strong>${escapeHtml(truncate(event.title, 32))}</strong>
            ${event.leadName ? `<small>${escapeHtml(truncate(event.leadName, 30))}</small>` : ''}
        </button>
    `;
}

function renderCalendarMiniDayCell(day, monthDate, events = []) {
    const dateKey = getDateKey(day);
    const dayEvents = getCalendarEventsForDate(dateKey, events);
    const isSelected = state.calendar.selectedDate === dateKey;
    const isTodayCell = getDateKey(new Date()) === dateKey;
    const isOutsideMonth = day.getMonth() !== monthDate.getMonth();

    return `
        <button
            class="calendar-mini-day ${isSelected ? 'selected' : ''} ${isTodayCell ? 'today' : ''} ${isOutsideMonth ? 'outside-month' : ''}"
            type="button"
            data-action="select-calendar-date"
            data-date="${escapeHtml(dateKey)}"
            aria-label="${escapeHtml(formatCalendarFullDate(day))}"
        >
            <span>${day.getDate()}</span>
            ${dayEvents.length ? '<i class="calendar-mini-day-dot"></i>' : ''}
        </button>
    `;
}

function renderCalendarWeekView(selectedDate, events = []) {
    const weekDates = buildCalendarWeekDates(selectedDate);

    return `
        <div class="calendar-week-shell">
            <div class="calendar-week-head">
                <div class="calendar-week-offset">${escapeHtml(formatCalendarUtcOffset())}</div>
                ${weekDates.map((day) => {
                    const dateKey = getDateKey(day);
                    const isSelected = state.calendar.selectedDate === dateKey;
                    return `
                        <button
                            class="calendar-week-day ${isSelected ? 'selected' : ''}"
                            type="button"
                            data-action="select-calendar-date"
                            data-date="${escapeHtml(dateKey)}"
                        >
                            <span>${escapeHtml(new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(day).toUpperCase())}</span>
                            <strong>${day.getDate()}</strong>
                        </button>
                    `;
                }).join('')}
            </div>

            <div class="calendar-week-body">
                <div class="calendar-week-hours">
                    ${Array.from({ length: 24 }, (_value, hour) => `
                        <div class="calendar-hour-label">${escapeHtml(formatCalendarHourLabel(hour))}</div>
                    `).join('')}
                </div>

                <div class="calendar-week-columns">
                    ${weekDates.map((day) => renderCalendarWeekColumn(day, getCalendarEventsForDate(getDateKey(day), events))).join('')}
                </div>
            </div>
        </div>
    `;
}

function renderCalendarWeekColumn(day, events = []) {
    const layouts = buildCalendarWeekEventLayouts(events);
    const isTodayColumn = getDateKey(new Date()) === getDateKey(day);

    return `
        <div class="calendar-week-column ${isTodayColumn ? 'today' : ''}">
            ${Array.from({ length: 24 }, () => '<div class="calendar-week-slot"></div>').join('')}
            ${layouts.map((layout) => renderCalendarWeekEventBlock(layout)).join('')}
        </div>
    `;
}

function renderCalendarWeekEventBlock(layout) {
    const width = 100 / Math.max(layout.columnCount, 1);
    const left = layout.columnIndex * width;
    return `
        <button
            class="calendar-week-event ${escapeHtml(layout.event.status)}"
            type="button"
            data-action="open-calendar-event-drawer"
            data-event-id="${escapeHtml(layout.event.id)}"
            style="--calendar-event-top:${layout.top}px; --calendar-event-height:${layout.height}px; --calendar-event-left:${left}%; --calendar-event-width:${width}%;"
        >
            <span>${escapeHtml(formatCalendarTime(layout.event.startAt))}</span>
            <strong>${escapeHtml(truncate(layout.event.title, 24))}</strong>
            ${layout.event.leadName ? `<small>${escapeHtml(truncate(layout.event.leadName, 22))}</small>` : ''}
        </button>
    `;
}

function renderCalendarMonthStage(monthDate, events = []) {
    return `
        <div class="calendar-month-stage">
            ${CALENDAR_DAY_LABELS.map((label) => `<div class="calendar-month-weekday">${escapeHtml(label)}</div>`).join('')}
            ${buildCalendarGridDates(monthDate).map((day) => renderCalendarMonthCell(day, monthDate, events)).join('')}
        </div>
    `;
}

function renderCalendarMonthCell(day, monthDate, events = []) {
    const dateKey = getDateKey(day);
    const dayEvents = getCalendarEventsForDate(dateKey, events);
    const isSelected = state.calendar.selectedDate === dateKey;
    const isTodayCell = getDateKey(new Date()) === dateKey;
    const isOutsideMonth = day.getMonth() !== monthDate.getMonth();

    return `
        <div
            class="calendar-month-cell ${isSelected ? 'selected' : ''} ${isTodayCell ? 'today' : ''} ${isOutsideMonth ? 'outside-month' : ''}"
            data-action="select-calendar-date"
            data-date="${escapeHtml(dateKey)}"
        >
            <div class="calendar-month-number">${day.getDate()}</div>
            <div class="calendar-month-events">
                ${dayEvents.slice(0, 4).map((event) => `
                    <button
                        class="calendar-month-event ${escapeHtml(event.status)}"
                        type="button"
                        data-action="open-calendar-event-drawer"
                        data-event-id="${escapeHtml(event.id)}"
                    >
                        <span>${escapeHtml(formatCalendarTime(event.startAt))}</span>
                        <strong>${escapeHtml(truncate(event.title, 24))}</strong>
                    </button>
                `).join('')}
                ${dayEvents.length > 4 ? `<div class="calendar-month-more">+${dayEvents.length - 4}</div>` : ''}
            </div>
        </div>
    `;
}

function getCalendarSelectedDate() {
    return parseDateKey(state.calendar.selectedDate || getDateKey(new Date()));
}

function buildCalendarWeekDates(anchorDate = getCalendarSelectedDate()) {
    const selectedDate = anchorDate instanceof Date ? anchorDate : new Date(anchorDate);
    const weekStart = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() - selectedDate.getDay(), 12);
    return Array.from({ length: 7 }, (_value, index) => new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + index, 12));
}

function formatCalendarWeekRangeLabel(anchorDate = getCalendarSelectedDate()) {
    const weekDates = buildCalendarWeekDates(anchorDate);
    const firstDay = weekDates[0];
    const lastDay = weekDates[weekDates.length - 1];

    if (firstDay.getMonth() === lastDay.getMonth()) {
        return `${new Intl.DateTimeFormat('en-US', { month: 'long' }).format(firstDay)} ${firstDay.getDate()}-${lastDay.getDate()}`;
    }

    return `${new Intl.DateTimeFormat('en-US', { month: 'short' }).format(firstDay)} ${firstDay.getDate()} - ${new Intl.DateTimeFormat('en-US', { month: 'short' }).format(lastDay)} ${lastDay.getDate()}`;
}

function formatCalendarHourLabel(hour) {
    const date = new Date(2026, 0, 1, hour, 0, 0, 0);
    return new Intl.DateTimeFormat('en-US', {
        hour: 'numeric'
    }).format(date);
}

function formatCalendarUtcOffset() {
    const offsetMinutes = -new Date().getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0');
    const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, '0');
    return `GMT${sign}${hours}${minutes === '00' ? '' : `:${minutes}`}`;
}

function getCalendarEventStartMinutes(event) {
    const startDate = new Date(event.startAt);

    if (Number.isNaN(startDate.getTime())) {
        return 0;
    }

    return (startDate.getHours() * 60) + startDate.getMinutes();
}

function getCalendarEventEndMinutes(event) {
    const endDate = new Date(event.endAt || '');

    if (!Number.isNaN(endDate.getTime())) {
        return (endDate.getHours() * 60) + endDate.getMinutes();
    }

    return Math.min(getCalendarEventStartMinutes(event) + 45, 24 * 60);
}

function buildCalendarWeekEventLayouts(events = []) {
    const hourHeight = 56;
    const layouts = [];
    const activeLayouts = [];

    [...events]
        .filter((event) => normalizeWhitespace(event.status) !== 'canceled')
        .sort((left, right) => Date.parse(left.startAt || 0) - Date.parse(right.startAt || 0))
        .forEach((event) => {
            const startMinutes = getCalendarEventStartMinutes(event);
            const endMinutes = Math.max(getCalendarEventEndMinutes(event), startMinutes + 30);

            for (let index = activeLayouts.length - 1; index >= 0; index -= 1) {
                if (activeLayouts[index].endMinutes <= startMinutes) {
                    activeLayouts.splice(index, 1);
                }
            }

            const usedColumns = new Set(activeLayouts.map((layout) => layout.columnIndex));
            let columnIndex = 0;
            while (usedColumns.has(columnIndex)) {
                columnIndex += 1;
            }

            const layout = {
                event,
                startMinutes,
                endMinutes,
                columnIndex,
                columnCount: 1,
                top: (startMinutes / 60) * hourHeight,
                height: Math.max(((endMinutes - startMinutes) / 60) * hourHeight, 28)
            };

            activeLayouts.push(layout);
            layouts.push(layout);
        });

    layouts.forEach((layout) => {
        const overlappingLayouts = layouts.filter((candidate) =>
            candidate.startMinutes < layout.endMinutes && candidate.endMinutes > layout.startMinutes
        );
        layout.columnCount = Math.max(1, ...overlappingLayouts.map((candidate) => candidate.columnIndex + 1));
    });

    return layouts;
}

function getVisibleCalendarEvents() {
    const allEvents = Array.isArray(state.calendar.events) ? [...state.calendar.events] : [];

    return allEvents
        .filter((event) => {
            if (state.calendar.filter === 'mine') {
                return event.ownerUserId === state.session?.id;
            }

            if (state.calendar.filter === 'shared') {
                return event.ownerUserId !== state.session?.id && Array.isArray(event.sharedWithUserIds)
                    && event.sharedWithUserIds.includes(state.session?.id);
            }

            return true;
        })
        .sort((left, right) => Date.parse(left.startAt || 0) - Date.parse(right.startAt || 0));
}

function getCalendarEventsForDate(dateKey, events = getVisibleCalendarEvents()) {
    return [...(events || [])]
        .filter((event) => getDateKey(event.startAt) === dateKey)
        .sort((left, right) => Date.parse(left.startAt || 0) - Date.parse(right.startAt || 0));
}

function getCalendarFilterLabel(filterValue) {
    if (filterValue === 'shared') {
        return 'Shared with me';
    }

    if (filterValue === 'all') {
        return 'All visible events';
    }

    return 'My follow-ups';
}

function getCalendarEventById(eventId) {
    const normalizedEventId = normalizeWhitespace(eventId);

    if (!normalizedEventId) {
        return null;
    }

    const leadEventCollections = Object.values(state.calendar.leadEventsByLeadId || {});
    return [...(state.calendar.events || []), ...leadEventCollections.flat()]
        .find((event) => event.id === normalizedEventId) || null;
}

function canManageCalendarEvent(event) {
    if (!event) {
        return false;
    }

    return hasActiveAdminProfile() || event.ownerUserId === state.session?.id;
}

function buildCalendarGridDates(monthDate) {
    const firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1, 12);
    const lastDay = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0, 12);
    const gridStart = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() - firstDay.getDay(), 12);
    const trailingDays = 6 - lastDay.getDay();
    const gridEnd = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + trailingDays, 12);
    const days = [];

    for (let cursor = new Date(gridStart); cursor <= gridEnd; cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 12)) {
        days.push(new Date(cursor));
    }

    return days;
}

function getMonthCursorDate(value = state.calendar.monthCursor) {
    const cursor = value ? new Date(value) : new Date();

    if (Number.isNaN(cursor.getTime())) {
        return new Date(new Date().getFullYear(), new Date().getMonth(), 1, 12);
    }

    return new Date(cursor.getFullYear(), cursor.getMonth(), 1, 12);
}

function getMonthCursorValue(value = new Date()) {
    const monthDate = value instanceof Date ? value : new Date(value);
    return new Date(monthDate.getFullYear(), monthDate.getMonth(), 1, 12).toISOString();
}

function getDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        return '';
    }

    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-');
}

function parseDateKey(dateKey) {
    const [year, month, day] = String(dateKey || '').split('-').map((part) => Number(part));

    if (!year || !month || !day) {
        return new Date();
    }

    return new Date(year, month - 1, day, 12);
}

function isSameCalendarMonth(value, monthDate) {
    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        return false;
    }

    return date.getFullYear() === monthDate.getFullYear() && date.getMonth() === monthDate.getMonth();
}

function formatCalendarMonthLabel(value) {
    return new Intl.DateTimeFormat('en-US', {
        month: 'long',
        year: 'numeric'
    }).format(value instanceof Date ? value : new Date(value));
}

function formatCalendarStageMonthLabel(value) {
    return new Intl.DateTimeFormat('en-US', {
        month: 'long'
    }).format(value instanceof Date ? value : new Date(value));
}

function formatCalendarFullDate(value) {
    return new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
    }).format(value instanceof Date ? value : new Date(value));
}

function formatCalendarTime(value) {
    return new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit'
    }).format(new Date(value));
}

function formatCalendarEventStamp(event) {
    const startAt = Date.parse(event.startAt || 0);
    const endAt = Date.parse(event.endAt || 0);

    if (!startAt) {
        return 'Time unavailable';
    }

    if (!endAt) {
        return `${formatDate(event.startAt)} · ${formatCalendarTime(event.startAt)}`;
    }

    return `${formatDate(event.startAt)} · ${formatCalendarTime(event.startAt)}-${formatCalendarTime(event.endAt)}`;
}

function formatCalendarShortStamp(value) {
    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    }).format(new Date(value));
}

function renderClientsPanel(scope = 'leads') {
    const workspace = getWorkspaceResult(scope);
    const usingServerPaging = supportsServerWorkspacePaging();
    const loadingLabel = scope === 'members'
        ? 'members'
        : (isAssignedLeadsView() ? 'assigned leads' : (hasPermission(state.session, PERMISSIONS.ASSIGN_LEADS) ? 'unassigned leads' : 'leads'));

    if (state.isLoading || (usingServerPaging && workspace.isLoading && !workspace.loaded)) {
        return renderLoadingState(`Loading ${loadingLabel}...`);
    }

    const visibleClients = usingServerPaging ? workspace.rows : getVisibleClients(scope);
    const paginatedClients = usingServerPaging ? workspace.rows : getPaginatedClients(visibleClients);
    const totalVisibleCount = usingServerPaging ? workspace.totalCount : visibleClients.length;
    const totalPages = Math.max(1, Math.ceil(totalVisibleCount / state.pageSize));
    const pageStart = totalVisibleCount && paginatedClients.length ? ((state.page - 1) * state.pageSize) + 1 : 0;
    const pageEnd = totalVisibleCount && paginatedClients.length ? Math.min((state.page - 1) * state.pageSize + paginatedClients.length, totalVisibleCount) : 0;
    const activeFilterCount = getActiveFilterCount();
    const savedFilters = getVisibleSavedFilters();
    const activeSavedFilter = state.savedFilters.find((filter) => filter.id === state.activeSavedFilterId) || null;
    const canBulkAssign = scope === 'leads'
        && hasPermission(state.session, PERMISSIONS.ASSIGN_LEADS)
        && !isAssignedLeadsView();
    const selectableClients = canBulkAssign ? getUnassignedLeadRows(paginatedClients) : paginatedClients;
    const selectedLeadIds = new Set(state.selectedLeadIds);
    const allPageSelected = canBulkAssign
        && Boolean(selectableClients.length)
        && selectableClients.every((client) => selectedLeadIds.has(client.id));
    const selectedCount = state.selectedLeadIds.length;

    return renderLeadHistoryPanel({
        scope,
        paginatedClients,
        totalVisibleCount,
        totalPages,
        pageStart,
        pageEnd,
        activeFilterCount,
        savedFilters,
        activeSavedFilter,
        canBulkAssign,
        selectedLeadIds,
        allPageSelected,
        selectedCount
    });
}

function renderLeadHistoryPanel({
    scope = 'leads',
    paginatedClients,
    totalVisibleCount,
    totalPages,
    pageStart,
    pageEnd,
    activeFilterCount,
    savedFilters,
    activeSavedFilter,
    canBulkAssign,
    selectedLeadIds,
    allPageSelected,
    selectedCount
}) {
    const isMembers = scope === 'members';
    const isAssignedLeadsPage = scope === 'leads' && isAssignedLeadsView();
    const workspaceLabel = isMembers
        ? 'Members'
        : (isAssignedLeadsPage ? 'Already Assigned Leads' : (hasPermission(state.session, PERMISSIONS.ASSIGN_LEADS) ? 'Unassigned Leads' : 'Leads'));
    const workspaceLabelLower = workspaceLabel.toLowerCase();
    const singularLabel = isMembers ? 'member' : 'lead';
    const statusOptions = CRM_STATUS_OPTIONS;
    const availableTags = getAvailableTags();
    const createAction = renderWorkspaceCreateAction(scope, 'toolbar');
    const assignmentViewAction = renderLeadAssignmentViewAction(scope);
    const emptyCreateAction = renderWorkspaceCreateAction(scope, 'empty');
    const tableDescription = isAssignedLeadsPage
        ? 'Reference view for leads that already belong to a rep. Open any record from here when you need to review ownership.'
        : (hasPermission(state.session, PERMISSIONS.ASSIGN_LEADS)
            ? 'Only unassigned leads stay in this queue so assignment stays clean and intentional.'
            : '');
    const searchSummary = normalizeWhitespace(state.workspaceSearch)
        ? `${totalVisibleCount.toLocaleString()} matching ${workspaceLabelLower} for "${escapeHtml(state.workspaceSearch)}".`
        : `${totalVisibleCount.toLocaleString()} ${workspaceLabelLower} currently in the CRM workspace.`;
    const heroBadge = activeFilterCount
        ? `${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} active`
        : `${totalVisibleCount.toLocaleString()} visible`;

    return `
        <div class="lead-history-page">
            <section class="lead-history-hero">
                <div class="lead-history-hero-left">
                    <div class="lead-history-scope-switch" role="tablist" aria-label="CRM workspace">
                        <button
                            class="lead-history-scope-btn ${isMembers ? '' : 'active'}"
                            data-action="set-view"
                            data-view="clients"
                            aria-pressed="${isMembers ? 'false' : 'true'}"
                        >
                            Leads
                        </button>
                        <button
                            class="lead-history-scope-btn ${isMembers ? 'active' : ''}"
                            data-action="set-view"
                            data-view="members"
                            aria-pressed="${isMembers ? 'true' : 'false'}"
                        >
                            Members
                        </button>
                    </div>
                </div>
                <span class="lead-history-hero-badge">${heroBadge}</span>
            </section>

            <section class="lead-history-filters">
                <div class="lead-history-filter-group">
                    <span class="lead-history-filter-label">Status</span>
                    <select id="status-filter" class="lead-history-select lead-history-toolbar-select">
                        <option value="all">All statuses</option>
                        ${statusOptions.map((status) => `
                            <option value="${status}" ${state.filters.status === status ? 'selected' : ''}>${escapeHtml(titleCase(status))}</option>
                        `).join('')}
                    </select>
                </div>

                <div class="lead-history-filter-divider"></div>

                <div class="lead-history-filter-group">
                    <span class="lead-history-filter-label">Tag</span>
                    <select id="tag-filter" class="lead-history-select lead-history-toolbar-select">
                        <option value="all">All tags</option>
                        ${availableTags.map((tag) => `
                            <option value="${escapeHtml(tag)}" ${state.filters.tag === tag ? 'selected' : ''}>${escapeHtml(tag)}</option>
                        `).join('')}
                    </select>
                </div>

                <div class="lead-history-filter-divider"></div>

                <div class="lead-history-filter-group lead-history-filter-group-saved">
                    <span class="lead-history-filter-label">Saved</span>
                    ${savedFilters.length ? savedFilters.slice(0, 4).map((filter) => `
                        <button
                            class="lead-history-pill ${state.activeSavedFilterId === filter.id ? 'active' : ''}"
                            data-action="load-saved-filter"
                            data-filter-id="${filter.id}"
                        >
                            ${escapeHtml(truncate(filter.name, 22))}
                        </button>
                    `).join('') : '<span class="lead-history-filter-empty">No saved views</span>'}
                    ${savedFilters.length > 4 ? `<span class="lead-history-filter-empty">+${savedFilters.length - 4} more</span>` : ''}
                </div>

                <div class="lead-history-advanced-shell ${state.filtersPanelOpen ? 'open' : ''}">
                    <button
                        class="lead-history-clear-btn"
                        data-action="open-filters"
                        aria-expanded="${state.filtersPanelOpen ? 'true' : 'false'}"
                        aria-controls="lead-history-advanced-menu"
                    >
                        <i class="fa-solid fa-sliders"></i> ${state.filtersPanelOpen ? 'Hide Advanced' : 'Advanced'}${activeFilterCount ? ` (${activeFilterCount})` : ''}
                    </button>
                    ${state.filtersPanelOpen ? renderLeadHistoryAdvancedMenu(savedFilters, activeSavedFilter, scope) : ''}
                </div>

                ${createAction}
                ${assignmentViewAction}

                <button class="lead-history-clear-btn" data-action="clear-client-filters">
                    <i class="fa-solid fa-xmark"></i> Clear
                </button>
            </section>

            <section class="lead-history-table-card">
                <div class="lead-history-table-meta">
                    <div class="lead-history-table-meta-left">
                        <div class="lead-history-table-title-stack">
                            <div class="lead-history-table-title-row">
                                <span class="lead-history-table-title">${isAssignedLeadsPage ? 'Already Assigned Leads' : `All ${workspaceLabel}`}</span>
                                <span class="lead-history-count-badge">${totalVisibleCount.toLocaleString()}</span>
                                ${activeSavedFilter ? `<span class="lead-history-meta-chip"><i class="fa-solid fa-bookmark"></i> ${escapeHtml(activeSavedFilter.name)}</span>` : ''}
                            </div>
                            ${tableDescription ? `<p class="lead-history-table-copy">${escapeHtml(tableDescription)}</p>` : ''}
                        </div>
                    </div>

                    <div class="lead-history-table-meta-right">
                        <label class="lead-history-page-size">
                            <span class="lead-history-filter-label">Page Size</span>
                            <select id="page-size" class="lead-history-select lead-history-page-size-select">
                                ${[25, 50, 100, 250].map((size) => `
                                    <option value="${size}" ${state.pageSize === size ? 'selected' : ''}>${size}</option>
                                `).join('')}
                            </select>
                        </label>
                    </div>
                </div>

                ${canBulkAssign && selectedCount ? `
                    <div class="lead-history-bulk-bar">
                        <span class="lead-history-meta-chip"><i class="fa-solid fa-check-double"></i> ${selectedCount} selected</span>
                        <button class="lead-history-mini-btn" data-action="select-visible-leads" ${paginatedClients.length ? '' : 'disabled'}>
                            <i class="fa-solid fa-layer-group"></i> Select visible
                        </button>
                        <button class="lead-history-mini-btn" data-action="clear-lead-selection" ${selectedCount ? '' : 'disabled'}>
                            <i class="fa-solid fa-xmark"></i> Clear
                        </button>
                        <select id="bulk-assignee" class="lead-history-select lead-history-bulk-select">
                            <option value="">Choose sales rep</option>
                            ${getSalesUsers().map((user) => `
                                <option value="${escapeHtml(user.id)}" ${state.bulkAssignRepId === user.id ? 'selected' : ''}>${escapeHtml(user.name)}</option>
                            `).join('')}
                        </select>
                        <button class="lead-history-mini-btn primary" data-action="bulk-assign-selected" ${selectedCount && state.bulkAssignRepId ? '' : 'disabled'}>
                            <i class="fa-solid fa-user-check"></i> Assign
                        </button>
                        <button class="lead-history-mini-btn" data-action="bulk-unassign-selected" ${selectedCount ? '' : 'disabled'}>
                            <i class="fa-solid fa-user-slash"></i> Unassign
                        </button>
                    </div>
                ` : ''}

                ${paginatedClients.length ? `
                    ${renderLeadHistoryTableSection({
                        clients: paginatedClients,
                        singularLabel,
                        count: totalVisibleCount,
                        canBulkAssign,
                        selectedLeadIds,
                        allPageSelected,
                        emptyMessage: `No ${workspaceLabelLower} found for this filter.`,
                        withTopSpacing: false,
                        showHeader: false
                    })}

                    <div class="lead-history-pagination">
                        <div class="lead-history-pagination-copy">
                            Showing ${pageStart ? `${pageStart}-${pageEnd}` : '0'} of ${totalVisibleCount.toLocaleString()} ${workspaceLabelLower}.
                        </div>
                        <div class="row-actions">
                            <button class="crm-button-ghost" data-action="prev-page" ${state.page === 1 ? 'disabled' : ''}>
                                <i class="fa-solid fa-arrow-left"></i> Previous
                            </button>
                            <span class="lead-history-meta-chip">Page ${state.page} of ${totalPages}</span>
                            <button class="crm-button-ghost" data-action="next-page" ${state.page >= totalPages ? 'disabled' : ''}>
                                Next <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                ` : `
                    <div class="lead-history-state">
                        <i class="fa-solid fa-satellite-dish"></i>
                        <div>No ${workspaceLabelLower} found for this filter.</div>
                        <div class="auth-actions" style="justify-content: center; margin-top: 1rem;">
                            <button class="crm-button-ghost" data-action="clear-client-filters"><i class="fa-solid fa-rotate-left"></i> Clear all filters</button>
                            ${emptyCreateAction}
                        </div>
                    </div>
                `}
            </section>
        </div>
    `;
}

function getUnassignedLeadRows(clients = []) {
    return (clients || []).filter((client) => !normalizeWhitespace(client?.assignedRepId));
}

function renderLeadAssignmentViewAction(scope = 'leads') {
    if (scope !== 'leads' || !hasPermission(state.session, PERMISSIONS.ASSIGN_LEADS)) {
        return '';
    }

    if (isAssignedLeadsView()) {
        return `
            <button class="lead-history-clear-btn" data-action="set-view" data-view="clients">
                <i class="fa-solid fa-arrow-left"></i> Back to Unassigned Leads
            </button>
        `;
    }

    return `
        <button class="lead-history-clear-btn" data-action="set-view" data-view="assigned-leads">
            <i class="fa-solid fa-user-check"></i> Already Assigned Leads
        </button>
    `;
}

function renderLeadHistoryTableSection({
    clients = [],
    singularLabel = 'lead',
    count = 0,
    canBulkAssign = false,
    selectedLeadIds = new Set(),
    allPageSelected = false,
    emptyMessage = '',
    withTopSpacing = true,
    showHeader = true,
    title = '',
    description = ''
}) {
    return `
        <div class="lead-history-table-section" style="${withTopSpacing ? 'margin-top: 1.35rem;' : ''}">
            ${showHeader ? `
                <div class="lead-history-section-head" style="margin-bottom: 0.85rem;">
                    <div>
                        <span class="lead-history-section-title">${escapeHtml(title)}</span>
                        ${description ? `<p class="lead-history-section-copy">${escapeHtml(description)}</p>` : ''}
                    </div>
                    <span class="lead-history-count-badge">${Number(count || 0).toLocaleString()}</span>
                </div>
            ` : ''}

            ${clients.length ? `
                <div class="lead-history-table-scroll">
                    <table class="crm-table lead-history-table">
                        <thead>
                            <tr>
                                ${renderTableHeaders({ canBulkAssign, allPageSelected })}
                            </tr>
                        </thead>
                        <tbody>
                            ${renderLeadHistoryTableRows({
                                clients,
                                singularLabel,
                                canBulkAssign,
                                selectedLeadIds
                            })}
                        </tbody>
                    </table>
                </div>
            ` : `
                <div class="crm-admin-empty compact">
                    <div>${escapeHtml(emptyMessage || `No ${singularLabel}s found.`)}</div>
                </div>
            `}
        </div>
    `;
}

function renderLeadHistoryTableRows({
    clients = [],
    singularLabel = 'lead',
    canBulkAssign = false,
    selectedLeadIds = new Set()
}) {
    return clients.map((client) => `
        <tr>
            ${canBulkAssign ? `
                <td class="selection-cell">
                    <input
                        type="checkbox"
                        class="crm-checkbox"
                        data-action="toggle-select-lead"
                        data-client-id="${client.id}"
                        ${selectedLeadIds.has(client.id) ? 'checked' : ''}
                    >
                </td>
            ` : ''}
            <td class="lead-history-name-cell">
                <button class="lead-link-button" data-action="open-lead-page" data-client-id="${client.id}">
                    ${escapeHtml(client.fullName || `Unnamed ${singularLabel}`)}
                </button>
                <span class="lead-history-submeta">${escapeHtml(buildClientMetaLine(client))}</span>
            </td>
            <td>${renderEmailLink(client.email, {
                clientId: client.id,
                recipientName: client.fullName || client.firstName || client.lastName || ''
            })}</td>
            <td>${renderPhoneLink(client.phone)}</td>
            <td class="lead-history-tags-cell">${client.tags.length ? client.tags.slice(0, 3).map((tag) => `<span class="lead-history-tag"><strong>${escapeHtml(tag)}</strong></span>`).join(' ') : '<span class="lead-history-muted">—</span>'}</td>
            <td class="lead-history-notes-cell"><div class="lead-history-notes-preview">${escapeHtml(truncate(client.notes || 'No notes yet.', 96))}</div></td>
            <td><span class="status-pill ${escapeHtml(client.status)}">${escapeHtml(client.status)}</span></td>
            <td>${escapeHtml(formatDateTime(client.updatedAt))}</td>
        </tr>
    `).join('');
}

function renderWorkspaceCreateAction(scope, variant = 'toolbar') {
    const isMembers = scope === 'members';

    if (isMembers && !hasPermission(state.session, PERMISSIONS.MOVE_TO_MEMBERS)) {
        return '';
    }

    const buttonClass = variant === 'empty' ? 'crm-button-secondary' : 'lead-history-clear-btn';
    const action = isMembers ? 'new-member' : 'new-client';
    const label = isMembers
        ? (variant === 'empty' ? 'Add member' : 'New Member')
        : (variant === 'empty' ? 'Add lead' : 'New Lead');

    return `
        <button class="${buttonClass}" data-action="${action}">
            <i class="fa-solid fa-user-plus"></i> ${label}
        </button>
    `;
}

function renderLeadHistoryAdvancedMenu(savedFilters, activeSavedFilter, scope = 'leads') {
    const activeAdvancedGroupCount = Object.values(state.filters.multi).filter((values) => values.length).length;

    return `
        <div
            class="lead-history-advanced-menu"
            id="lead-history-advanced-menu"
            role="dialog"
            aria-modal="false"
            aria-label="Advanced filters"
        >
            <div class="lead-history-advanced-menu-head">
                <div>
                    <span class="lead-history-section-title">Advanced filters</span>
                    <p class="lead-history-section-copy">Stack names, area codes, subscription types, time zones, and saved views without taking over the page.</p>
                </div>
                <div class="row-actions">
                    <span class="summary-chip">${activeAdvancedGroupCount} group${activeAdvancedGroupCount === 1 ? '' : 's'} active</span>
                    <button class="lead-history-clear-btn" data-action="clear-client-filters">
                        <i class="fa-solid fa-rotate-left"></i> Reset All
                    </button>
                </div>
            </div>

            <div class="lead-history-advanced-menu-scroll">
                <div class="crm-filter-panel lead-history-filter-panel">
                    ${MULTI_FILTER_CONFIG.map((config) => renderMultiValueFilterGroup(config)).join('')}
                    ${renderSavedViewsAccordionSection(savedFilters, activeSavedFilter, scope)}
                </div>
            </div>
        </div>
    `;
}

function renderInlineFiltersPanel(workspaceLabel, savedFilters, activeSavedFilter) {
    const availableTags = getAvailableTags();

    return `
        <aside class="crm-inline-filters">
            <section class="crm-card crm-filter-rail">
                <div class="panel-head">
                    <div>
                        <span class="crm-kicker"><i class="fa-solid fa-filter"></i> Filters</span>
                        <h2 class="section-title">${workspaceLabel} filters</h2>
                        <p class="panel-copy">Inline on the left, compact, and easy to hide without covering the table.</p>
                    </div>
                    <button class="crm-button-ghost" data-action="open-filters"><i class="fa-solid fa-xmark"></i></button>
                </div>

                <div class="filter-row">
                    <div class="filter-controls">
                        <select id="status-filter" class="crm-select">
                            <option value="all">All statuses</option>
                            ${CRM_STATUS_OPTIONS.map((status) => `
                                <option value="${status}" ${state.filters.status === status ? 'selected' : ''}>${titleCase(status)}</option>
                            `).join('')}
                        </select>

                        <select id="tag-filter" class="crm-select">
                            <option value="all">All tags</option>
                            ${availableTags.map((tag) => `
                                <option value="${escapeHtml(tag)}" ${state.filters.tag === tag ? 'selected' : ''}>${escapeHtml(tag)}</option>
                            `).join('')}
                        </select>
                    </div>

                    <div class="settings-actions">
                        <button class="crm-button-ghost" data-action="clear-client-filters"><i class="fa-solid fa-rotate-left"></i> Clear all</button>
                    </div>
                </div>

                <div class="crm-filter-panel">
                    ${MULTI_FILTER_CONFIG.map((config) => renderMultiValueFilterGroup(config)).join('')}
                </div>

                <section class="crm-inline-section">
                    <div class="panel-head">
                        <div>
                            <h3 class="section-title">Save filters</h3>
                            <p class="panel-copy">Keep a private view or share it with the floor.</p>
                        </div>
                    </div>

                    <form id="saved-filter-form" style="margin-top: 1rem;">
                        <input type="hidden" name="id" value="${escapeHtml(state.activeSavedFilterId || '')}">
                        <div class="form-grid single-column-grid">
                            <label class="form-field">
                                <span class="form-label">Filter name</span>
                                <input class="crm-input" name="name" placeholder="Morning follow-up list" value="${escapeHtml(activeSavedFilter?.name || '')}">
                            </label>
                            <label class="form-field">
                                <span class="form-label">Visibility</span>
                                <select class="crm-select" name="visibility">
                                    <option value="private">Private</option>
                                    <option value="shared" ${activeSavedFilter?.visibility === 'shared' ? 'selected' : ''}>Shared</option>
                                </select>
                            </label>
                        </div>
                        <div class="modal-actions" style="margin-top: 1rem;">
                            <button class="crm-button" type="submit"><i class="fa-solid fa-bookmark"></i> ${state.activeSavedFilterId ? 'Update' : 'Save'}</button>
                            ${state.activeSavedFilterId ? '<button class="crm-button-ghost" type="button" data-action="clear-active-saved-filter">New</button>' : ''}
                        </div>
                    </form>
                </section>

                <section class="crm-inline-section">
                    <div class="panel-head">
                        <div>
                            <h3 class="section-title">Saved filters</h3>
                            <p class="panel-copy">${savedFilters.length ? `${savedFilters.length} available in this workspace.` : 'No saved filters yet.'}</p>
                        </div>
                    </div>

                    <div class="history-list compact-history">
                        ${savedFilters.length ? savedFilters.map((filter) => `
                            <article class="history-card">
                                <div class="history-head">
                                    <div>
                                        <div class="history-title">${escapeHtml(filter.name)}</div>
                                        <div class="panel-subtitle">${escapeHtml(filter.visibility === 'shared'
                                            ? `Shared by ${filter.createdByName || filter.createdByUserId || 'CRM user'}`
                                            : `Private to ${filter.createdByName || filter.createdByUserId || 'CRM user'}`)}</div>
                                    </div>
                                </div>
                                <div class="modal-actions" style="margin-top: 0.85rem;">
                                    <button class="crm-button-secondary" data-action="load-saved-filter" data-filter-id="${filter.id}">
                                        <i class="fa-solid fa-bolt"></i> Load
                                    </button>
                                    ${canManageSavedFilter(filter) ? `
                                        <button class="crm-button-ghost" data-action="edit-saved-filter" data-filter-id="${filter.id}">
                                            <i class="fa-solid fa-pen"></i> Edit
                                        </button>
                                        <button class="crm-button-danger" data-action="delete-saved-filter" data-filter-id="${filter.id}">
                                            <i class="fa-solid fa-trash"></i> Delete
                                        </button>
                                    ` : ''}
                                </div>
                            </article>
                        `).join('') : '<div class="panel-subtitle">Save the current filter set to reuse it later.</div>'}
                    </div>
                </section>
            </section>
        </aside>
    `;
}

function renderSavedViewsAccordionSection(savedFilters, activeSavedFilter, scope = 'leads') {
    const isMembers = scope === 'members';
    const isOpen = Boolean(state.filterAccordionOpen.savedViews);
    const savedViewPlaceholder = isMembers ? 'Active member renewals' : 'Morning follow-up list';
    const savedViewsSummary = activeSavedFilter
        ? `Editing ${activeSavedFilter.name}`
        : `${savedFilters.length} saved`;

    return `
        <section class="multi-filter-group ${isOpen ? 'open' : ''}">
            <button
                type="button"
                class="multi-filter-toggle"
                data-action="toggle-filter-section"
                data-section="savedViews"
                aria-expanded="${isOpen ? 'true' : 'false'}"
            >
                <span class="multi-filter-toggle-copy">
                    <span class="mapping-label">Saved Views</span>
                    <span class="mapping-hint">${escapeHtml(savedViewsSummary)}</span>
                </span>
                <span class="multi-filter-toggle-meta">
                    <span class="summary-chip">${activeSavedFilter ? 'Editing' : `${savedFilters.length} saved`}</span>
                    <i class="fa-solid fa-chevron-down multi-filter-toggle-icon"></i>
                </span>
            </button>

            <div class="multi-filter-panel">
                <div class="multi-filter-panel-head">
                    <p class="mapping-hint">Save the current ${isMembers ? 'member' : 'lead'} view for yourself or share it with the floor.</p>
                </div>

                <form id="saved-filter-form" class="lead-history-save-form compact">
                    <input type="hidden" name="id" value="${escapeHtml(state.activeSavedFilterId || '')}">
                    <div class="form-grid single-column-grid">
                        <label class="form-field">
                            <span class="form-label">Filter name</span>
                            <input class="crm-input" name="name" placeholder="${savedViewPlaceholder}" value="${escapeHtml(activeSavedFilter?.name || '')}">
                        </label>
                        <label class="form-field">
                            <span class="form-label">Visibility</span>
                            <select class="crm-select" name="visibility">
                                <option value="private">Private</option>
                                <option value="shared" ${activeSavedFilter?.visibility === 'shared' ? 'selected' : ''}>Shared</option>
                            </select>
                        </label>
                    </div>
                    <div class="modal-actions lead-history-saved-form-actions">
                        <button class="crm-button" type="submit"><i class="fa-solid fa-bookmark"></i> ${state.activeSavedFilterId ? 'Update' : 'Save'}</button>
                        ${state.activeSavedFilterId ? '<button class="crm-button-ghost" type="button" data-action="clear-active-saved-filter">New</button>' : ''}
                    </div>
                </form>

                <div class="history-list compact-history lead-history-saved-list">
                    ${savedFilters.length ? savedFilters.map((filter) => `
                        <article class="history-card lead-history-saved-card">
                            <div class="history-head">
                                <div>
                                    <div class="history-title">${escapeHtml(filter.name)}</div>
                                    <div class="panel-subtitle">${escapeHtml(filter.visibility === 'shared'
                                        ? `Shared by ${filter.createdByName || filter.createdByUserId || 'CRM user'}`
                                        : `Private to ${filter.createdByName || filter.createdByUserId || 'CRM user'}`)}</div>
                                </div>
                            </div>
                            <div class="modal-actions lead-history-saved-card-actions">
                                <button class="crm-button-secondary" data-action="load-saved-filter" data-filter-id="${filter.id}">
                                    <i class="fa-solid fa-bolt"></i> Load
                                </button>
                                ${canManageSavedFilter(filter) ? `
                                    <button class="crm-button-ghost" data-action="edit-saved-filter" data-filter-id="${filter.id}">
                                        <i class="fa-solid fa-pen"></i> Edit
                                    </button>
                                    <button class="crm-button-danger" data-action="delete-saved-filter" data-filter-id="${filter.id}">
                                        <i class="fa-solid fa-trash"></i> Delete
                                    </button>
                                ` : ''}
                            </div>
                        </article>
                    `).join('') : '<div class="lead-history-empty-state">Save the current filter set to reuse it later.</div>'}
                </div>
            </div>
        </section>
    `;
}

function renderMultiValueFilterGroup(config) {
    const values = state.filters.multi[config.key];
    const isOpen = Boolean(state.filterAccordionOpen[config.key]);
    const isSelectControl = config.control === 'select';
    const summaryCopy = isSelectControl
        ? (values[0] || 'No selection')
        : (values.length ? `${values.length} active value${values.length === 1 ? '' : 's'}` : 'No values selected');
    const summaryChip = isSelectControl
        ? (values[0] ? 'Selected' : 'Any')
        : `${values.length} active`;

    return `
        <section class="multi-filter-group ${isOpen ? 'open' : ''}">
            <button
                type="button"
                class="multi-filter-toggle"
                data-action="toggle-filter-section"
                data-section="${config.key}"
                aria-expanded="${isOpen ? 'true' : 'false'}"
            >
                <span class="multi-filter-toggle-copy">
                    <span class="mapping-label">${escapeHtml(config.label)}</span>
                    <span class="mapping-hint">${escapeHtml(summaryCopy)}</span>
                </span>
                <span class="multi-filter-toggle-meta">
                    <span class="summary-chip">${escapeHtml(summaryChip)}</span>
                    <i class="fa-solid fa-chevron-down multi-filter-toggle-icon"></i>
                </span>
            </button>

            <div class="multi-filter-panel">
                <div class="multi-filter-panel-head">
                    <p class="mapping-hint">${escapeHtml(config.hint)}</p>
                    ${values.length ? `
                        <button class="lead-history-clear-btn" data-action="clear-filter-group" data-group="${config.key}">
                            Clear
                        </button>
                    ` : ''}
                </div>

                ${isSelectControl ? `
                    <label class="multi-filter-select-shell">
                        <select
                            class="crm-select multi-filter-select"
                            data-filter-select-group="${config.key}"
                            aria-label="${escapeHtml(config.label)} filter"
                        >
                            <option value="">All ${escapeHtml(config.label.toLowerCase())}s</option>
                            ${(config.options || []).map((option) => `
                                <option value="${escapeHtml(option)}" ${values[0] === option ? 'selected' : ''}>${escapeHtml(option)}</option>
                            `).join('')}
                        </select>
                    </label>
                ` : `
                    <div class="multi-filter-shell">
                        ${values.map((value) => `
                            <span class="filter-token">
                                <span>${escapeHtml(value)}</span>
                                <button
                                    type="button"
                                    class="filter-token-remove"
                                    data-action="remove-filter-token"
                                    data-group="${config.key}"
                                    data-value="${escapeHtml(value)}"
                                    aria-label="Remove ${escapeHtml(value)}"
                                >
                                    <i class="fa-solid fa-xmark"></i>
                                </button>
                            </span>
                        `).join('')}
                        <input
                            class="filter-token-input"
                            data-filter-group="${config.key}"
                            placeholder="${escapeHtml(config.placeholder || '')}"
                            aria-label="${escapeHtml(config.label)} filter values"
                        >
                    </div>
                `}
            </div>
        </section>
    `;
}

function renderLeadDetailPage() {
    const lead = getAccessibleClientById(state.detailClientId);

    if (!lead) {
        return renderEmptyState({
            title: 'Lead not found',
            copy: hasPermission(state.session, PERMISSIONS.VIEW_ALL_RECORDS)
                ? 'The selected lead is no longer available in the current workspace dataset.'
                : 'That lead is not assigned to your session or is no longer available.',
            actions: '<button class="crm-button-ghost" data-action="back-to-list"><i class="fa-solid fa-arrow-left"></i> Back to list</button>'
        });
    }

    const canAdminEdit = hasPermission(state.session, PERMISSIONS.EDIT_ADMIN_FIELDS);
    const canOpenEditMode = canEditCurrentLead(lead) || canAdminEdit;
    const isEditing = state.detailEditMode && canOpenEditMode;
    const isMember = lead.lifecycleType === 'member';
    const canSaveWorkflow = canAdminEdit || (!isMember && isSalesWorkspaceSession(state.session));
    const assigneeOptions = getAssignableUsers({ includeAdmin: true });
    const seniorRepOptions = getSeniorRepUsers();
    const canSaveNotes = canAddNotesToLead(lead);
    const editableNote = getLeadNoteById(lead, state.editingNoteId);
    const statusOptions = CRM_STATUS_OPTIONS;
    const canSendEmail = canSendEmailForLead(lead);
    const noteHistory = Array.isArray(lead.noteHistory)
        ? [...lead.noteHistory].sort((left, right) => Date.parse(right.createdAt ?? 0) - Date.parse(left.createdAt ?? 0))
        : [];
    const leadCalendarEvents = [...(state.calendar.leadEventsByLeadId[lead.id] || [])]
        .sort((left, right) => Date.parse(left.startAt || 0) - Date.parse(right.startAt || 0));
    const dispositionOptions = getLeadDetailDispositionOptions(lead);
    const showToSeniorRepField = isToDispositionValue(lead.disposition);
    const selectedToSeniorRepId = showToSeniorRepField && seniorRepOptions.some((user) => user.id === lead.assignedRepId)
        ? lead.assignedRepId
        : '';
    const entityLabel = isMember ? 'Member' : 'Lead';
    const detailName = lead.fullName || `Unnamed ${entityLabel.toLowerCase()}`;
    const heroSummary = buildLeadDetailSummary(lead);
    const autoTimeZoneLabel = lead.autoTimeZone || 'Unknown';

    return `
        <div class="lead-detail-page">
            <section class="lead-detail-hero">
                ${renderLeadDetailUtilityRow()}
                <div class="lead-detail-hero-inner">
                    <span class="lead-detail-hero-label">
                        <i class="fa-solid fa-user-large"></i> ${entityLabel} Detail
                    </span>
                    <h1>${escapeHtml(detailName)}</h1>
                    <p class="lead-detail-hero-summary">${escapeHtml(heroSummary)}</p>

                    <div class="lead-detail-hero-meta">
                        <span class="summary-chip"><i class="fa-solid fa-user-check"></i> ${escapeHtml(lead.assignedTo || 'Unassigned')}</span>
                        <span class="summary-chip"><i class="fa-solid fa-layer-group"></i> ${escapeHtml(titleCase(lead.lifecycleType || 'lead'))}</span>
                        <span class="summary-chip"><i class="fa-solid fa-signal"></i> ${escapeHtml(lead.subscriptionType || 'No subscription')}</span>
                        <span class="summary-chip"><i class="fa-solid fa-clock"></i> ${escapeHtml(lead.timeZone || 'Unknown')}</span>
                        <span class="summary-chip"><i class="fa-solid fa-bolt"></i> ${escapeHtml(titleCase(lead.status || 'new'))}</span>
                        ${lead.timezoneOverridden ? '<span class="summary-chip"><i class="fa-solid fa-wand-magic-sparkles"></i> Manual override</span>' : ''}
                    </div>
                </div>
            </section>

            <div class="lead-detail-content">
                <section class="crm-card lead-detail-contact-card">
                    <div class="lead-detail-card-head">
                        <div class="lead-detail-card-head-copy">
                            <span class="lead-detail-card-label">Contact & workflow</span>
                        </div>
                        <div class="lead-detail-card-head-actions">
                            ${canSendEmail ? `
                                <button class="crm-button-secondary lead-detail-action-button" data-action="open-email-composer" data-client-id="${lead.id}">
                                    <i class="fa-solid fa-paper-plane"></i> Send Email
                                </button>
                            ` : ''}
                            ${canOpenEditMode ? `
                                <button class="crm-button-ghost lead-detail-action-button" data-action="${isEditing ? 'cancel-lead-edit' : 'toggle-lead-edit'}">
                                    <i class="fa-solid ${isEditing ? 'fa-xmark' : 'fa-pen'}"></i> ${isEditing ? 'Cancel Edit' : 'Edit'}
                                </button>
                            ` : ''}
                            <button class="crm-button-ghost lead-detail-action-button" data-action="toggle-lead-history">
                                Lead History
                            </button>
                        </div>
                    </div>

                    <form id="lead-detail-form" class="lead-detail-form">
                        <input type="hidden" name="id" value="${escapeHtml(lead.id)}">
                        ${isEditing && canAdminEdit ? '' : `<input type="hidden" name="assignedRepId" value="${escapeHtml(lead.assignedRepId || '')}">`}
                        <input type="hidden" name="assignedTo" value="${escapeHtml(lead.assignedTo || '')}">
                        <input type="hidden" name="lifecycleType" value="${escapeHtml(lead.lifecycleType || 'lead')}">

                        <div class="form-grid lead-detail-form-grid">
                            ${renderLeadField('First name', 'firstName', lead.firstName, isEditing && canEditLeadField(state.session, 'firstName', lead), 'text')}
                            ${renderLeadField('Last name', 'lastName', lead.lastName, isEditing && canEditLeadField(state.session, 'lastName', lead), 'text')}
                            ${renderLeadField('Email', 'email', lead.email, isEditing && canEditLeadField(state.session, 'email', lead), 'email', {
                                clientId: lead.id,
                                recipientName: lead.fullName || lead.firstName || lead.lastName || ''
                            })}
                            ${renderLeadField('Phone', 'phone', lead.phone, isEditing && canEditLeadField(state.session, 'phone', lead), 'text')}
                            ${renderLeadSelectField('Status', 'status', statusOptions, lead.status, canEditLeadWorkflowField(lead, 'status') || (isEditing && canEditLeadField(state.session, 'status', lead)))}
                            ${renderLeadSelectField('Disposition', 'disposition', dispositionOptions, lead.disposition || '', canEditLeadWorkflowField(lead, 'disposition') || (isEditing && canEditLeadField(state.session, 'disposition', lead)), null, { emptyLabel: 'No disposition' })}
                            ${renderLeadField('Subscription type', 'subscriptionType', lead.subscriptionType, isEditing && canAdminEdit)}
                            <label class="form-field">
                                <span class="form-label">Time zone</span>
                                <select class="crm-select" name="timeZone" ${(isEditing && (canAdminEdit || canEditLeadField(state.session, 'timeZone', lead))) ? '' : 'disabled'}>
                                    <option value="">Auto detect (${escapeHtml(autoTimeZoneLabel)})</option>
                                    ${CRM_TIME_ZONE_OPTIONS.map((timeZone) => `
                                        <option value="${escapeHtml(timeZone)}" ${lead.timezoneOverridden && lead.timeZone === timeZone ? 'selected' : ''}>${escapeHtml(timeZone)}</option>
                                    `).join('')}
                                </select>
                            </label>
                            ${renderLeadSelectField('Assigned rep', 'assignedRepId', assigneeOptions.map((user) => user.id), lead.assignedRepId || '', isEditing && canAdminEdit, assigneeOptions, { emptyLabel: 'Unassigned' })}
                            ${renderLeadField('Lifecycle', 'lifecycleTypeDisplay', titleCase(lead.lifecycleType || 'lead'), false)}
                            ${canSaveWorkflow ? `
                                <label class="form-field ${showToSeniorRepField ? '' : 'hidden'}" data-to-senior-rep-field>
                                    <span class="form-label">TO senior rep</span>
                                    <select class="crm-select" name="toSeniorRepId" ${showToSeniorRepField ? '' : 'disabled'}>
                                        <option value="">Required when disposition is TO</option>
                                        ${seniorRepOptions.map((user) => `
                                            <option value="${escapeHtml(user.id)}" ${selectedToSeniorRepId === user.id ? 'selected' : ''}>${escapeHtml(user.name)}</option>
                                        `).join('')}
                                    </select>
                                    <span class="panel-subtitle">Only senior reps appear here for TO handoffs.</span>
                                </label>
                            ` : ''}
                            <label class="form-field form-field-full">
                                <span class="form-label">Tags</span>
                                ${renderTagPicker({
                                    name: 'tags',
                                    selectedTags: lead.tags || [],
                                    editable: canEditLeadWorkflowField(lead, 'tags') || (isEditing && canEditLeadField(state.session, 'tags', lead))
                                })}
                            </label>
                        </div>

                        <div class="drawer-actions lead-detail-form-actions">
                            ${canSaveWorkflow ? `
                                <button class="crm-button lead-detail-action-button" type="submit">
                                    Save
                                </button>
                            ` : ''}
                            ${isEditing ? `
                                <button class="crm-button-ghost" type="button" data-action="cancel-lead-edit">
                                    <i class="fa-solid fa-rotate-left"></i> Cancel
                                </button>
                            ` : ''}
                            ${canAdminEdit ? `
                                <button class="crm-button-secondary" type="button" data-action="toggle-member-state" data-client-id="${lead.id}">
                                    <i class="fa-solid fa-arrow-right-arrow-left"></i> ${lead.lifecycleType === 'member' ? 'Move Back to Leads' : 'Convert to Member'}
                                </button>
                            ` : ''}
                            ${hasPermission(state.session, PERMISSIONS.DELETE_ANY_LEAD) ? `
                                <button class="crm-button-danger" type="button" data-action="open-delete-confirm" data-client-id="${lead.id}">
                                    <i class="fa-solid fa-trash"></i> Delete lead
                                </button>
                            ` : ''}
                        </div>
                    </form>
                </section>

                <aside class="lead-detail-sidebar">
                    <section class="crm-card lead-detail-side-card lead-detail-calendar-card">
                        <div class="panel-head">
                            <div>
                                <span class="lead-detail-card-label">Follow-ups</span>
                                <h2 class="section-title">Upcoming follow-ups</h2>
                            </div>
                            <button class="crm-button-secondary lead-detail-action-button" type="button" data-action="open-calendar-event-drawer" data-client-id="${escapeHtml(lead.id)}">
                                <i class="fa-solid fa-plus"></i> Schedule
                            </button>
                        </div>

                        ${leadCalendarEvents.length
                            ? renderCalendarEventList(leadCalendarEvents.slice(0, 6), {
                                emptyCopy: 'No scheduled follow-ups yet for this client.',
                                showLeadName: false
                            })
                            : (lead.followUpAt
                                ? `<div class="calendar-empty-state">Legacy follow-up detected for ${escapeHtml(formatDateTime(lead.followUpAt))}. Run the Supabase calendar backfill to bring older callbacks into this new calendar.</div>`
                                : '<div class="calendar-empty-state">No scheduled follow-ups yet for this client.</div>')}
                    </section>

                    ${renderLeadEmailHistoryCard(lead)}

                    <section class="crm-card lead-detail-side-card lead-detail-notes-card">
                        <div class="panel-head">
                            <div>
                                <span class="lead-detail-card-label">Conversation</span>
                            </div>
                        </div>

                        ${canSaveNotes ? `
                            <form id="lead-note-form" class="lead-detail-note-form">
                                <input type="hidden" name="leadId" value="${escapeHtml(lead.id)}">
                                <input type="hidden" name="noteId" value="${escapeHtml(editableNote?.id || '')}">
                                <label class="form-field form-field-full">
                                    <span class="form-label">${editableNote ? 'Edit note' : 'New note'}</span>
                                    <textarea class="crm-textarea" name="noteEntry" placeholder="Add the latest call summary, objection, or follow-up context...">${escapeHtml(editableNote?.content || '')}</textarea>
                                </label>
                                <div class="drawer-actions lead-detail-form-actions">
                                    <button class="crm-button-secondary lead-detail-action-button" type="submit">Save Notes</button>
                                    ${editableNote ? `
                                        <button class="crm-button-ghost" type="button" data-action="cancel-note-edit">
                                            <i class="fa-solid fa-xmark"></i> Cancel note edit
                                        </button>
                                    ` : ''}
                                </div>
                            </form>
                        ` : '<div class="panel-subtitle lead-detail-empty-copy">This session can view note history but cannot add new entries.</div>'}

                        ${noteHistory.length ? `
                            <div class="history-list">
                                ${noteHistory.map((entry) => `
                                    <article class="history-card">
                                        <div class="history-head">
                                            <div>
                                                <div class="history-title">${escapeHtml(entry.createdByName || entry.createdByUserId || 'CRM user')}</div>
                                                <div class="panel-subtitle">${escapeHtml(formatDateTime(entry.createdAt))}</div>
                                            </div>
                                            ${canEditNoteEntry(state.session, lead, entry) ? `
                                                <button class="crm-button-ghost" type="button" data-action="edit-note-entry" data-note-id="${entry.id}">
                                                    <i class="fa-solid fa-pen"></i> Edit
                                                </button>
                                            ` : ''}
                                        </div>
                                        <div class="note-history-copy">${escapeHtml(entry.content)}</div>
                                        ${entry.updatedAt ? `<div class="panel-subtitle" style="margin-top: 0.75rem;">Last edited ${escapeHtml(formatDateTime(entry.updatedAt))} by ${escapeHtml(entry.updatedByName || entry.updatedByUserId || 'CRM user')}</div>` : ''}
                                        ${entry.versions?.length ? `
                                            <div class="history-sublist">
                                                <div class="panel-subtitle">Prior versions</div>
                                                ${entry.versions.map((version) => `
                                                    <div class="history-version">
                                                        <div class="history-version-meta">${escapeHtml(formatDateTime(version.changedAt))} · ${escapeHtml(version.changedByName || version.changedByUserId || 'CRM user')}</div>
                                                        <div class="note-history-copy">${escapeHtml(version.content)}</div>
                                                    </div>
                                                `).join('')}
                                            </div>
                                        ` : ''}
                                    </article>
                                `).join('')}
                            </div>
                        ` : '<div class="panel-subtitle lead-detail-empty-copy">No saved note history yet for this record.</div>'}
                    </section>
                </aside>
            </div>
        </div>
    `;
}

function renderLeadHistoryEntries(entries) {
    if (!entries.length) {
        return '<div class="crm-history-modal-empty">No history entries exist for this record yet.</div>';
    }

    return `
        <div class="history-list crm-history-entry-list">
            ${entries.map((entry) => `
                <article class="history-card">
                    <div class="history-head">
                        <div>
                            <div class="history-title">${escapeHtml(entry.fieldLabel || entry.fieldName || 'Unknown field')}</div>
                            <div class="panel-subtitle">Changed by ${escapeHtml(getLeadHistoryActorLabel(entry))}</div>
                        </div>
                        <span class="summary-chip">${escapeHtml(formatDateTime(entry.changedAt || entry.createdAt))}</span>
                    </div>
                    <div class="history-audit-grid">
                        <div>
                            <div class="panel-subtitle">Old value</div>
                            <div class="note-history-copy">${escapeHtml(entry.oldValue || entry.previousValue || '—')}</div>
                        </div>
                        <div>
                            <div class="panel-subtitle">New value</div>
                            <div class="note-history-copy">${escapeHtml(entry.newValue || entry.nextValue || '—')}</div>
                        </div>
                    </div>
                </article>
            `).join('')}
        </div>
    `;
}

function renderLeadField(label, name, value, editable, type = 'text', options = {}) {
    if (!editable && name === 'email') {
        return renderReadOnlyEmailField(label, name, value, options);
    }

    if (!editable && name === 'phone') {
        return renderReadOnlyPhoneField(label, name, value);
    }

    return `
        <label class="form-field">
            <span class="form-label">${escapeHtml(label)}</span>
            <input class="crm-input" name="${escapeHtml(name)}" type="${type}" value="${escapeHtml(type === 'datetime-local' ? toDateTimeInputValue(value) : value || '')}" ${editable ? '' : 'readonly'}>
        </label>
    `;
}

function renderLeadSelectField(label, name, options, selectedValue, editable, userOptions = null, config = {}) {
    const emptyLabel = config.emptyLabel || (name === 'assignedRepId' ? 'Unassigned' : 'Select an option');

    return `
        <label class="form-field">
            <span class="form-label">${escapeHtml(label)}</span>
            <select class="crm-select" name="${escapeHtml(name)}" ${editable ? '' : 'disabled'}>
                <option value="">${escapeHtml(emptyLabel)}</option>
                ${options.map((option) => {
                    const value = typeof option === 'string' ? option : option.value;
                    const labelValue = userOptions
                        ? (userOptions.find((user) => user.id === value)?.name || value)
                        : (String(value) === String(value).toUpperCase() ? value : titleCase(value));
                    return `<option value="${escapeHtml(value)}" ${selectedValue === value ? 'selected' : ''}>${escapeHtml(labelValue)}</option>`;
                }).join('')}
            </select>
        </label>
    `;
}

function renderTagPicker({ name, selectedTags = [], editable = true }) {
    const normalizedTags = dedupeAllowedTags(selectedTags);

    return `
        <div class="tag-picker" data-tag-picker>
            <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(normalizedTags.join(', '))}">
            <div class="tag-picker-shell ${editable ? '' : 'readonly'}">
                <div class="tag-picker-chips">${renderTagPickerChips(normalizedTags, editable)}</div>
                ${editable ? `
                    <input
                        class="tag-picker-input"
                        type="text"
                        placeholder="${state.allowedTags.length ? 'Search tags...' : 'No admin tags configured'}"
                        autocomplete="off"
                        ${state.allowedTags.length ? '' : 'disabled'}
                    >
                ` : ''}
            </div>
            ${editable ? '<div class="tag-suggestion-list hidden"></div>' : ''}
        </div>
    `;
}

function renderTagPickerChips(tags, editable) {
    if (!tags.length) {
        return '<span class="panel-subtitle">No tags selected.</span>';
    }

    return tags.map((tag) => `
        <span class="filter-token">
            <span>${escapeHtml(tag)}</span>
            ${editable ? `
                <button
                    type="button"
                    class="filter-token-remove"
                    data-action="remove-tag-token"
                    data-tag="${escapeHtml(tag)}"
                    aria-label="Remove ${escapeHtml(tag)}"
                >
                    <i class="fa-solid fa-xmark"></i>
                </button>
            ` : ''}
        </span>
    `).join('');
}

function hasActiveAdminProfile() {
    return state.profile?.role === 'admin' && state.profile?.isActive === true;
}

function getAdminWorkspaceUsers() {
    return getAssignableUsers({ includeAdmin: false, includeSupport: true, includeInactive: true });
}

function getVisibleAdminUsers(users = getAdminWorkspaceUsers()) {
    const searchTerm = normalizeWhitespace(state.adminUserSearch).toLowerCase();

    return users.filter((user) => {
        if (state.adminUserFilter === 'active' && user.isActive === false) {
            return false;
        }

        if (state.adminUserFilter === 'inactive' && user.isActive !== false) {
            return false;
        }

        if (state.adminUserFilter === 'senior' && user.role !== 'senior') {
            return false;
        }

        if (state.adminUserFilter === 'sales' && user.role !== 'sales') {
            return false;
        }

        if (state.adminUserFilter === 'support' && user.role !== 'support') {
            return false;
        }

        if (!searchTerm) {
            return true;
        }

        const haystack = [
            user.name,
            user.email,
            user.title,
            getRoleLabel(user.role)
        ].join(' ').toLowerCase();

        return haystack.includes(searchTerm);
    });
}

function getUserInitials(name = '') {
    return normalizeWhitespace(name)
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join('') || 'U';
}

function renderAdminPanel() {
    if (!hasActiveAdminProfile()) {
        return renderEmptyState({
            title: 'Admin access required',
            copy: 'This control area is available only to active admin profiles.',
            actions: '<button class="crm-button-ghost" data-action="set-view" data-view="clients"><i class="fa-solid fa-arrow-left"></i> Back to Leads</button>'
        });
    }

    const adminMetrics = getAdminMetrics();
    const adminUsers = getAdminWorkspaceUsers();
    const visibleAdminUsers = getVisibleAdminUsers(adminUsers);
    const editingTagDefinition = state.tagDefinitions.find((definition) => definition.id === state.editingTagDefinitionId) || null;
    const editingDispositionDefinition = state.dispositionDefinitions.find((definition) => definition.id === state.editingDispositionDefinitionId) || null;

    return `
        <div class="crm-admin-wrapper">
            <section class="crm-admin-hero">
                <div class="crm-admin-hero-glow"></div>
                <div class="crm-admin-hero-body">
                    <div>
                        <div class="crm-admin-label-pill"><i class="fa-solid fa-shield-halved"></i> Admin Panel</div>
                        <h1 class="crm-admin-hero-title">Control Center</h1>
                        <p class="crm-admin-hero-sub">Manage CRM users, pipeline rules, and workspace activity from one focused control center.</p>
                    </div>
                    <button class="crm-admin-back-btn" data-action="set-view" data-view="clients">
                        <i class="fa-solid fa-arrow-left"></i> Leads
                    </button>
                </div>
            </section>

            <div class="crm-admin-stats-grid">
                <article class="crm-admin-stat-card">
                    <div class="crm-admin-stat-icon"><i class="fa-solid fa-users"></i></div>
                    <div>
                        <div class="crm-admin-stat-value">${adminMetrics.totalReps.toLocaleString()}</div>
                        <div class="crm-admin-stat-label">Total Users</div>
                    </div>
                </article>
                <article class="crm-admin-stat-card">
                    <div class="crm-admin-stat-icon"><i class="fa-solid fa-user-check"></i></div>
                    <div>
                        <div class="crm-admin-stat-value">${adminMetrics.activeReps.toLocaleString()}</div>
                        <div class="crm-admin-stat-label">Active Users</div>
                    </div>
                </article>
                <article class="crm-admin-stat-card">
                    <div class="crm-admin-stat-icon"><i class="fa-solid fa-address-book"></i></div>
                    <div>
                        <div class="crm-admin-stat-value">${adminMetrics.totalLeads.toLocaleString()}</div>
                        <div class="crm-admin-stat-label">Total Leads</div>
                    </div>
                </article>
                <article class="crm-admin-stat-card">
                    <div class="crm-admin-stat-icon"><i class="fa-solid fa-user-group"></i></div>
                    <div>
                        <div class="crm-admin-stat-value">${adminMetrics.totalMembers.toLocaleString()}</div>
                        <div class="crm-admin-stat-label">Total Members</div>
                    </div>
                </article>
            </div>

            <div class="crm-admin-tabs">
                ${ADMIN_TABS.map((tab) => `
                    <button
                        class="crm-admin-tab ${state.adminTab === tab.id ? 'active' : ''}"
                        data-action="set-admin-tab"
                        data-admin-tab="${tab.id}"
                    >
                        <i class="fa-solid ${tab.icon}"></i> ${tab.label}
                    </button>
                `).join('')}
            </div>

            <section class="crm-admin-panel ${state.adminTab === 'team' ? 'active' : ''}">
                <div class="crm-admin-card">
                    <div class="crm-admin-controls">
                        <div class="crm-admin-search-wrap">
                            <i class="fa-solid fa-magnifying-glass"></i>
                            <input
                                type="text"
                                id="admin-user-search"
                                class="crm-admin-search-input"
                                placeholder="Search by name or email..."
                                value="${escapeHtml(state.adminUserSearch)}"
                            >
                        </div>
                        <div class="crm-admin-filter-pills">
                            ${[
                                ['all', 'All'],
                                ['active', 'Active'],
                                ['inactive', 'Inactive'],
                                ['senior', 'Senior'],
                                ['sales', 'Sales'],
                                ['support', 'Support']
                            ].map(([value, label]) => `
                                <button
                                    class="crm-admin-filter-pill ${state.adminUserFilter === value ? 'active' : ''}"
                                    data-action="set-admin-user-filter"
                                    data-filter-value="${value}"
                                >
                                    ${label}
                                </button>
                            `).join('')}
                        </div>
                    </div>

                    ${visibleAdminUsers.length ? `
                        <div class="crm-admin-table-wrap">
                            <table class="crm-admin-table">
                                <thead>
                                    <tr>
                                        <th>User</th>
                                        <th>Role</th>
                                        <th>Status</th>
                                        <th>Assigned Leads</th>
                                        <th>Members</th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${visibleAdminUsers.map((user) => `
                                        <tr>
                                            <td>
                                                <div class="crm-admin-user-cell">
                                                    <div class="crm-admin-user-avatar">${escapeHtml(getUserInitials(user.name))}</div>
                                                    <div>
                                                        <div class="crm-admin-user-name">${escapeHtml(user.name)}</div>
                                                        <div class="crm-admin-user-email">${escapeHtml(user.email)}</div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td>
                                                <span class="crm-admin-role-badge ${escapeHtml(user.role)}">${escapeHtml(getRoleLabel(user.role))}</span>
                                            </td>
                                            <td>
                                                <span class="crm-admin-status-chip ${user.isActive === false ? 'inactive' : 'active'}">
                                                    ${user.isActive === false ? 'Inactive' : 'Active'}
                                                </span>
                                            </td>
                                            <td>${(adminMetrics.leadsByRepMap.get(user.name) || 0).toLocaleString()}</td>
                                            <td>${(adminMetrics.membersByRepMap.get(user.name) || 0).toLocaleString()}</td>
                                            <td>
                                                <div class="crm-admin-row-actions">
                                                    <button class="crm-admin-row-btn edit" data-action="open-user-form" data-user-id="${user.id}">
                                                        <i class="fa-solid fa-pen"></i> Edit
                                                    </button>
                                                    <button class="crm-admin-row-btn delete" data-action="delete-user-account" data-user-id="${user.id}">
                                                        <i class="fa-solid fa-trash"></i> Delete
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    ` : `
                        <div class="crm-admin-empty">
                            <i class="fa-solid fa-users-slash"></i>
                            <div>No users match the current search.</div>
                        </div>
                    `}
                </div>
            </section>

            <section class="crm-admin-panel ${state.adminTab === 'tags' ? 'active' : ''}">
                <div class="crm-admin-section-grid">
                    <section class="crm-admin-card">
                        <div class="crm-admin-card-title"><i class="fa-solid fa-tags"></i> Tag Catalog</div>
                        <p class="crm-admin-card-copy">Manage the tags reps can apply across the CRM workspace.</p>

                        <form id="tag-definition-form" class="crm-admin-form-stack">
                            <input type="hidden" name="id" value="${escapeHtml(editingTagDefinition?.id || '')}">
                            <div class="crm-admin-form-grid">
                                <label class="form-field">
                                    <span class="form-label">Tag label</span>
                                    <input class="crm-input" name="label" value="${escapeHtml(editingTagDefinition?.label || '')}" placeholder="Do Not Call">
                                </label>
                                <label class="form-field">
                                    <span class="form-label">State</span>
                                    <select class="crm-select" name="isArchived">
                                        <option value="false" ${editingTagDefinition?.isArchived !== true ? 'selected' : ''}>Active</option>
                                        <option value="true" ${editingTagDefinition?.isArchived === true ? 'selected' : ''}>Archived</option>
                                    </select>
                                </label>
                            </div>
                            <div class="crm-admin-form-actions">
                                <button class="crm-button" type="submit"><i class="fa-solid fa-tags"></i> ${editingTagDefinition ? 'Update tag' : 'Add tag'}</button>
                                ${editingTagDefinition ? '<button class="crm-button-ghost" type="button" data-action="clear-tag-definition-edit">New tag</button>' : ''}
                            </div>
                        </form>
                    </section>

                    <section class="crm-admin-card">
                        <div class="crm-admin-card-title"><i class="fa-solid fa-table-list"></i> Current Tags</div>
                        <div class="crm-admin-table-wrap">
                            <table class="crm-admin-table">
                                <thead>
                                    <tr>
                                        <th>Tag</th>
                                        <th>Status</th>
                                        <th>Records</th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${state.tagDefinitions.length ? state.tagDefinitions.map((definition) => `
                                        <tr>
                                            <td>${escapeHtml(definition.label)}</td>
                                            <td>
                                                <span class="crm-admin-status-chip ${definition.isArchived ? 'inactive' : 'active'}">
                                                    ${definition.isArchived ? 'Archived' : 'Active'}
                                                </span>
                                            </td>
                                            <td>${state.clients.filter((client) => client.tags.some((tag) => tag.toLowerCase() === definition.label.toLowerCase())).length.toLocaleString()}</td>
                                            <td>
                                                <div class="crm-admin-row-actions">
                                                    <button class="crm-admin-row-btn edit" data-action="edit-tag-definition" data-definition-id="${definition.id}">
                                                        <i class="fa-solid fa-pen"></i> Edit
                                                    </button>
                                                    <button class="crm-admin-row-btn edit" data-action="toggle-tag-archive" data-definition-id="${definition.id}">
                                                        <i class="fa-solid fa-box-archive"></i> ${definition.isArchived ? 'Restore' : 'Archive'}
                                                    </button>
                                                    <button class="crm-admin-row-btn delete" data-action="delete-tag-definition" data-definition-id="${definition.id}">
                                                        <i class="fa-solid fa-trash"></i> Delete
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    `).join('') : `
                                        <tr>
                                            <td colspan="4">
                                                <div class="crm-admin-empty compact">
                                                    <div>No tags configured yet.</div>
                                                </div>
                                            </td>
                                        </tr>
                                    `}
                                </tbody>
                            </table>
                        </div>
                    </section>
                </div>
            </section>

            <section class="crm-admin-panel ${state.adminTab === 'dispositions' ? 'active' : ''}">
                <div class="crm-admin-section-grid">
                    <section class="crm-admin-card">
                        <div class="crm-admin-card-title"><i class="fa-solid fa-list-check"></i> Disposition Catalog</div>
                        <p class="crm-admin-card-copy">Control the approved dispositions available in lead workflows.</p>

                        <form id="disposition-definition-form" class="crm-admin-form-stack">
                            <input type="hidden" name="id" value="${escapeHtml(editingDispositionDefinition?.id || '')}">
                            <div class="crm-admin-form-grid">
                                <label class="form-field">
                                    <span class="form-label">Disposition label</span>
                                    <input class="crm-input" name="label" value="${escapeHtml(editingDispositionDefinition?.label || '')}" placeholder="TO">
                                </label>
                                <label class="form-field">
                                    <span class="form-label">State</span>
                                    <select class="crm-select" name="isArchived">
                                        <option value="false" ${editingDispositionDefinition?.isArchived !== true ? 'selected' : ''}>Active</option>
                                        <option value="true" ${editingDispositionDefinition?.isArchived === true ? 'selected' : ''}>Archived</option>
                                    </select>
                                </label>
                            </div>
                            <div class="crm-admin-form-actions">
                                <button class="crm-button" type="submit"><i class="fa-solid fa-list-check"></i> ${editingDispositionDefinition ? 'Update disposition' : 'Add disposition'}</button>
                                ${editingDispositionDefinition ? '<button class="crm-button-ghost" type="button" data-action="clear-disposition-definition-edit">New disposition</button>' : ''}
                            </div>
                        </form>
                    </section>

                    <section class="crm-admin-card">
                        <div class="crm-admin-card-title"><i class="fa-solid fa-table-list"></i> Current Dispositions</div>
                        <div class="crm-admin-table-wrap">
                            <table class="crm-admin-table">
                                <thead>
                                    <tr>
                                        <th>Disposition</th>
                                        <th>Status</th>
                                        <th>Records</th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${state.dispositionDefinitions.length ? state.dispositionDefinitions.map((definition) => `
                                        <tr>
                                            <td>${escapeHtml(definition.label)}</td>
                                            <td>
                                                <span class="crm-admin-status-chip ${definition.isArchived ? 'inactive' : 'active'}">
                                                    ${definition.isArchived ? 'Archived' : 'Active'}
                                                </span>
                                            </td>
                                            <td>${state.clients.filter((client) => normalizeWhitespace(client.disposition).toLowerCase() === definition.label.toLowerCase()).length.toLocaleString()}</td>
                                            <td>
                                                <div class="crm-admin-row-actions">
                                                    <button class="crm-admin-row-btn edit" data-action="edit-disposition-definition" data-definition-id="${definition.id}">
                                                        <i class="fa-solid fa-pen"></i> Edit
                                                    </button>
                                                    <button class="crm-admin-row-btn edit" data-action="toggle-disposition-archive" data-definition-id="${definition.id}">
                                                        <i class="fa-solid fa-box-archive"></i> ${definition.isArchived ? 'Restore' : 'Archive'}
                                                    </button>
                                                    <button class="crm-admin-row-btn delete" data-action="delete-disposition-definition" data-definition-id="${definition.id}">
                                                        <i class="fa-solid fa-trash"></i> Delete
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    `).join('') : `
                                        <tr>
                                            <td colspan="4">
                                                <div class="crm-admin-empty compact">
                                                    <div>No dispositions configured yet.</div>
                                                </div>
                                            </td>
                                        </tr>
                                    `}
                                </tbody>
                            </table>
                        </div>
                    </section>
                </div>
            </section>

            <section class="crm-admin-panel ${state.adminTab === 'activity' ? 'active' : ''}">
                <div class="crm-admin-activity-grid">
                    <section class="crm-admin-card">
                        <div class="crm-admin-card-title"><i class="fa-solid fa-chart-pie"></i> Pipeline Status</div>
                        <ul class="crm-admin-mini-list">
                            ${adminMetrics.leadsByStatus.map(([status, count]) => `
                                <li>
                                    <span class="status-pill ${escapeHtml(status)}">${escapeHtml(titleCase(status))}</span>
                                    <strong>${count.toLocaleString()}</strong>
                                </li>
                            `).join('') || '<li><span>No pipeline data yet.</span><strong>0</strong></li>'}
                        </ul>
                    </section>

                    <section class="crm-admin-card">
                        <div class="crm-admin-card-title"><i class="fa-solid fa-chart-bar"></i> Leads by Rep</div>
                        <ul class="crm-admin-mini-list">
                            ${adminMetrics.leadsByRep.slice(0, 6).map(([repName, count]) => `
                                <li>
                                    <span>${escapeHtml(repName)}</span>
                                    <strong>${count.toLocaleString()}</strong>
                                </li>
                            `).join('') || '<li><span>No rep activity yet.</span><strong>0</strong></li>'}
                        </ul>
                    </section>

                    <section class="crm-admin-card">
                        <div class="crm-admin-card-title"><i class="fa-solid fa-arrow-right-arrow-left"></i> Recent Assignments</div>
                        ${adminMetrics.recentAssignments.length ? `
                            <div class="history-list compact-history">
                                ${adminMetrics.recentAssignments.map((entry) => `
                                    <article class="history-card">
                                        <div class="history-head">
                                            <div>
                                                <div class="history-title">${escapeHtml(entry.leadName)}</div>
                                                <div class="panel-subtitle">${escapeHtml(entry.message)}</div>
                                            </div>
                                            <span class="summary-chip">${escapeHtml(formatDateTime(entry.createdAt))}</span>
                                        </div>
                                    </article>
                                `).join('')}
                            </div>
                        ` : '<div class="crm-admin-empty compact"><div>No assignment activity yet.</div></div>'}
                    </section>

                    <section class="crm-admin-card">
                        <div class="crm-admin-card-title"><i class="fa-solid fa-clock-rotate-left"></i> Recent Activity</div>
                        ${adminMetrics.recentActivity.length ? `
                            <div class="history-list compact-history">
                                ${adminMetrics.recentActivity.map((entry) => `
                                    <article class="history-card">
                                        <div class="history-head">
                                            <div>
                                                <div class="history-title">${escapeHtml(entry.leadName)}</div>
                                                <div class="panel-subtitle">${escapeHtml(entry.message)}</div>
                                            </div>
                                            <span class="summary-chip">${escapeHtml(formatDateTime(entry.createdAt))}</span>
                                        </div>
                                    </article>
                                `).join('')}
                            </div>
                        ` : '<div class="crm-admin-empty compact"><div>No recent activity yet.</div></div>'}
                    </section>

                    <section class="crm-admin-card">
                        <div class="crm-admin-card-title"><i class="fa-solid fa-phone-volume"></i> Calling Activity</div>
                        <div class="crm-admin-substats-grid">
                            <article class="crm-admin-substat">
                                <div class="crm-admin-substat-value">${adminMetrics.followUpsDue.toLocaleString()}</div>
                                <div class="crm-admin-substat-label">Follow-Ups Due</div>
                            </article>
                            <article class="crm-admin-substat">
                                <div class="crm-admin-substat-value">${adminMetrics.noteEntriesByRep[0]?.[1]?.toLocaleString() || '0'}</div>
                                <div class="crm-admin-substat-label">Top Note Volume</div>
                            </article>
                            <article class="crm-admin-substat">
                                <div class="crm-admin-substat-value">${adminMetrics.dispositionChangesByRep[0]?.[1]?.toLocaleString() || '0'}</div>
                                <div class="crm-admin-substat-label">Top Dispositions</div>
                            </article>
                            <article class="crm-admin-substat">
                                <div class="crm-admin-substat-value">${adminMetrics.followUpsByRep[0]?.[1]?.toLocaleString() || '0'}</div>
                                <div class="crm-admin-substat-label">Top Follow-Ups</div>
                            </article>
                        </div>
                    </section>

                    <section class="crm-admin-card">
                        <div class="crm-admin-card-title"><i class="fa-solid fa-wave-square"></i> Rep Touches</div>
                        <ul class="crm-admin-mini-list">
                            ${adminMetrics.leadsTouchedByRep.slice(0, 6).map(([name, count]) => `
                                <li>
                                    <span>${escapeHtml(name)}</span>
                                    <strong>${count.toLocaleString()}</strong>
                                </li>
                            `).join('') || '<li><span>No touches recorded yet.</span><strong>0</strong></li>'}
                        </ul>
                    </section>
                </div>
            </section>

            <section class="crm-admin-panel ${state.adminTab === 'imports' ? 'active' : ''}">
                ${renderImportsPanel()}
            </section>
        </div>
    `;
}

function renderImportsPanel() {
    if (!hasPermission(state.session, PERMISSIONS.IMPORT_LEADS)) {
        return renderEmptyState({
            title: 'Admin access required',
            copy: 'Lead import tools are available only to admin users.',
            actions: '<button class="crm-button-ghost" data-action="set-view" data-view="clients"><i class="fa-solid fa-arrow-left"></i> Back to Leads</button>'
        });
    }

    if (state.isLoading) {
        return renderLoadingState('Loading import history...');
    }

    const latestImport = state.importHistory[0];

    return `
        <div class="imports-grid">
            <section class="crm-card">
                <div class="panel-head">
                    <div>
                        <span class="crm-kicker"><i class="fa-solid fa-file-arrow-up"></i> Import tools</span>
                        <h1 class="section-title">CSV intake with duplicate controls.</h1>
                        <p class="panel-copy">
                            Upload CSV files, map columns, review duplicates by email and phone, then import them into the workspace.
                        </p>
                    </div>
                    <div class="row-actions">
                        <button class="crm-button-secondary" data-action="open-import"><i class="fa-solid fa-upload"></i> Start import</button>
                        ${hasPermission(state.session, PERMISSIONS.EXPORT_LEADS) ? '<button class="crm-button-ghost" data-action="export-clients"><i class="fa-solid fa-file-export"></i> Export current leads</button>' : ''}
                    </div>
                </div>

                <div class="meta-grid two-up" style="margin-top: 1rem;">
                    <div class="meta-list-item">
                        <i class="fa-solid fa-clone"></i>
                        <div>
                            <strong>Duplicate actions</strong>
                            <div class="panel-subtitle">Skip duplicates, replace existing records, or merge notes and tags.</div>
                        </div>
                    </div>
                    <div class="meta-list-item">
                        <i class="fa-solid fa-gauge-high"></i>
                        <div>
                            <strong>Large-list friendly</strong>
                            <div class="panel-subtitle">Pagination keeps the leads table fast with thousands of records.</div>
                        </div>
                    </div>
                </div>
            </section>

            <section class="crm-card">
                <div class="panel-head">
                    <div>
                        <h2 class="section-title">Latest import summary</h2>
                        <p class="panel-copy">${latestImport ? `Most recent file: ${escapeHtml(latestImport.sourceFileName)}` : 'No imports yet.'}</p>
                    </div>
                </div>

                ${latestImport ? `
                    <div class="stats-strip">
                        ${renderStatTile('Imported', latestImport.importedCount)}
                        ${renderStatTile('Replaced', latestImport.replacedCount)}
                        ${renderStatTile('Merged', latestImport.mergedCount)}
                        ${renderStatTile('Skipped', latestImport.skippedCount)}
                    </div>
                    <div class="panel-subtitle" style="margin-top: 1rem;">Imported ${escapeHtml(formatDateTime(latestImport.importedAt))} using <span class="inline-code">${escapeHtml(latestImport.duplicateMode)}</span>.</div>
                ` : `
                    <div class="empty-state">
                        <div>
                            <div class="empty-copy">Import history will appear here once you upload a CSV.</div>
                        </div>
                    </div>
                `}
            </section>

            <section class="crm-card">
                <div class="panel-head">
                    <div>
                        <h2 class="section-title">Import history</h2>
                        <p class="panel-copy">A running log of CSV imports and workspace updates.</p>
                    </div>
                </div>

                ${state.importHistory.length ? `
                    <div class="history-list">
                        ${state.importHistory.map((entry) => `
                            <article class="history-card">
                                <div class="history-head">
                                    <div>
                                        <div class="history-title">${escapeHtml(entry.sourceFileName)}</div>
                                        <div class="panel-subtitle">${escapeHtml(entry.type === 'seed' ? 'System import' : 'CSV import')}</div>
                                    </div>
                                    <span class="summary-chip">${escapeHtml(formatDateTime(entry.importedAt))}</span>
                                </div>
                                <div class="history-meta">
                                    <span class="metric-chip">Imported ${entry.importedCount}</span>
                                    <span class="metric-chip">Replaced ${entry.replacedCount}</span>
                                    <span class="metric-chip">Merged ${entry.mergedCount}</span>
                                    <span class="metric-chip">Skipped ${entry.skippedCount}</span>
                                    <span class="metric-chip">Failed ${entry.failedCount}</span>
                                    <span class="metric-chip">Mode ${escapeHtml(entry.duplicateMode)}</span>
                                </div>
                            </article>
                        `).join('')}
                    </div>
                ` : renderEmptyState({
                    title: 'No import history yet',
                    copy: 'When you upload a CSV, the CRM will record an import summary here.',
                    actions: '<button class="crm-button-secondary" data-action="open-import"><i class="fa-solid fa-upload"></i> Upload CSV</button>'
                })}
            </section>
        </div>
    `;
}

function getPersonalMailboxSender(userId = state.session?.id) {
    const normalizedUserId = normalizeWhitespace(userId);
    return state.mailboxSenders.find((sender) =>
        sender.kind === 'personal'
        && sender.ownerUserId === normalizedUserId
        && sender.isActive !== false
    ) || null;
}

function getSupportMailboxSender() {
    return state.mailboxSenders.find((sender) => sender.kind === 'support' && sender.isActive !== false) || null;
}

function normalizeMailboxKind(mailboxKind = 'personal') {
    return normalizeWhitespace(mailboxKind).toLowerCase() === 'support' ? 'support' : 'personal';
}

function getMailboxSignatureDraft(mailboxKind = 'personal') {
    return state.mailboxSignatureDrafts[normalizeMailboxKind(mailboxKind)] || null;
}

function setMailboxSignatureDraft(mailboxKind = 'personal', draft = null) {
    const normalizedMailboxKind = normalizeMailboxKind(mailboxKind);

    if (!draft) {
        state.mailboxSignatureDrafts[normalizedMailboxKind] = null;
        return;
    }

    state.mailboxSignatureDrafts[normalizedMailboxKind] = {
        senderName: normalizeWhitespace(draft.senderName),
        senderEmail: normalizeWhitespace(draft.senderEmail).toLowerCase(),
        signatureMode: normalizeSignatureModeValue(draft.signatureMode),
        signatureTemplate: normalizeSignatureTemplateDraft(draft.signatureTemplate, draft.senderName, draft.senderEmail),
        signatureHtmlOverride: String(draft.signatureHtmlOverride ?? ''),
        signatureText: String(draft.signatureText ?? '')
    };
}

function buildMailboxSignatureEditorSender(mailboxKind = 'personal', sender = null, senderName = '', senderEmail = '') {
    const draft = getMailboxSignatureDraft(mailboxKind);

    if (!draft) {
        return sender;
    }

    return {
        ...(sender || {}),
        senderName: draft.senderName || normalizeWhitespace(senderName) || sender?.senderName || '',
        senderEmail: draft.senderEmail || normalizeWhitespace(senderEmail).toLowerCase() || sender?.senderEmail || '',
        signatureMode: draft.signatureMode,
        signatureTemplate: normalizeSignatureTemplateDraft(draft.signatureTemplate, draft.senderName || senderName, draft.senderEmail || senderEmail),
        signatureHtmlOverride: draft.signatureHtmlOverride,
        signatureText: draft.signatureText
    };
}

function canUseSupportMailbox() {
    return state.session?.role === 'admin' || state.session?.role === 'support';
}

function getSettingsSectionDefinitions(leadCount = 0, memberCount = 0) {
    const totalRecords = Number(leadCount || 0) + Number(memberCount || 0);
    const sections = [
        {
            id: 'account',
            label: 'Account',
            icon: 'fa-user-shield',
            status: getRoleLabel(state.session?.role || 'sales')
        },
        {
            id: 'calling',
            label: 'Calling',
            icon: 'fa-phone-volume',
            status: getCallPreferenceLabel()
        },
        {
            id: 'personal_mailbox',
            label: 'My Mailbox',
            icon: 'fa-envelope-circle-check',
            status: getPersonalMailboxSender() ? 'Connected' : 'Needs setup'
        }
    ];

    if (isAdminSession(state.session)) {
        sections.push({
            id: 'support_mailbox',
            label: 'Support Mailbox',
            icon: 'fa-headset',
            status: getSupportMailboxSender() ? 'Configured' : 'Not configured'
        });
    }

    sections.push({
        id: 'workspace_tools',
        label: 'Workspace Tools',
        icon: 'fa-screwdriver-wrench',
        status: `${totalRecords.toLocaleString()} records`
    });

    return sections;
}

function getValidSettingsSection(sectionId = '') {
    const availableSections = getSettingsSectionDefinitions().map((section) => section.id);
    const normalizedSectionId = normalizeWhitespace(sectionId);
    return availableSections.includes(normalizedSectionId) ? normalizedSectionId : 'account';
}

function getValidSignatureSubpanel(subpanel = '') {
    const normalized = normalizeWhitespace(subpanel).toLowerCase();
    return ['identity', 'media', 'links'].includes(normalized) ? normalized : 'identity';
}

function formatMailboxSenderLabel(sender, fallbackName = '') {
    if (!sender) {
        return 'Not connected';
    }

    const displayName = sender.senderName || fallbackName || sender.senderEmail || 'Mailbox';
    return `${displayName} <${sender.senderEmail}>`;
}

function getEmailSenderOptions() {
    const options = [];
    const personalSender = getPersonalMailboxSender();
    const supportSender = getSupportMailboxSender();

    if (personalSender) {
        options.push({
            value: 'personal',
            label: formatMailboxSenderLabel(personalSender, state.session?.name || '')
        });
    }

    if (supportSender && canUseSupportMailbox()) {
        options.push({
            value: 'support',
            label: formatMailboxSenderLabel(supportSender, 'Support')
        });
    }

    return options;
}

function getDefaultEmailSenderMode(senderOptions = getEmailSenderOptions()) {
    return senderOptions.some((option) => option.value === 'personal')
        ? 'personal'
        : (senderOptions[0]?.value || 'personal');
}

function resolveEmailComposerSenderMode(senderMode, senderOptions = getEmailSenderOptions()) {
    const normalizedSenderMode = normalizeWhitespace(senderMode) === 'support' ? 'support' : 'personal';
    return senderOptions.some((option) => option.value === normalizedSenderMode)
        ? normalizedSenderMode
        : getDefaultEmailSenderMode(senderOptions);
}

function getEmailComposerLead() {
    const leadId = normalizeWhitespace(state.emailComposer.leadId);
    return leadId ? getAccessibleClientById(leadId) : null;
}

function syncEmailComposerDraft(form) {
    if (!form) {
        return;
    }

    const formData = new FormData(form);
    const senderOptions = getEmailSenderOptions();

    state.emailComposer = {
        ...state.emailComposer,
        leadId: normalizeWhitespace(formData.get('leadId')),
        threadId: normalizeWhitespace(formData.get('threadId')),
        inReplyTo: normalizeWhitespace(formData.get('inReplyTo')),
        references: normalizeWhitespace(formData.get('references')),
        composeMode: normalizeWhitespace(formData.get('composeMode')) || 'new',
        recipientEmail: String(formData.get('recipientEmail') ?? ''),
        senderMode: resolveEmailComposerSenderMode(formData.get('senderMode'), senderOptions),
        subject: String(formData.get('subject') ?? ''),
        bodyText: String(formData.get('bodyText') ?? '')
    };
}

function getEmailWorkspaceMailboxes() {
    if (Array.isArray(state.emailWorkspace.mailboxes) && state.emailWorkspace.mailboxes.length) {
        return state.emailWorkspace.mailboxes;
    }

    return state.mailboxSenders.map((sender) => ({
        ...sender,
        syncState: []
    }));
}

function getEmailWorkspaceSelectedMailbox() {
    const selectedMailboxId = normalizeWhitespace(state.emailWorkspace.selectedMailboxId);
    return getEmailWorkspaceMailboxes().find((mailbox) => mailbox.id === selectedMailboxId) || null;
}

function resolveInitialEmailMailboxId(mailboxes = getEmailWorkspaceMailboxes(), preferredMailboxId = '') {
    const normalizedPreferredMailboxId = normalizeWhitespace(preferredMailboxId);

    if (normalizedPreferredMailboxId && mailboxes.some((mailbox) => mailbox.id === normalizedPreferredMailboxId)) {
        return normalizedPreferredMailboxId;
    }

    const personalSender = getPersonalMailboxSender();
    if (personalSender && mailboxes.some((mailbox) => mailbox.id === personalSender.id)) {
        return personalSender.id;
    }

    const supportSender = getSupportMailboxSender();
    if (supportSender && mailboxes.some((mailbox) => mailbox.id === supportSender.id)) {
        return supportSender.id;
    }

    return normalizeWhitespace(mailboxes[0]?.id);
}

function clearEmailWorkspaceAutoRefresh() {
    window.clearTimeout(emailWorkspaceAutoRefreshTimer);
    emailWorkspaceAutoRefreshTimer = null;
}

function scheduleEmailWorkspaceAutoRefresh() {
    clearEmailWorkspaceAutoRefresh();

    if (state.currentView !== 'email' || !normalizeWhitespace(state.emailWorkspace.selectedMailboxId)) {
        return;
    }

    emailWorkspaceAutoRefreshTimer = window.setTimeout(async () => {
        try {
            await syncActiveEmailMailbox({ silent: true });
        } catch (_error) {
            // Sync errors are already surfaced inside syncActiveEmailMailbox.
        }
    }, 60000);
}

async function ensureEmailWorkspaceLoaded({ force = false, renderWhileLoading = true, preferredMailboxId = '', preserveThread = true } = {}) {
    if (!hasPermission(state.session, PERMISSIONS.SEND_EMAIL)) {
        return;
    }

    if (state.emailWorkspace.isLoading) {
        return;
    }

    const shouldReload = force || !state.emailWorkspace.initialized;

    if (!shouldReload) {
        scheduleEmailWorkspaceAutoRefresh();
        return;
    }

    state.emailWorkspace.isLoading = true;
    if (renderWhileLoading) {
        renderPanels();
    }

    try {
        const mailboxes = await dataService.listEmailMailboxes();
        state.emailWorkspace.mailboxes = mailboxes;
        state.emailWorkspace.syncStatus = mailboxes.flatMap((mailbox) => Array.isArray(mailbox.syncState) ? mailbox.syncState : []);
        state.emailWorkspace.selectedMailboxId = resolveInitialEmailMailboxId(mailboxes, preferredMailboxId || state.emailWorkspace.selectedMailboxId);
        state.emailWorkspace.initialized = true;
        await loadEmailThreads({ renderWhileLoading: false, preserveThread });
    } catch (error) {
        flashNotice(error.message || 'Unable to load the CRM inbox.', 'error');
    } finally {
        state.emailWorkspace.isLoading = false;
        if (renderWhileLoading) {
            renderPanels();
        }
        scheduleEmailWorkspaceAutoRefresh();
    }
}

async function loadEmailThreads({ renderWhileLoading = true, preserveThread = true } = {}) {
    const mailboxId = normalizeWhitespace(state.emailWorkspace.selectedMailboxId);

    if (!mailboxId) {
        state.emailWorkspace.threads = [];
        state.emailWorkspace.selectedThreadId = '';
        state.emailWorkspace.selectedThread = null;
        if (renderWhileLoading) {
            renderPanels();
        }
        return;
    }

    if (renderWhileLoading) {
        state.emailWorkspace.isLoading = true;
        renderPanels();
    }

    try {
        const threads = await dataService.listEmailThreads({
            mailboxId,
            folder: state.emailWorkspace.selectedFolder,
            searchQuery: state.emailWorkspace.searchQuery,
            limit: 120
        });

        state.emailWorkspace.threads = threads;

        const selectedThreadId = preserveThread && threads.some((thread) => thread.id === state.emailWorkspace.selectedThreadId)
            ? state.emailWorkspace.selectedThreadId
            : normalizeWhitespace(threads[0]?.id);

        state.emailWorkspace.selectedThreadId = selectedThreadId;

        if (selectedThreadId) {
            await loadSelectedEmailThread({ renderWhileLoading: false, markRead: true });
        } else {
            state.emailWorkspace.selectedThread = null;
        }
    } catch (error) {
        flashNotice(error.message || 'Unable to load email threads.', 'error');
    } finally {
        if (renderWhileLoading) {
            state.emailWorkspace.isLoading = false;
            renderPanels();
        }
        scheduleEmailWorkspaceAutoRefresh();
    }
}

async function loadSelectedEmailThread({ renderWhileLoading = true, markRead = false } = {}) {
    const threadId = normalizeWhitespace(state.emailWorkspace.selectedThreadId);
    const mailboxId = normalizeWhitespace(state.emailWorkspace.selectedMailboxId);

    if (!threadId || !mailboxId) {
        state.emailWorkspace.selectedThread = null;
        if (renderWhileLoading) {
            renderPanels();
        }
        return;
    }

    if (renderWhileLoading) {
        state.emailWorkspace.isLoading = true;
        renderPanels();
    }

    try {
        const thread = await dataService.getEmailThread(threadId);
        state.emailWorkspace.selectedThread = thread;

        if (thread && markRead && Number(thread.unreadCount) > 0) {
            await dataService.markEmailThreadRead({ threadId, mailboxId });
            state.emailWorkspace.threads = state.emailWorkspace.threads.map((entry) =>
                entry.id === threadId
                    ? { ...entry, unreadCount: 0 }
                    : entry
            );
            state.emailWorkspace.selectedThread = {
                ...thread,
                unreadCount: 0,
                messages: (thread.messages || []).map((message) => ({
                    ...message,
                    isRead: true
                }))
            };
        }
    } catch (error) {
        flashNotice(error.message || 'Unable to open that email thread.', 'error');
    } finally {
        if (renderWhileLoading) {
            state.emailWorkspace.isLoading = false;
            renderPanels();
        }
    }
}

async function syncActiveEmailMailbox({ silent = false } = {}) {
    const mailboxId = normalizeWhitespace(state.emailWorkspace.selectedMailboxId);

    if (!mailboxId) {
        return;
    }

    state.emailWorkspace.isSyncing = true;
    renderPanels();

    try {
        const result = await dataService.syncEmailMailbox({
            mailboxId,
            folders: ['INBOX', 'SENT']
        });
        state.emailWorkspace.syncStatus = Array.isArray(result.syncState) ? result.syncState : [];
        state.emailWorkspace.mailboxes = getEmailWorkspaceMailboxes().map((mailbox) =>
            mailbox.id === mailboxId
                ? { ...mailbox, syncState: state.emailWorkspace.syncStatus }
                : mailbox
        );
        await loadEmailThreads({ renderWhileLoading: false, preserveThread: true });
        if (!silent) {
            flashNotice(`Mailbox synced. ${Number(result.syncedCount || 0).toLocaleString()} messages checked.`, 'success');
        }
    } catch (error) {
        if (!silent) {
            flashNotice(error.message || 'Unable to sync the mailbox.', 'error');
        }
    } finally {
        state.emailWorkspace.isSyncing = false;
        renderPanels();
        scheduleEmailWorkspaceAutoRefresh();
    }
}

async function openEmailComposerDrawer(options = {}) {
    const lead = getAccessibleClientById(options.clientId);
    const senderOptions = getEmailSenderOptions();
    const requestedSenderMode = resolveEmailComposerSenderMode(options.senderMode, senderOptions);
    const preferredMailboxId = requestedSenderMode === 'support'
        ? getSupportMailboxSender()?.id
        : getPersonalMailboxSender()?.id;

    if (state.drawerMode) {
        closeDrawer();
    }

    if (state.modal) {
        closeModal();
    }

    state.emailComposer = {
        ...createDefaultEmailComposerState(),
        leadId: lead?.id || '',
        threadId: normalizeWhitespace(options.threadId),
        inReplyTo: normalizeWhitespace(options.inReplyTo),
        references: normalizeWhitespace(options.references),
        composeMode: normalizeWhitespace(options.composeMode) || 'new',
        recipientEmail: String(options.recipientEmail ?? lead?.email ?? ''),
        recipientName: normalizeWhitespace(options.recipientName || lead?.fullName || lead?.firstName || lead?.lastName || ''),
        senderMode: requestedSenderMode,
        subject: String(options.subject ?? ''),
        bodyText: String(options.bodyText ?? '')
    };

    state.currentView = 'email';
    state.mobileSearchOpen = false;
    state.sidebarOpen = false;
    state.emailWorkspace.previewMode = 'compose';
    if (normalizeWhitespace(options.threadId)) {
        state.emailWorkspace.selectedThreadId = normalizeWhitespace(options.threadId);
    }
    resetToolbarSuggestions();
    syncShellState();
    await ensureEmailWorkspaceLoaded({ preferredMailboxId, renderWhileLoading: false, preserveThread: true });
    render();
}

function canSendEmailForLead(lead) {
    if (!lead) {
        return false;
    }

    return hasPermission(state.session, PERMISSIONS.SEND_EMAIL)
        && canAccessClient(lead)
        && Boolean(normalizeEmailAddress(lead.email));
}

function getLeadEmailHistory(lead) {
    return Array.isArray(lead?.emailHistory)
        ? [...lead.emailHistory].sort((left, right) => Date.parse(right.receivedAt ?? right.sentAt ?? right.createdAt ?? 0) - Date.parse(left.receivedAt ?? left.sentAt ?? left.createdAt ?? 0))
        : [];
}

function formatEmailThreadTimestamp(value) {
    const timestamp = normalizeWhitespace(value);

    if (!timestamp) {
        return '—';
    }

    return isToday(timestamp)
        ? formatDateTime(timestamp).split(',').slice(1).join(',').trim()
        : formatDate(timestamp);
}

function getMailboxSignaturePlaceholder(senderName = '') {
    return `Best regards,\n${normalizeWhitespace(senderName || state.session?.name || 'Your Name') || 'Your Name'}\nBlue Chip Signals`;
}

function normalizeSignatureModeValue(value = '') {
    const normalized = normalizeWhitespace(value).toLowerCase();

    if (normalized === 'template') {
        return 'template';
    }

    if (normalized === 'html_override') {
        return 'html_override';
    }

    return 'plain_text';
}

function createDefaultSignatureTemplate(senderName = '', senderEmail = '') {
    return {
        displayName: normalizeWhitespace(senderName || state.session?.name || ''),
        jobTitle: '',
        phone: '',
        email: normalizeWhitespace(senderEmail || state.session?.email || '').toLowerCase(),
        websiteUrl: '',
        headshotPath: '',
        headshotUrl: '',
        socialLinks: [],
        ctaImagePath: '',
        ctaImageUrl: '',
        ctaHeadline: '',
        ctaSubtext: '',
        ctaUrl: '',
        disclaimerText: ''
    };
}

function normalizeSignatureTemplateDraft(template = {}, senderName = '', senderEmail = '') {
    const base = createDefaultSignatureTemplate(senderName, senderEmail);
    const socialLinks = Array.isArray(template.socialLinks) ? template.socialLinks : [];

    return {
        ...base,
        displayName: normalizeWhitespace(template.displayName ?? base.displayName),
        jobTitle: normalizeWhitespace(template.jobTitle),
        phone: normalizeWhitespace(template.phone),
        email: normalizeWhitespace(template.email ?? base.email).toLowerCase(),
        websiteUrl: normalizeWhitespace(template.websiteUrl),
        headshotPath: normalizeWhitespace(template.headshotPath),
        headshotUrl: normalizeWhitespace(template.headshotUrl),
        socialLinks: socialLinks
            .map((entry) => ({
                network: normalizeWhitespace(entry?.network).toLowerCase(),
                url: normalizeWhitespace(entry?.url),
                label: normalizeWhitespace(entry?.label)
            }))
            .filter((entry) => entry.network || entry.url)
            .slice(0, 4),
        ctaImagePath: normalizeWhitespace(template.ctaImagePath),
        ctaImageUrl: normalizeWhitespace(template.ctaImageUrl),
        ctaHeadline: normalizeWhitespace(template.ctaHeadline),
        ctaSubtext: normalizeWhitespace(template.ctaSubtext),
        ctaUrl: normalizeWhitespace(template.ctaUrl),
        disclaimerText: String(template.disclaimerText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
    };
}

function getSignatureEditorInitialTab(sender, senderName = '', senderEmail = '') {
    const mode = normalizeSignatureModeValue(sender?.signatureMode);

    if (mode === 'html_override') {
        return 'html';
    }

    if (mode === 'plain_text' && !sender?.signatureTemplate?.headshotPath && !sender?.signatureTemplate?.ctaImagePath) {
        return 'preview';
    }

    return 'template';
}

function buildSignatureSocialRows(template) {
    const rows = Array.from({ length: 4 }, (_, index) => template.socialLinks[index] || {
        network: '',
        url: '',
        label: ''
    });

    return rows;
}

function getSignatureSocialNetworkOptions() {
    return [
        { value: '', label: 'No icon' },
        { value: 'linkedin', label: 'LinkedIn' },
        { value: 'facebook', label: 'Facebook' },
        { value: 'x', label: 'X / Twitter' },
        { value: 'telegram', label: 'Telegram' },
        { value: 'instagram', label: 'Instagram' },
        { value: 'youtube', label: 'YouTube' }
    ];
}

function getSignatureSocialIconMarkup(network = '') {
    const normalized = normalizeWhitespace(network).toLowerCase();

    if (normalized === 'linkedin') {
        return `
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <rect x="2" y="2" width="20" height="20" rx="6" fill="#0A66C2"></rect>
                <circle cx="8" cy="8.15" r="1.45" fill="#ffffff"></circle>
                <rect x="6.7" y="10" width="2.6" height="7.2" rx="1.1" fill="#ffffff"></rect>
                <path d="M12 10h2.25v1.05c.45-.7 1.18-1.25 2.52-1.25 2 0 3.23 1.28 3.23 3.74v3.66h-2.62v-3.23c0-1.04-.38-1.75-1.31-1.75-.72 0-1.18.48-1.38.95-.08.18-.1.42-.1.67v3.36H12z" fill="#ffffff"></path>
            </svg>
        `;
    }

    if (normalized === 'facebook') {
        return `
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <circle cx="12" cy="12" r="10" fill="#1877F2"></circle>
                <path d="M13.3 8.2h1.76V5.74c-.3-.04-1.3-.12-2.48-.12-2.46 0-4.14 1.5-4.14 4.26v2.38H5.7v2.78h2.74v7h3.34v-7h2.62l.42-2.78h-3.04v-2.1c0-.8.22-1.96 2.02-1.96z" fill="#ffffff"></path>
            </svg>
        `;
    }

    if (normalized === 'telegram') {
        return `
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <circle cx="12" cy="12" r="10" fill="#24A1DE"></circle>
                <path d="M17.46 7.38 6.85 11.53c-.73.3-.72.7-.14.88l2.72.85 1.05 3.28c.13.37.06.52.45.52.3 0 .43-.14.6-.3l1.32-1.28 2.74 2.03c.5.28.86.14.99-.47l1.8-8.5c.2-.74-.28-1.08-.92-.79Zm-1.56 2.03-4.92 4.43-.19 2.02-.86-2.83 5.97-3.77c.26-.16.5-.07.3.15Z" fill="#ffffff"></path>
            </svg>
        `;
    }

    if (normalized === 'instagram') {
        return `
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <rect x="2" y="2" width="20" height="20" rx="6" fill="#DD2A7B"></rect>
                <rect x="7" y="7" width="10" height="10" rx="3" fill="none" stroke="#ffffff" stroke-width="1.9"></rect>
                <circle cx="12" cy="12" r="2.5" fill="none" stroke="#ffffff" stroke-width="1.9"></circle>
                <circle cx="16.2" cy="7.9" r="1.1" fill="#ffffff"></circle>
            </svg>
        `;
    }

    if (normalized === 'youtube') {
        return `
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <rect x="3" y="6" width="18" height="12" rx="4" fill="#FF0033"></rect>
                <path d="M10 9.2v5.6l4.9-2.8z" fill="#ffffff"></path>
            </svg>
        `;
    }

    return `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect x="2" y="2" width="20" height="20" rx="6" fill="#111111"></rect>
            <path d="M7.3 6.7h2.6l2.58 3.4 2.86-3.4h1.88l-3.9 4.61 4.59 6.01h-2.62l-2.95-3.87-3.25 3.87H7.2l4.35-5.16z" fill="#ffffff"></path>
        </svg>
    `;
}

function buildPlainTextSignatureFallback({ senderName = '', signatureMode = 'plain_text', signatureTemplate = {}, signatureHtmlOverride = '', signatureText = '' } = {}) {
    const resolvedMode = normalizeSignatureModeValue(signatureMode);

    if (resolvedMode === 'template') {
        const template = normalizeSignatureTemplateDraft(signatureTemplate, senderName);
        const lines = [
            template.displayName || normalizeWhitespace(senderName),
            template.jobTitle,
            template.phone ? `T: ${template.phone}` : '',
            template.email ? `E: ${template.email}` : '',
            template.websiteUrl ? `W: ${template.websiteUrl}` : '',
            template.disclaimerText ? `\n${template.disclaimerText}` : ''
        ].filter(Boolean);

        return lines.join('\n').trim() || getMailboxSignaturePlaceholder(senderName);
    }

    if (resolvedMode === 'html_override') {
        const stripped = String(signatureHtmlOverride ?? '')
            .replace(/<\s*br\s*\/?>/gi, '\n')
            .replace(/<\s*\/\s*(p|div|tr|li|table|tbody)\s*>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .split('\n')
            .map((line) => line.replace(/\s+/g, ' ').trim())
            .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
            .join('\n')
            .trim();

        return stripped || getMailboxSignaturePlaceholder(senderName);
    }

    return String(signatureText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim() || getMailboxSignaturePlaceholder(senderName);
}

function sanitizeSignatureHtmlPreview(value = '') {
    let html = String(value ?? '').trim();

    if (!html) {
        return '';
    }

    html = html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|video|audio|svg|math|meta|link|base)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
        .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|video|audio|svg|math|meta|link|base)\b[^>]*\/?>/gi, '')
        .replace(/\son[a-z-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

    return html;
}

function renderSignaturePreviewCard({ senderName = '', senderEmail = '', signatureMode = 'plain_text', signatureTemplate = {}, signatureHtmlOverride = '', signatureText = '' } = {}) {
    const resolvedMode = normalizeSignatureModeValue(signatureMode);
    const template = normalizeSignatureTemplateDraft(signatureTemplate, senderName, senderEmail);

    if (resolvedMode === 'html_override') {
        const sanitizedHtml = sanitizeSignatureHtmlPreview(signatureHtmlOverride);

        return sanitizedHtml
            ? `<div class="crm-signature-preview-card crm-signature-preview-card-html">${sanitizedHtml}</div>`
            : '<div class="crm-signature-preview-empty">Your custom HTML signature will preview here once you add markup.</div>';
    }

    if (resolvedMode === 'plain_text') {
        return `
            <div class="crm-signature-preview-card crm-signature-preview-card-plain">
                <pre>${escapeHtml(buildPlainTextSignatureFallback({
                    senderName,
                    signatureMode: resolvedMode,
                    signatureTemplate: template,
                    signatureHtmlOverride,
                    signatureText
                }))}</pre>
            </div>
        `;
    }

    const displayName = template.displayName || normalizeWhitespace(senderName) || 'Your Name';
    const websiteLabel = normalizeWhitespace(template.websiteUrl).replace(/^https?:\/\//i, '').replace(/\/$/, '');
    const headshotMarkup = template.headshotUrl
        ? `<img src="${escapeHtml(template.headshotUrl)}" alt="${escapeHtml(displayName)}">`
        : `<span>${escapeHtml((displayName || 'Y').charAt(0).toUpperCase())}</span>`;
    const socialLinks = buildSignatureSocialRows(template).filter((entry) => entry.network && entry.url);
    const disclaimerMarkup = template.disclaimerText
        ? `<div class="crm-signature-preview-disclaimer">${escapeHtml(template.disclaimerText)}</div>`
        : '';
    const contactRows = [
        template.phone ? { label: 'T', value: template.phone } : null,
        template.email ? { label: 'E', value: template.email } : null,
        websiteLabel ? { label: 'W', value: websiteLabel } : null
    ].filter(Boolean);
    const contactMarkup = contactRows.length ? `
        <div class="crm-signature-preview-copy crm-signature-preview-copy-contact">
            <div class="crm-signature-preview-contact">
                ${contactRows.map((row) => `
                    <div class="crm-signature-preview-contact-row">
                        <span class="crm-signature-preview-contact-label">${escapeHtml(row.label)}:</span>
                        <span class="crm-signature-preview-contact-value">${escapeHtml(row.value)}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    ` : '';

    return `
        <div class="crm-signature-preview-card">
            <div class="crm-signature-preview-top">
                <div class="crm-signature-preview-primary">
                    <strong>${escapeHtml(displayName)}</strong>
                    <span>${escapeHtml(template.jobTitle || 'Your title')}</span>
                    ${socialLinks.length ? `
                        <div class="crm-signature-preview-social">
                            ${socialLinks.map((entry) => `
                                <a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(entry.network)}">${getSignatureSocialIconMarkup(entry.network)}</a>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
                <div class="crm-signature-preview-avatar">${headshotMarkup}</div>
                ${contactMarkup}
            </div>
            ${(template.ctaHeadline || template.ctaSubtext || template.ctaImageUrl) ? `
                <div class="crm-signature-preview-banner ${template.ctaImageUrl ? 'has-image' : ''}">
                    ${template.ctaImageUrl ? `
                        <div class="crm-signature-preview-banner-media">
                            <img src="${escapeHtml(template.ctaImageUrl)}" alt="${escapeHtml(template.ctaHeadline || 'Banner image')}">
                        </div>
                    ` : ''}
                    <div class="crm-signature-preview-banner-copy">
                        ${template.ctaHeadline ? `<strong>${escapeHtml(template.ctaHeadline)}</strong>` : ''}
                        ${template.ctaSubtext ? `<span>${escapeHtml(template.ctaSubtext)}</span>` : ''}
                        ${template.ctaUrl ? `<em>${escapeHtml(normalizeWhitespace(template.ctaUrl).replace(/^https?:\/\//i, ''))}</em>` : ''}
                    </div>
                </div>
            ` : ''}
            ${disclaimerMarkup}
        </div>
    `;
}

function renderMailboxSignatureBuilder({ mailboxKind = 'personal', sender = null, senderName = '', senderEmail = '' } = {}) {
    const resolvedTemplate = normalizeSignatureTemplateDraft(sender?.signatureTemplate, senderName, senderEmail);
    const resolvedMode = normalizeSignatureModeValue(sender?.signatureMode || (sender?.signatureHtmlOverride ? 'html_override' : (sender?.signatureText ? 'plain_text' : 'template')));
    const activeTab = getSignatureEditorInitialTab(sender, senderName, senderEmail);
    const socialRows = buildSignatureSocialRows(resolvedTemplate);
    const networkOptions = getSignatureSocialNetworkOptions();
    const activeSubpanel = getValidSignatureSubpanel(state.expandedSignatureSubpanel);
    const previewButtonLabel = state.showSignaturePreview ? 'Hide preview' : 'Show preview';

    return `
        <div class="crm-signature-editor" data-mailbox-kind="${escapeHtml(mailboxKind)}">
            <input type="hidden" name="signatureMode" value="${escapeHtml(resolvedMode)}" data-signature-mode-input>
            <div class="crm-signature-editor-head">
                <div class="crm-signature-mode-pill" data-signature-mode-label>${escapeHtml(resolvedMode === 'html_override' ? 'Advanced HTML' : (resolvedMode === 'template' ? 'Template builder' : 'Plain text only'))}</div>
                <div class="crm-signature-tabs" role="tablist" aria-label="Email signature editor">
                    <button class="crm-signature-tab ${activeTab === 'template' ? 'is-active' : ''}" type="button" data-signature-tab-button data-signature-tab="template">Template</button>
                    <button class="crm-signature-tab ${activeTab === 'html' ? 'is-active' : ''}" type="button" data-signature-tab-button data-signature-tab="html">Advanced HTML</button>
                    <button class="crm-signature-tab ${activeTab === 'preview' ? 'is-active' : ''}" type="button" data-signature-tab-button data-signature-tab="preview">Plain Text Preview</button>
                </div>
            </div>

            <section class="crm-signature-panel ${activeTab === 'template' ? 'is-active' : ''}" data-signature-panel="template">
                <div class="crm-signature-template-toolbar">
                    <div class="crm-signature-group-tabs" role="tablist" aria-label="Template builder groups">
                        <button
                            class="crm-signature-group-tab ${activeSubpanel === 'identity' ? 'is-active' : ''}"
                            type="button"
                            data-signature-group-button
                            data-signature-group="identity"
                        >
                            Identity
                        </button>
                        <button
                            class="crm-signature-group-tab ${activeSubpanel === 'media' ? 'is-active' : ''}"
                            type="button"
                            data-signature-group-button
                            data-signature-group="media"
                        >
                            Media
                        </button>
                        <button
                            class="crm-signature-group-tab ${activeSubpanel === 'links' ? 'is-active' : ''}"
                            type="button"
                            data-signature-group-button
                            data-signature-group="links"
                        >
                            Links + CTA
                        </button>
                    </div>
                    <button
                        class="crm-button-ghost crm-signature-preview-toggle"
                        type="button"
                        data-signature-preview-toggle
                    >
                        <i class="fa-regular fa-eye"></i> ${escapeHtml(previewButtonLabel)}
                    </button>
                </div>

                <div class="crm-signature-template-shell ${state.showSignaturePreview ? '' : 'is-preview-hidden-mobile'}" data-signature-template-shell>
                    <div class="crm-signature-template-fields">
                        <section class="crm-signature-section-card ${activeSubpanel === 'identity' ? 'is-active-mobile' : ''}" data-signature-group-panel="identity">
                            <div class="crm-signature-section-head">
                                <div>
                                    <strong>Identity & contact</strong>
                                    <span>Core fields shown across the top row of the signature card.</span>
                                </div>
                            </div>
                            <div class="crm-signature-grid">
                                <label class="crm-settings-field">
                                    <span class="form-label">Display name</span>
                                    <input class="crm-input" name="signatureDisplayName" value="${escapeHtml(resolvedTemplate.displayName || senderName)}" placeholder="Your full name">
                                </label>
                                <label class="crm-settings-field">
                                    <span class="form-label">Job title</span>
                                    <input class="crm-input" name="signatureJobTitle" value="${escapeHtml(resolvedTemplate.jobTitle)}" placeholder="Sales Executive">
                                </label>
                                <label class="crm-settings-field">
                                    <span class="form-label">Phone</span>
                                    <input class="crm-input" name="signaturePhone" value="${escapeHtml(resolvedTemplate.phone)}" placeholder="+1 (555) 555-5555">
                                </label>
                                <label class="crm-settings-field">
                                    <span class="form-label">Email</span>
                                    <input class="crm-input" name="signatureEmail" value="${escapeHtml(resolvedTemplate.email || senderEmail)}" placeholder="you@bluechipsignals.online">
                                </label>
                                <label class="crm-settings-field crm-settings-field-full">
                                    <span class="form-label">Website URL</span>
                                    <input class="crm-input" name="signatureWebsiteUrl" value="${escapeHtml(resolvedTemplate.websiteUrl)}" placeholder="https://bluechipsignals.online">
                                </label>
                            </div>
                        </section>

                        <section class="crm-signature-section-card ${activeSubpanel === 'media' ? 'is-active-mobile' : ''}" data-signature-group-panel="media">
                            <div class="crm-signature-section-head">
                                <div>
                                    <strong>Media</strong>
                                    <span>Keep asset previews compact while still showing exactly what will be used.</span>
                                </div>
                            </div>
                            <div class="crm-signature-asset-grid">
                                ${renderSignatureAssetField({
                                    label: 'Headshot',
                                    inputName: 'signatureHeadshotUpload',
                                    hiddenName: 'signatureHeadshotPath',
                                    currentPath: resolvedTemplate.headshotPath,
                                    currentUrl: resolvedTemplate.headshotUrl,
                                    mailboxKind,
                                    assetKind: 'headshot'
                                })}
                                ${renderSignatureAssetField({
                                    label: 'CTA banner',
                                    inputName: 'signatureBannerUpload',
                                    hiddenName: 'signatureCtaImagePath',
                                    currentPath: resolvedTemplate.ctaImagePath,
                                    currentUrl: resolvedTemplate.ctaImageUrl,
                                    mailboxKind,
                                    assetKind: 'banner'
                                })}
                            </div>
                        </section>

                        <section class="crm-signature-section-card ${activeSubpanel === 'links' ? 'is-active-mobile' : ''}" data-signature-group-panel="links">
                            <div class="crm-signature-section-head">
                                <div>
                                    <strong>Social links, CTA & disclaimer</strong>
                                    <span>Fine-tune the lower card content without stretching the editor into one long column.</span>
                                </div>
                            </div>
                            <div class="crm-signature-grid">
                                ${socialRows.map((entry, index) => `
                                    <div class="crm-signature-social-row">
                                        <label class="crm-settings-field">
                                            <span class="form-label">Social ${index + 1}</span>
                                            <select class="crm-select" name="signatureSocialNetwork${index + 1}">
                                                ${networkOptions.map((option) => `
                                                    <option value="${escapeHtml(option.value)}" ${option.value === entry.network ? 'selected' : ''}>${escapeHtml(option.label)}</option>
                                                `).join('')}
                                            </select>
                                        </label>
                                        <label class="crm-settings-field">
                                            <span class="form-label">Link</span>
                                            <input class="crm-input" name="signatureSocialUrl${index + 1}" value="${escapeHtml(entry.url)}" placeholder="https://...">
                                        </label>
                                    </div>
                                `).join('')}
                                <label class="crm-settings-field">
                                    <span class="form-label">CTA headline</span>
                                    <input class="crm-input" name="signatureCtaHeadline" value="${escapeHtml(resolvedTemplate.ctaHeadline)}" placeholder="Book your health check">
                                </label>
                                <label class="crm-settings-field">
                                    <span class="form-label">CTA link</span>
                                    <input class="crm-input" name="signatureCtaUrl" value="${escapeHtml(resolvedTemplate.ctaUrl)}" placeholder="https://bluechipsignals.online/book">
                                </label>
                                <label class="crm-settings-field crm-settings-field-full">
                                    <span class="form-label">CTA subtext</span>
                                    <textarea class="crm-textarea crm-signature-mini-textarea" name="signatureCtaSubtext" placeholder="Short supporting copy for the banner card.">${escapeHtml(resolvedTemplate.ctaSubtext)}</textarea>
                                </label>
                                <label class="crm-settings-field crm-settings-field-full">
                                    <span class="form-label">Disclaimer</span>
                                    <textarea class="crm-textarea crm-signature-mini-textarea" name="signatureDisclaimerText" placeholder="Confidentiality or compliance note shown in fine print at the bottom of the signature.">${escapeHtml(resolvedTemplate.disclaimerText)}</textarea>
                                </label>
                            </div>
                        </section>
                    </div>

                    <div class="crm-signature-preview-shell crm-signature-preview-shell-template" data-signature-template-preview>
                        <div class="crm-signature-preview-head">
                            <strong>Live preview</strong>
                            <span>The CRM preview matches your theme; sent emails use an email-safe HTML version.</span>
                        </div>
                        <div data-signature-preview>${renderSignaturePreviewCard({
                            senderName,
                            senderEmail,
                            signatureMode: 'template',
                            signatureTemplate: resolvedTemplate,
                            signatureText: sender?.signatureText || ''
                        })}</div>
                    </div>
                </div>
            </section>

            <section class="crm-signature-panel ${activeTab === 'html' ? 'is-active' : ''}" data-signature-panel="html">
                <div class="crm-signature-html-shell">
                    <label class="crm-settings-field crm-settings-field-full">
                        <span class="form-label">Custom HTML signature</span>
                        <textarea class="crm-textarea crm-signature-html-textarea" name="signatureHtmlOverride" placeholder="<table>...</table>">${escapeHtml(sender?.signatureHtmlOverride || '')}</textarea>
                        <span class="panel-subtitle">We sanitize this HTML before sending. Keep it email-client friendly: tables, inline styles, links, and images only.</span>
                    </label>
                    <div class="crm-signature-preview-shell">
                        <div class="crm-signature-preview-head">
                            <strong>Sanitized preview</strong>
                            <span>The sent version strips unsafe tags, scripts, embeds, and external styles.</span>
                        </div>
                        <div data-signature-preview>${renderSignaturePreviewCard({
                            senderName,
                            senderEmail,
                            signatureMode: 'html_override',
                            signatureTemplate: resolvedTemplate,
                            signatureHtmlOverride: sender?.signatureHtmlOverride || '',
                            signatureText: sender?.signatureText || ''
                        })}</div>
                    </div>
                </div>
            </section>

            <section class="crm-signature-panel ${activeTab === 'preview' ? 'is-active' : ''}" data-signature-panel="preview">
                <div class="crm-signature-section-card crm-signature-section-card-plain">
                    <div class="crm-signature-preview-head">
                        <strong>Plain text fallback</strong>
                        <span>This version is used for text-only delivery and legacy email clients.</span>
                    </div>
                    <div class="crm-signature-plain-actions">
                        <button class="crm-button-ghost" type="button" data-signature-set-mode="plain_text">Use Plain Text Only</button>
                    </div>
                    <label class="crm-settings-field crm-settings-field-full">
                        <span class="form-label">Fallback signature text</span>
                        <textarea class="crm-textarea crm-signature-plain-textarea" name="signatureText" data-signature-plain-textarea>${escapeHtml(buildPlainTextSignatureFallback({
                            senderName,
                            signatureMode: resolvedMode,
                            signatureTemplate: resolvedTemplate,
                            signatureHtmlOverride: sender?.signatureHtmlOverride || '',
                            signatureText: sender?.signatureText || ''
                        }))}</textarea>
                        <span class="panel-subtitle">This text stays editable. If you choose “Use Plain Text Only,” this becomes the live signature.</span>
                    </label>
                </div>
            </section>
        </div>
    `;
}

function getSignatureAssetFeedbackKey(mailboxKind = 'personal', assetKind = 'headshot') {
    const normalizedMailboxKind = normalizeWhitespace(mailboxKind).toLowerCase() === 'support' ? 'support' : 'personal';
    const normalizedAssetKind = normalizeWhitespace(assetKind).toLowerCase() === 'banner' ? 'banner' : 'headshot';
    return `${normalizedMailboxKind}-${normalizedAssetKind}-asset-feedback`;
}

function renderSignatureAssetField({ label = '', inputName = '', hiddenName = '', currentPath = '', currentUrl = '', mailboxKind = 'personal', assetKind = 'headshot' } = {}) {
    return `
        <div class="crm-signature-asset-card crm-signature-asset-card-${escapeHtml(assetKind)}">
            <div class="crm-signature-asset-head">
                <strong>${escapeHtml(label)}</strong>
                <span>${currentPath ? 'Uploaded' : 'Optional'}</span>
            </div>
            <div class="crm-signature-asset-preview crm-signature-asset-preview-${escapeHtml(assetKind)} ${currentUrl ? 'has-image' : ''}" data-signature-asset-preview="${escapeHtml(assetKind)}">
                ${currentUrl ? `<img src="${escapeHtml(currentUrl)}" alt="${escapeHtml(label)}">` : '<span>No image selected</span>'}
            </div>
            <input type="hidden" name="${escapeHtml(hiddenName)}" value="${escapeHtml(currentPath)}" data-signature-asset-path="${escapeHtml(assetKind)}">
            <div class="crm-signature-asset-actions" data-inline-feedback-container="${escapeHtml(getSignatureAssetFeedbackKey(mailboxKind, assetKind))}">
                <label class="crm-button-secondary crm-signature-upload-button">
                    <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="hidden" name="${escapeHtml(inputName)}" data-signature-upload="${escapeHtml(assetKind)}" data-mailbox-kind="${escapeHtml(mailboxKind)}">
                    <i class="fa-solid fa-cloud-arrow-up"></i> Upload
                </label>
                <button class="crm-button-ghost crm-signature-clear-button" type="button" data-signature-clear-asset="${escapeHtml(assetKind)}">Clear</button>
            </div>
        </div>
    `;
}

function collectSignatureTemplateFromForm(form, { senderName = '', senderEmail = '' } = {}) {
    const formData = new FormData(form);
    const socialLinks = Array.from({ length: 4 }, (_, index) => {
        const rowIndex = index + 1;
        return {
            network: normalizeWhitespace(formData.get(`signatureSocialNetwork${rowIndex}`)).toLowerCase(),
            url: normalizeWhitespace(formData.get(`signatureSocialUrl${rowIndex}`)),
            label: ''
        };
    }).filter((entry) => entry.network && entry.url);

    return normalizeSignatureTemplateDraft({
        displayName: formData.get('signatureDisplayName') || senderName,
        jobTitle: formData.get('signatureJobTitle'),
        phone: formData.get('signaturePhone'),
        email: formData.get('signatureEmail') || senderEmail,
        websiteUrl: formData.get('signatureWebsiteUrl'),
        headshotPath: formData.get('signatureHeadshotPath'),
        headshotUrl: form.querySelector('[data-signature-asset-preview="headshot"] img')?.getAttribute('src') || '',
        socialLinks,
        ctaImagePath: formData.get('signatureCtaImagePath'),
        ctaImageUrl: form.querySelector('[data-signature-asset-preview="banner"] img')?.getAttribute('src') || '',
        ctaHeadline: formData.get('signatureCtaHeadline'),
        ctaSubtext: formData.get('signatureCtaSubtext'),
        ctaUrl: formData.get('signatureCtaUrl'),
        disclaimerText: formData.get('signatureDisclaimerText')
    }, senderName, senderEmail);
}

function collectSignatureDraftFromForm(form) {
    const formData = new FormData(form);
    const senderName = normalizeWhitespace(formData.get('senderName')) || state.session?.name || '';
    const senderEmail = normalizeWhitespace(
        formData.get('signatureEmail')
        || formData.get('senderEmail')
        || formData.get('senderEmailDisplay')
        || state.session?.email
    ).toLowerCase();
    const signatureMode = normalizeSignatureModeValue(formData.get('signatureMode'));
    const signatureTemplate = collectSignatureTemplateFromForm(form, { senderName, senderEmail });
    const signatureHtmlOverride = String(formData.get('signatureHtmlOverride') ?? '');
    const signatureText = String(formData.get('signatureText') ?? '');

    return {
        senderName,
        senderEmail,
        signatureMode,
        signatureTemplate,
        signatureHtmlOverride,
        signatureText
    };
}

function getSignatureModeLabel(value = '') {
    const mode = normalizeSignatureModeValue(value);

    if (mode === 'template') {
        return 'Template builder';
    }

    if (mode === 'html_override') {
        return 'Advanced HTML';
    }

    return 'Plain text only';
}

function setSignatureEditorActiveTab(form, nextTab) {
    const normalizedTab = ['template', 'html', 'preview'].includes(nextTab) ? nextTab : 'template';

    form.querySelectorAll('[data-signature-tab-button]').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.signatureTab === normalizedTab);
    });

    form.querySelectorAll('[data-signature-panel]').forEach((panel) => {
        panel.classList.toggle('is-active', panel.dataset.signaturePanel === normalizedTab);
    });
}

function setSignatureEditorActiveSubpanel(form, nextSubpanel) {
    if (!form) {
        return;
    }

    const normalizedSubpanel = getValidSignatureSubpanel(nextSubpanel);
    state.expandedSignatureSubpanel = normalizedSubpanel;

    form.querySelectorAll('[data-signature-group-button]').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.signatureGroup === normalizedSubpanel);
    });

    form.querySelectorAll('[data-signature-group-panel]').forEach((panel) => {
        panel.classList.toggle('is-active-mobile', panel.dataset.signatureGroupPanel === normalizedSubpanel);
    });
}

function setSignaturePreviewVisibility(form, shouldShow) {
    if (!form) {
        return;
    }

    state.showSignaturePreview = Boolean(shouldShow);
    const templateShell = form.querySelector('[data-signature-template-shell]');

    if (templateShell) {
        templateShell.classList.toggle('is-preview-hidden-mobile', !state.showSignaturePreview);
    }

    form.querySelectorAll('[data-signature-preview-toggle]').forEach((button) => {
        button.innerHTML = `<i class="fa-regular fa-eye"></i> ${escapeHtml(state.showSignaturePreview ? 'Hide preview' : 'Show preview')}`;
    });
}

function updateSignatureEditorPreview(form, { preservePlainText = false } = {}) {
    if (!form) {
        return;
    }

    const draft = collectSignatureDraftFromForm(form);
    const editor = form.querySelector('.crm-signature-editor');
    setMailboxSignatureDraft(editor?.dataset.mailboxKind, draft);
    const previewMarkup = renderSignaturePreviewCard(draft);

    form.querySelectorAll('[data-signature-preview]').forEach((previewNode) => {
        previewNode.innerHTML = previewMarkup;
    });

    const modeLabel = form.querySelector('[data-signature-mode-label]');

    if (modeLabel) {
        modeLabel.textContent = getSignatureModeLabel(draft.signatureMode);
    }

    const plainTextArea = form.querySelector('[data-signature-plain-textarea]');

    if (plainTextArea && (!preservePlainText || draft.signatureMode !== 'plain_text')) {
        plainTextArea.value = buildPlainTextSignatureFallback(draft);
    }
}

function setSignatureEditorMode(form, mode, { activateTab = true } = {}) {
    const normalizedMode = normalizeSignatureModeValue(mode);
    const modeInput = form?.querySelector('[data-signature-mode-input]');

    if (modeInput) {
        modeInput.value = normalizedMode;
    }

    if (activateTab) {
        setSignatureEditorActiveTab(form, normalizedMode === 'html_override' ? 'html' : (normalizedMode === 'template' ? 'template' : 'preview'));
    }

    updateSignatureEditorPreview(form, { preservePlainText: normalizedMode === 'plain_text' });
}

function getMailboxSenderForKind(mailboxKind = 'personal') {
    return normalizeWhitespace(mailboxKind).toLowerCase() === 'support'
        ? getSupportMailboxSender()
        : getPersonalMailboxSender();
}

async function handleSignatureAssetUpload(fileInput) {
    const form = fileInput?.closest('form');
    const [file] = fileInput?.files ?? [];

    if (!form || !file) {
        return;
    }

    const mailboxKind = normalizeWhitespace(fileInput.dataset.mailboxKind).toLowerCase() === 'support' ? 'support' : 'personal';
    const sender = getMailboxSenderForKind(mailboxKind);
    const signatureDraft = collectSignatureDraftFromForm(form);
    const uploadResult = normalizeWhitespace(fileInput.dataset.signatureUpload) === 'banner'
        ? await dataService.uploadSignatureBanner(sender?.id, file, {
            senderKind: mailboxKind,
            ownerUserId: sender?.ownerUserId || state.session?.id || '',
            senderEmail: signatureDraft.senderEmail || sender?.senderEmail || ''
        })
        : await dataService.uploadSignatureHeadshot(sender?.id, file, {
            senderKind: mailboxKind,
            ownerUserId: sender?.ownerUserId || state.session?.id || '',
            senderEmail: signatureDraft.senderEmail || sender?.senderEmail || ''
        });

    const assetKind = normalizeWhitespace(fileInput.dataset.signatureUpload) === 'banner' ? 'banner' : 'headshot';
    const assetLabel = assetKind === 'banner' ? 'CTA banner' : 'Headshot';
    const feedbackKey = getSignatureAssetFeedbackKey(mailboxKind, assetKind);
    const hiddenInput = form.querySelector(`[data-signature-asset-path="${assetKind}"]`);
    const previewContainer = form.querySelector(`[data-signature-asset-preview="${assetKind}"]`);
    const assetCard = previewContainer?.closest('.crm-signature-asset-card');
    const assetStatusLabel = assetCard?.querySelector('.crm-signature-asset-head span');

    if (hiddenInput) {
        hiddenInput.value = uploadResult.path;
    }

    if (previewContainer) {
        const localPreviewUrl = URL.createObjectURL(file);
        setSignatureAssetPreview(previewContainer, localPreviewUrl, assetLabel);
    }

    if (assetStatusLabel) {
        assetStatusLabel.textContent = 'Uploaded';
    }

    fileInput.value = '';
    setSignatureEditorMode(form, 'template');
    showInlineActionFeedback(feedbackKey, `${assetLabel} uploaded. Save the mailbox to apply it.`, 'success');
}

function clearSignatureAsset(form, assetKind = 'headshot') {
    if (!form) {
        return;
    }

    const normalizedAssetKind = normalizeWhitespace(assetKind).toLowerCase() === 'banner' ? 'banner' : 'headshot';
    const assetLabel = normalizedAssetKind === 'banner' ? 'CTA banner' : 'Headshot';
    const mailboxKind = normalizeWhitespace(form.querySelector('.crm-signature-editor')?.dataset.mailboxKind).toLowerCase() === 'support' ? 'support' : 'personal';
    const hiddenInput = form.querySelector(`[data-signature-asset-path="${normalizedAssetKind}"]`);
    const previewContainer = form.querySelector(`[data-signature-asset-preview="${normalizedAssetKind}"]`);
    const assetCard = previewContainer?.closest('.crm-signature-asset-card');
    const assetStatusLabel = assetCard?.querySelector('.crm-signature-asset-head span');

    if (hiddenInput) {
        hiddenInput.value = '';
    }

    if (previewContainer) {
        setSignatureAssetPreview(previewContainer, '', assetLabel);
    }

    if (assetStatusLabel) {
        assetStatusLabel.textContent = 'Optional';
    }

    updateSignatureEditorPreview(form, { preservePlainText: normalizeSignatureModeValue(form.querySelector('[data-signature-mode-input]')?.value) === 'plain_text' });
    showInlineActionFeedback(getSignatureAssetFeedbackKey(mailboxKind, normalizedAssetKind), `${assetLabel} removed from this draft.`, 'success');
}

function setSignatureAssetPreview(previewContainer, imageUrl = '', altText = 'Signature image') {
    if (!previewContainer) {
        return;
    }

    const previousObjectUrl = normalizeWhitespace(previewContainer.dataset.objectUrl);

    if (previousObjectUrl && previousObjectUrl.startsWith('blob:') && previousObjectUrl !== imageUrl) {
        try {
            URL.revokeObjectURL(previousObjectUrl);
        } catch (_error) {
            // Ignore browser cleanup failures.
        }
    }

    if (imageUrl) {
        previewContainer.classList.add('has-image');
        previewContainer.dataset.objectUrl = imageUrl.startsWith('blob:') ? imageUrl : '';
        previewContainer.innerHTML = `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(altText)}">`;
        return;
    }

    previewContainer.classList.remove('has-image');
    previewContainer.dataset.objectUrl = '';
    previewContainer.innerHTML = '<span>No image selected</span>';
}

function buildEmailThreadLeadLabel(thread) {
    const leadId = normalizeWhitespace(thread?.leadId);

    if (!leadId) {
        return '';
    }

    const lead = getAccessibleClientById(leadId);
    return lead?.fullName || `Lead #${leadId}`;
}

function buildReplySubject(subject = '') {
    const normalizedSubject = normalizeWhitespace(subject);

    if (!normalizedSubject) {
        return 'Re: No subject';
    }

    return /^re:/i.test(normalizedSubject)
        ? normalizedSubject
        : `Re: ${normalizedSubject}`;
}

function normalizeEmailBodyForDisplay(value = '') {
    return String(value ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();
}

function splitEmailBodyForDisplay(value = '') {
    const normalizedBody = normalizeEmailBodyForDisplay(value);

    if (!normalizedBody) {
        return {
            body: '',
            quoted: ''
        };
    }

    const lines = normalizedBody.split('\n');
    const quoteStartIndex = lines.findIndex((line, index) => {
        const normalizedLine = line.trim();
        const nextLine = (lines[index + 1] || '').trim();

        if (!normalizedLine) {
            return false;
        }

        if (/^>/.test(normalizedLine)) {
            return true;
        }

        if (/^On .+ wrote:$/i.test(normalizedLine)) {
            return true;
        }

        if (/^From:\s/i.test(normalizedLine) && (/^Sent:\s/i.test(nextLine) || /^Date:\s/i.test(nextLine))) {
            return true;
        }

        return false;
    });

    if (quoteStartIndex <= 0) {
        return {
            body: normalizedBody,
            quoted: ''
        };
    }

    return {
        body: lines.slice(0, quoteStartIndex).join('\n').trim(),
        quoted: lines.slice(quoteStartIndex).join('\n').trim()
    };
}

function renderEmailMessageTextBlock(value = '', className = 'crm-email-message-body') {
    const normalizedValue = normalizeEmailBodyForDisplay(value);

    if (!normalizedValue) {
        return '';
    }

    return `<div class="${className}">${escapeHtml(normalizedValue)}</div>`;
}

function renderEmailThreadMessage(message) {
    const isIncoming = message.direction === 'incoming';
    const primaryLabel = isIncoming
        ? (message.senderName || message.senderEmail || 'Unknown sender')
        : (message.senderDisplayName || message.senderName || 'You');
    const secondaryLabel = isIncoming
        ? (message.senderEmail || 'No email')
        : (message.toEmail || 'No recipient');
    const { body, quoted } = splitEmailBodyForDisplay(message.bodyText || '');
    const bubbleBody = body || normalizeEmailBodyForDisplay(message.bodyText || '') || 'No plain text body available.';
    const avatarLabel = (primaryLabel || '?').charAt(0).toUpperCase();

    return `
        <div class="crm-email-message-row ${isIncoming ? 'incoming' : 'outgoing'}">
            <article class="crm-email-message-card ${isIncoming ? 'incoming' : 'outgoing'}">
                <div class="crm-email-message-head">
                    <div class="crm-email-message-person">
                        <span class="crm-email-message-avatar">${escapeHtml(avatarLabel)}</span>
                        <div>
                            <strong>${escapeHtml(primaryLabel)}</strong>
                            <div class="panel-subtitle">${escapeHtml(secondaryLabel)}</div>
                        </div>
                    </div>
                    <span>${escapeHtml(formatDateTime(message.receivedAt || message.sentAt || message.createdAt))}</span>
                </div>
                <div class="crm-email-message-bubble">
                    ${renderEmailMessageTextBlock(bubbleBody)}
                    ${quoted ? `
                        <div class="crm-email-message-quote">
                            <div class="crm-email-message-quote-label">Earlier in the thread</div>
                            ${renderEmailMessageTextBlock(quoted, 'crm-email-message-quote-copy')}
                        </div>
                    ` : ''}
                </div>
            </article>
        </div>
    `;
}

function buildReplyRecipientList(thread, { includeAll = false } = {}) {
    const selectedMailbox = getEmailWorkspaceSelectedMailbox();
    const latestMessage = Array.isArray(thread?.messages) && thread.messages.length
        ? thread.messages[thread.messages.length - 1]
        : null;
    const participants = Array.isArray(latestMessage?.participants) && latestMessage.participants.length
        ? latestMessage.participants
        : (Array.isArray(thread?.participants) ? thread.participants : []);
    const mailboxEmail = normalizeEmailAddress(selectedMailbox?.senderEmail);
    const fromParticipants = participants.filter((participant) => participant.role === 'from' && participant.email !== mailboxEmail);
    const allToParticipants = participants.filter((participant) => participant.role === 'to' && participant.email !== mailboxEmail);
    const toParticipants = includeAll
        ? allToParticipants
        : (fromParticipants.length ? [] : allToParticipants);

    return dedupeStrings([
        ...fromParticipants.map((participant) => participant.email),
        ...toParticipants.map((participant) => participant.email)
    ].filter(Boolean)).join(', ');
}

function openReplyComposer(thread, { includeAll = false } = {}) {
    if (!thread) {
        return;
    }

    const latestMessage = Array.isArray(thread.messages) && thread.messages.length
        ? thread.messages[thread.messages.length - 1]
        : null;
    const selectedMailbox = getEmailWorkspaceSelectedMailbox();

    state.emailComposer = {
        ...createDefaultEmailComposerState(),
        leadId: normalizeWhitespace(thread.leadId),
        threadId: normalizeWhitespace(thread.id),
        inReplyTo: normalizeWhitespace(latestMessage?.messageIdHeader),
        references: normalizeWhitespace(latestMessage?.referencesHeader || latestMessage?.messageIdHeader),
        composeMode: includeAll ? 'reply-all' : 'reply',
        recipientEmail: buildReplyRecipientList(thread, { includeAll }),
        recipientName: '',
        senderMode: selectedMailbox?.kind === 'support' ? 'support' : getDefaultEmailSenderMode(),
        subject: buildReplySubject(thread.subject),
        bodyText: ''
    };
    state.emailWorkspace.previewMode = 'compose';
    renderPanels();
}

function renderEmailWorkspacePage() {
    const mailboxes = getEmailWorkspaceMailboxes();
    const selectedMailbox = getEmailWorkspaceSelectedMailbox();
    const selectedThread = state.emailWorkspace.selectedThread;
    const isComposing = state.emailWorkspace.previewMode === 'compose';

    return `
        <div class="crm-email-page">
            <section class="crm-email-shell">
                <aside class="crm-email-rail">
                    <div class="crm-email-rail-card">
                        <div class="crm-email-rail-header">
                            <span class="crm-kicker"><i class="fa-solid fa-envelope-open-text"></i> Email</span>
                            <h1>Inbox</h1>
                            <p>Keep every mailbox conversation inside the CRM workspace.</p>
                        </div>

                        <button class="crm-button crm-email-compose-button" type="button" data-action="open-email-composer">
                            <i class="fa-solid fa-pen-to-square"></i> Compose
                        </button>

                        ${mailboxes.length ? `
                            <label class="crm-settings-field">
                                <span class="form-label">Mailbox</span>
                                <select class="crm-select" data-action="select-email-mailbox">
                                    ${mailboxes.map((mailbox) => `
                                        <option value="${escapeHtml(mailbox.id)}" ${selectedMailbox?.id === mailbox.id ? 'selected' : ''}>${escapeHtml(formatMailboxSenderLabel(mailbox, mailbox.kind === 'support' ? 'Support' : state.session?.name || 'Mailbox'))}</option>
                                    `).join('')}
                                </select>
                            </label>
                        ` : `
                            <div class="crm-admin-empty compact">
                                <div>Connect a mailbox in Settings to open the CRM inbox.</div>
                            </div>
                        `}

                        <div class="crm-email-folder-list">
                            ${[
                                ['INBOX', 'Inbox', 'fa-inbox'],
                                ['SENT', 'Sent', 'fa-paper-plane'],
                                ['ALL', 'All mail', 'fa-layer-group']
                            ].map(([value, label, icon]) => `
                                <button
                                    class="crm-email-folder-button ${state.emailWorkspace.selectedFolder === value ? 'active' : ''}"
                                    type="button"
                                    data-action="select-email-folder"
                                    data-folder="${value}"
                                >
                                    <span><i class="fa-solid ${icon}"></i> ${label}</span>
                                    ${value === 'INBOX' ? `<strong>${Number(state.emailWorkspace.threads.filter((thread) => Number(thread.unreadCount) > 0).length || 0)}</strong>` : ''}
                                </button>
                            `).join('')}
                        </div>

                        <div class="crm-email-sync-card">
                            <div>
                                <div class="crm-email-sync-label">Sync status</div>
                                <div class="crm-email-sync-copy">${escapeHtml(buildEmailSyncSummary(selectedMailbox))}</div>
                            </div>
                            <button class="crm-button-secondary" type="button" data-action="sync-email-mailbox" ${selectedMailbox ? '' : 'disabled'}>
                                <i class="fa-solid ${state.emailWorkspace.isSyncing ? 'fa-circle-notch fa-spin' : 'fa-rotate'}"></i> Refresh
                            </button>
                        </div>

                        ${!mailboxes.length ? `
                            <button class="crm-button-ghost" type="button" data-action="jump-to-view" data-view="settings" data-settings-section="personal_mailbox" data-mailbox-kind="personal">
                                <i class="fa-solid fa-gear"></i> Open Settings
                            </button>
                        ` : ''}
                    </div>
                </aside>

                <section class="crm-email-list-pane">
                    <div class="crm-email-list-toolbar">
                        <div>
                            <h2>Conversations</h2>
                            <p>${escapeHtml(selectedMailbox ? `Viewing ${selectedMailbox.senderEmail}` : 'Choose a mailbox to start.')}</p>
                        </div>
                        <label class="crm-email-search">
                            <i class="fa-solid fa-magnifying-glass"></i>
                            <input
                                class="crm-input"
                                type="search"
                                id="crm-email-search"
                                placeholder="Search sender, subject, snippet..."
                                value="${escapeHtml(state.emailWorkspace.searchQuery)}"
                            >
                        </label>
                    </div>

                    ${state.emailWorkspace.isLoading ? `
                        <div class="crm-admin-empty compact">
                            <div><i class="fa-solid fa-circle-notch fa-spin"></i> Loading mailbox threads...</div>
                        </div>
                    ` : !selectedMailbox ? `
                        <div class="crm-admin-empty compact">
                            <div>No connected mailbox is available for this CRM session yet.</div>
                        </div>
                    ` : state.emailWorkspace.threads.length ? `
                        <div class="crm-email-thread-list">
                            ${state.emailWorkspace.threads.map((thread) => `
                                <article class="crm-email-thread-row ${state.emailWorkspace.selectedThreadId === thread.id && !isComposing ? 'active' : ''} ${Number(thread.unreadCount) > 0 ? 'is-unread' : ''}">
                                    <button
                                        class="crm-email-thread-star ${thread.isStarred ? 'active' : ''}"
                                        type="button"
                                        data-action="toggle-email-thread-star"
                                        data-thread-id="${escapeHtml(thread.id)}"
                                        aria-label="${thread.isStarred ? 'Remove star from thread' : 'Star thread'}"
                                    >
                                        <i class="fa-solid ${thread.isStarred ? 'fa-star' : 'fa-star'}"></i>
                                    </button>
                                    <button
                                        class="crm-email-thread-button"
                                        type="button"
                                        data-action="open-email-thread"
                                        data-thread-id="${escapeHtml(thread.id)}"
                                    >
                                        <div class="crm-email-thread-topline">
                                            <strong>${escapeHtml(thread.participantSummary || 'Unknown sender')}</strong>
                                            <span>${escapeHtml(formatEmailThreadTimestamp(thread.latestMessageAt))}</span>
                                        </div>
                                        <div class="crm-email-thread-subject-line">
                                            <span class="crm-email-thread-subject">${escapeHtml(thread.subject || 'No subject')}</span>
                                            ${thread.leadId ? `<span class="summary-chip">${escapeHtml(buildEmailThreadLeadLabel(thread))}</span>` : ''}
                                            ${Number(thread.unreadCount) > 0 ? `<span class="crm-email-unread-pill">${escapeHtml(thread.unreadCount)}</span>` : ''}
                                        </div>
                                        <div class="crm-email-thread-snippet">${escapeHtml(thread.snippet || 'No preview available yet.')}</div>
                                    </button>
                                </article>
                            `).join('')}
                        </div>
                    ` : `
                        <div class="crm-admin-empty compact">
                            <div>No conversations matched this folder yet. Sync the mailbox or start a new email.</div>
                        </div>
                    `}
                </section>

                <section class="crm-email-preview-pane ${isComposing ? 'is-compose' : ''}">
                    ${isComposing
                        ? renderEmailWorkspaceComposer()
                        : selectedThread
                            ? renderEmailThreadPreview(selectedThread)
                            : renderEmailWorkspaceEmptyPreview(selectedMailbox)}
                </section>
            </section>
        </div>
    `;
}

function buildEmailSyncSummary(selectedMailbox) {
    if (!selectedMailbox) {
        return 'No mailbox selected yet.';
    }

    const syncState = (
        Array.isArray(selectedMailbox.syncState) && selectedMailbox.syncState.length
            ? selectedMailbox.syncState
            : state.emailWorkspace.syncStatus.filter((entry) => entry.mailboxSenderId === selectedMailbox.id)
    ).filter((entry) => ['INBOX', 'SENT'].includes(entry.folder));

    if (!syncState.length) {
        return 'Mailbox connected. Run the first sync to pull inbox and sent mail.';
    }

    const latestEntry = [...syncState].sort((left, right) => Date.parse(right.lastSyncedAt || 0) - Date.parse(left.lastSyncedAt || 0))[0];

    if (latestEntry?.lastError) {
        return latestEntry.lastError;
    }

    return latestEntry?.lastSyncedAt
        ? `Last synced ${formatDateTime(latestEntry.lastSyncedAt)}`
        : 'Ready to sync';
}

function renderEmailWorkspaceEmptyPreview(selectedMailbox) {
    if (!selectedMailbox) {
        return `
            <div class="crm-email-empty-preview">
                <i class="fa-solid fa-envelope-circle-check"></i>
                <h2>Connect a mailbox</h2>
                <p>Once a mailbox is connected, incoming and outgoing email will appear here.</p>
            </div>
        `;
    }

    return `
        <div class="crm-email-empty-preview">
            <i class="fa-solid fa-comments"></i>
            <h2>Select a conversation</h2>
            <p>Choose a thread from the list to preview messages, reply, or open the linked lead.</p>
        </div>
    `;
}

function renderEmailThreadPreview(thread) {
    const leadLabel = buildEmailThreadLeadLabel(thread);

    return `
        <div class="crm-email-preview-card">
            <div class="crm-email-preview-head">
                <div>
                    <span class="crm-kicker"><i class="fa-solid fa-comments"></i> Conversation</span>
                    <h2>${escapeHtml(thread.subject || 'No subject')}</h2>
                    <p>${escapeHtml(thread.participantSummary || 'Unknown sender')}</p>
                </div>
                <div class="crm-email-preview-actions">
                    <button class="crm-button-secondary" type="button" data-action="reply-email-thread">
                        <i class="fa-solid fa-reply"></i> Reply
                    </button>
                    <button class="crm-button-ghost" type="button" data-action="reply-all-email-thread">
                        <i class="fa-solid fa-reply-all"></i> Reply all
                    </button>
                    ${thread.leadId ? `
                        <button class="crm-button-ghost" type="button" data-action="open-lead-page" data-client-id="${escapeHtml(thread.leadId)}">
                            <i class="fa-solid fa-user-large"></i> ${escapeHtml(leadLabel)}
                        </button>
                    ` : ''}
                </div>
            </div>

            <div class="crm-email-preview-meta">
                <span class="summary-chip">${escapeHtml(formatEmailThreadTimestamp(thread.latestMessageAt))}</span>
                <span class="summary-chip">${escapeHtml(titleCase(thread.lastMessageDirection || 'incoming'))}</span>
                <span class="summary-chip">${escapeHtml(titleCase(thread.lastMessageDisplayStatus || thread.lastMessageStatus || 'received'))}</span>
            </div>

            <div class="crm-email-message-stack">
                ${(thread.messages || []).map((message) => renderEmailThreadMessage(message)).join('')}
            </div>
        </div>
    `;
}

function renderEmailWorkspaceComposer() {
    const lead = getEmailComposerLead();
    const senderOptions = getEmailSenderOptions();
    const draft = {
        ...createDefaultEmailComposerState(),
        ...state.emailComposer
    };
    const defaultSenderMode = resolveEmailComposerSenderMode(draft.senderMode, senderOptions);
    const leadEmail = normalizeEmailAddress(lead?.email);

    return `
        <div class="crm-email-compose-pane">
            <div class="crm-email-preview-head">
                <div>
                    <span class="crm-kicker"><i class="fa-solid fa-pen-to-square"></i> Compose</span>
                    <h2>${escapeHtml(draft.composeMode === 'reply-all' ? 'Reply all' : (draft.composeMode === 'reply' ? 'Reply' : 'New email'))}</h2>
                    <p>${escapeHtml(lead ? `Linked to ${lead.fullName || 'this lead'} while the recipient stays on ${leadEmail || 'the saved address'}.` : 'Send outbound email from your connected mailbox without leaving CRM.')}</p>
                </div>
                <button class="crm-button-ghost" type="button" data-action="close-email-compose">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            ${!senderOptions.length ? `
                <div class="crm-admin-empty compact">
                    <div>Connect your mailbox in Settings before sending CRM email.</div>
                </div>
                <div class="drawer-actions">
                    <button class="crm-button-secondary" type="button" data-action="jump-to-view" data-view="settings" data-settings-section="personal_mailbox" data-mailbox-kind="personal">
                        <i class="fa-solid fa-gear"></i> Open Settings
                    </button>
                </div>
            ` : `
                <form id="email-compose-form" class="crm-email-workspace-form">
                    <input type="hidden" name="leadId" value="${escapeHtml(draft.leadId || '')}">
                    <input type="hidden" name="threadId" value="${escapeHtml(draft.threadId || '')}">
                    <input type="hidden" name="inReplyTo" value="${escapeHtml(draft.inReplyTo || '')}">
                    <input type="hidden" name="references" value="${escapeHtml(draft.references || '')}">
                    <input type="hidden" name="composeMode" value="${escapeHtml(draft.composeMode || 'new')}">
                    <div class="form-grid">
                        <label class="form-field form-field-full">
                            <span class="form-label">To</span>
                            <input
                                class="crm-input"
                                name="recipientEmail"
                                type="text"
                                value="${escapeHtml(draft.recipientEmail || '')}"
                                placeholder="name@example.com, second@example.com"
                                autocomplete="off"
                                required
                            >
                            <span class="panel-subtitle">Use commas to send to multiple recipients.</span>
                        </label>
                        ${lead ? `
                            <div class="crm-email-drawer-note form-field-full">
                                Logged to this lead only while the recipient stays on <strong>${escapeHtml(leadEmail || 'the saved lead email')}</strong>.
                            </div>
                        ` : ''}
                        <label class="form-field">
                            <span class="form-label">From</span>
                            ${senderOptions.length > 1 ? `
                                <select class="crm-select" name="senderMode">
                                    ${senderOptions.map((option) => `
                                        <option value="${escapeHtml(option.value)}" ${option.value === defaultSenderMode ? 'selected' : ''}>${escapeHtml(option.label)}</option>
                                    `).join('')}
                                </select>
                            ` : `
                                <input type="hidden" name="senderMode" value="${escapeHtml(defaultSenderMode)}">
                                <input class="crm-input" value="${escapeHtml(senderOptions[0]?.label || 'Personal mailbox')}" readonly>
                            `}
                        </label>
                        <label class="form-field form-field-full">
                            <span class="form-label">Subject</span>
                            <input
                                class="crm-input"
                                name="subject"
                                value="${escapeHtml(draft.subject || '')}"
                                placeholder="Follow-up from Blue Chip Signals"
                                maxlength="160"
                                required
                            >
                        </label>
                        <label class="form-field form-field-full">
                            <span class="form-label">Message</span>
                            <textarea
                                class="crm-textarea"
                                name="bodyText"
                                placeholder="Write your email here..."
                                maxlength="10000"
                                required
                            >${escapeHtml(draft.bodyText || '')}</textarea>
                            <span class="panel-subtitle">Your saved signature is added automatically when the email sends.</span>
                        </label>
                    </div>
                    <div class="drawer-actions">
                        <button class="crm-button" type="submit"><i class="fa-solid fa-paper-plane"></i> Send Email</button>
                        <button class="crm-button-ghost" type="button" data-action="close-email-compose">Cancel</button>
                    </div>
                </form>
            `}
        </div>
    `;
}

function renderCallPreferenceSettingsCard() {
    const currentPreference = getCurrentCallPreference();
    const isGoogleVoice = normalizeCallPreference(currentPreference) === 'google_voice';

    return `
        <div class="crm-settings-stage-grid crm-settings-stage-grid-two">
            <section class="crm-settings-card crm-settings-card-compact">
                <div class="crm-settings-card-head">
                    <div class="crm-settings-card-title">
                        <span class="crm-settings-card-icon"><i class="fa-solid fa-phone-volume"></i></span>
                        <div><h2>Calling overview</h2></div>
                    </div>
                </div>

                <div class="crm-settings-quick-stats crm-settings-quick-stats-compact">
                    <div class="crm-settings-quick-stat">
                        <span>Default mode</span>
                        <strong>${escapeHtml(getCallPreferenceLabel(currentPreference))}</strong>
                    </div>
                    <div class="crm-settings-quick-stat">
                        <span>Desktop support</span>
                        <strong>Chrome, Edge, Firefox</strong>
                    </div>
                    <div class="crm-settings-quick-stat">
                        <span>Mobile</span>
                        <strong>Native phone flow</strong>
                    </div>
                    <div class="crm-settings-quick-stat">
                        <span>Browser handoff</span>
                        <strong>${escapeHtml(isGoogleVoice ? 'Google Voice web' : 'System tel links')}</strong>
                    </div>
                </div>

                <div class="crm-settings-support-note">Google Voice remains desktop-first. On mobile, the CRM keeps using your device's normal calling behavior and your phone app settings decide whether Google Voice or your carrier handles the call.</div>
            </section>

            <section class="crm-settings-card crm-settings-card-compact">
                <div class="crm-settings-subcard-head">
                    <div>
                        <strong>Default call routing</strong>
                        <span>Update the behavior without leaving Settings.</span>
                    </div>
                </div>
                <form id="call-preference-form" class="crm-mailbox-form crm-settings-inline-form">
                    <div class="crm-settings-field-grid crm-settings-field-grid-compact">
                        <label class="crm-settings-field crm-settings-field-full">
                            <span class="form-label">Call routing</span>
                            <select class="crm-select" name="callPreference">
                                ${CALL_PREFERENCE_OPTIONS.map((option) => `
                                    <option value="${escapeHtml(option.value)}" ${option.value === currentPreference ? 'selected' : ''}>${escapeHtml(option.label)}</option>
                                `).join('')}
                            </select>
                            <span class="panel-subtitle">Google Voice mode opens Google Voice directly on desktop, so make sure the correct Google account is already signed in inside your browser.</span>
                        </label>
                    </div>

                    <div class="settings-actions crm-settings-action-row crm-settings-inline-actions" data-inline-feedback-container="call-preference-form">
                        <button class="crm-button-secondary" type="submit">
                            <i class="fa-solid fa-phone"></i> Save calling preference
                        </button>
                        <a class="crm-button-ghost" href="${GOOGLE_VOICE_HELP_URL}" target="_blank" rel="noreferrer">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> Google Voice setup
                        </a>
                    </div>
                </form>
            </section>
        </div>
    `;
}

function renderMailboxSettingsSection({
    mailboxKind = 'personal',
    title = 'Mailbox',
    icon = 'fa-envelope',
    sender = null,
    editorSender = null,
    formId = '',
    senderNameLabel = 'Sender name',
    senderNameValue = '',
    senderEmailLabel = 'Sender email',
    senderEmailValue = '',
    senderEmailReadOnly = false,
    senderEmailHint = '',
    smtpUsernameValue = '',
    saveButtonLabel = 'Save mailbox',
    supportNote = '',
    emptyStatusLabel = 'Not connected'
} = {}) {
    const normalizedMailboxKind = normalizeMailboxKind(mailboxKind);
    const isExpanded = state.expandedMailboxEditorKind === normalizedMailboxKind;
    const statusLabel = sender ? (normalizedMailboxKind === 'support' ? 'Configured' : 'Connected') : emptyStatusLabel;
    const editorDisplayName = editorSender?.senderName || senderNameValue;
    const editorDisplayEmail = editorSender?.senderEmail || senderEmailValue;

    return `
        <div class="crm-settings-stage-stack">
            <section class="crm-settings-card crm-settings-card-compact crm-settings-mailbox-summary">
                <div class="crm-settings-card-head">
                    <div class="crm-settings-card-title">
                        <span class="crm-settings-card-icon"><i class="fa-solid ${escapeHtml(icon)}"></i></span>
                        <div><h2>${escapeHtml(title)}</h2></div>
                    </div>
                    <button
                        class="crm-button-secondary crm-settings-card-toggle"
                        type="button"
                        data-action="toggle-mailbox-editor"
                        data-mailbox-kind="${escapeHtml(normalizedMailboxKind)}"
                    >
                        <i class="fa-solid ${isExpanded ? 'fa-chevron-up' : (sender ? 'fa-pen-to-square' : 'fa-plug-circle-check')}"></i>
                        ${escapeHtml(isExpanded ? 'Collapse editor' : (sender ? 'Edit mailbox' : 'Connect mailbox'))}
                    </button>
                </div>

                <div class="crm-settings-quick-stats crm-settings-quick-stats-compact">
                    <div class="crm-settings-quick-stat">
                        <span>Status</span>
                        <strong>${escapeHtml(statusLabel)}</strong>
                    </div>
                    <div class="crm-settings-quick-stat">
                        <span>Sender</span>
                        <strong>${escapeHtml(sender?.senderEmail || senderEmailValue || 'Not available')}</strong>
                    </div>
                    <div class="crm-settings-quick-stat">
                        <span>Last verified</span>
                        <strong>${escapeHtml(sender?.lastVerifiedAt ? formatDateTime(sender.lastVerifiedAt) : 'Not yet')}</strong>
                    </div>
                    <div class="crm-settings-quick-stat">
                        <span>Signature</span>
                        <strong>${escapeHtml(sender ? getSignatureModeLabel(sender.signatureMode || 'template') : 'Not set')}</strong>
                    </div>
                </div>

                ${supportNote ? `<div class="crm-settings-support-note">${escapeHtml(supportNote)}</div>` : ''}
            </section>

            ${isExpanded ? `
                <section class="crm-settings-card crm-settings-card-compact crm-settings-mailbox-editor-card">
                    <form id="${escapeHtml(formId)}" class="crm-mailbox-form crm-settings-mailbox-form">
                        <div class="crm-mailbox-editor-layout">
                            <section class="crm-settings-subcard">
                                <div class="crm-settings-subcard-head">
                                    <div>
                                        <strong>Mailbox credentials</strong>
                                        <span>Stored securely and verified before the mailbox is saved.</span>
                                    </div>
                                </div>

                                <div class="crm-settings-field-grid crm-settings-field-grid-compact">
                                    <label class="crm-settings-field">
                                        <span class="form-label">${escapeHtml(senderNameLabel)}</span>
                                        <input class="crm-input" name="senderName" value="${escapeHtml(senderNameValue)}" placeholder="Your full name" required>
                                    </label>
                                    <label class="crm-settings-field">
                                        <span class="form-label">${escapeHtml(senderEmailLabel)}</span>
                                        <input
                                            class="crm-input"
                                            name="${senderEmailReadOnly ? 'senderEmailDisplay' : 'senderEmail'}"
                                            type="${senderEmailReadOnly ? 'text' : 'email'}"
                                            value="${escapeHtml(senderEmailValue)}"
                                            placeholder="support@company.com"
                                            ${senderEmailReadOnly ? 'readonly' : 'required'}
                                        >
                                        ${senderEmailHint ? `<span class="panel-subtitle">${escapeHtml(senderEmailHint)}</span>` : ''}
                                    </label>
                                    <label class="crm-settings-field">
                                        <span class="form-label">SMTP username</span>
                                        <input class="crm-input" name="smtpUsername" value="${escapeHtml(smtpUsernameValue)}" placeholder="your.name@company.com" required>
                                    </label>
                                    <label class="crm-settings-field">
                                        <span class="form-label">Mailbox password</span>
                                        <input class="crm-input" name="smtpPassword" type="password" placeholder="${sender ? 'Leave blank to keep current password' : 'Enter mailbox password'}" ${sender ? '' : 'required'}>
                                        <span class="panel-subtitle">Leave blank to keep the current secret. We re-verify the mailbox whenever you update it.</span>
                                    </label>
                                </div>
                            </section>

                            <section class="crm-settings-subcard crm-settings-subcard-signature">
                                <div class="crm-settings-subcard-head">
                                    <div>
                                        <strong>Email signature</strong>
                                        <span>Compact builder with grouped fields, thumbnail assets, and a bounded live preview.</span>
                                    </div>
                                </div>
                                ${renderMailboxSignatureBuilder({
                                    mailboxKind: normalizedMailboxKind,
                                    sender: editorSender,
                                    senderName: editorDisplayName,
                                    senderEmail: editorDisplayEmail
                                })}
                            </section>
                        </div>

                        <div class="settings-actions crm-settings-action-row crm-settings-editor-footer" data-inline-feedback-container="${escapeHtml(formId)}">
                            <button class="crm-button-secondary" type="submit">
                                <i class="fa-solid ${normalizedMailboxKind === 'support' ? 'fa-shield-heart' : 'fa-plug-circle-check'}"></i> ${escapeHtml(saveButtonLabel)}
                            </button>
                            <button class="crm-button-ghost" type="button" data-action="toggle-mailbox-editor" data-mailbox-kind="${escapeHtml(normalizedMailboxKind)}">
                                Close editor
                            </button>
                        </div>
                    </form>
                </section>
            ` : ''}
        </div>
    `;
}

function renderPersonalMailboxSettingsCard() {
    const personalSender = getPersonalMailboxSender();
    const personalEditorSender = buildMailboxSignatureEditorSender(
        'personal',
        personalSender,
        personalSender?.senderName || state.session.name || '',
        personalSender?.senderEmail || state.session.email || ''
    );

    return renderMailboxSettingsSection({
        mailboxKind: 'personal',
        title: 'My mailbox',
        icon: 'fa-envelope-circle-check',
        sender: personalSender,
        editorSender: personalEditorSender,
        formId: 'personal-mailbox-form',
        senderNameLabel: 'Sender name',
        senderNameValue: personalEditorSender?.senderName || personalSender?.senderName || state.session.name || '',
        senderEmailLabel: 'Sender email',
        senderEmailValue: state.session.email || '',
        senderEmailReadOnly: true,
        senderEmailHint: 'Personal mailbox sends are locked to your CRM profile email.',
        smtpUsernameValue: personalSender?.senderEmail || state.session.email || '',
        saveButtonLabel: personalSender ? 'Update mailbox' : 'Connect mailbox',
        supportNote: 'Your saved signature is added automatically to outgoing email from this mailbox.'
    });
}

function renderSupportMailboxSettingsCard() {
    if (!isAdminSession(state.session)) {
        return '';
    }

    const supportSender = getSupportMailboxSender();
    const supportEditorSender = buildMailboxSignatureEditorSender(
        'support',
        supportSender,
        supportSender?.senderName || 'Support Team',
        supportSender?.senderEmail || ''
    );

    return renderMailboxSettingsSection({
        mailboxKind: 'support',
        title: 'Support mailbox',
        icon: 'fa-headset',
        sender: supportSender,
        editorSender: supportEditorSender,
        formId: 'support-mailbox-form',
        senderNameLabel: 'Support sender name',
        senderNameValue: supportEditorSender?.senderName || supportSender?.senderName || 'Support Team',
        senderEmailLabel: 'Support sender email',
        senderEmailValue: supportEditorSender?.senderEmail || supportSender?.senderEmail || '',
        senderEmailReadOnly: false,
        senderEmailHint: 'Support users can send from this inbox after an admin configures it.',
        smtpUsernameValue: supportSender?.senderEmail || '',
        saveButtonLabel: supportSender ? 'Update support inbox' : 'Connect support inbox',
        supportNote: 'Only admin users can update the support mailbox. Support users can send from it once it is configured.',
        emptyStatusLabel: 'Not configured'
    });
}

function renderSettingsAccountSection({ leadCount = 0, memberCount = 0 } = {}) {
    return `
        <section class="crm-settings-card crm-settings-card-compact">
            <div class="crm-settings-card-head">
                <div class="crm-settings-card-title">
                    <span class="crm-settings-card-icon"><i class="fa-solid fa-user-shield"></i></span>
                    <div><h2>Account</h2></div>
                </div>
            </div>

            <div class="crm-settings-quick-stats crm-settings-quick-stats-compact">
                <div class="crm-settings-quick-stat">
                    <span>Signed in as</span>
                    <strong>${escapeHtml(state.session.name)}</strong>
                </div>
                <div class="crm-settings-quick-stat">
                    <span>Access level</span>
                    <strong>${escapeHtml(getRoleLabel(state.session.role))}</strong>
                </div>
                <div class="crm-settings-quick-stat">
                    <span>Lead inventory</span>
                    <strong>${leadCount.toLocaleString()}</strong>
                </div>
                <div class="crm-settings-quick-stat">
                    <span>Member inventory</span>
                    <strong>${memberCount.toLocaleString()}</strong>
                </div>
            </div>

            <div class="crm-settings-field-grid crm-settings-field-grid-compact">
                <label class="crm-settings-field">
                    <span class="form-label">Email</span>
                    <div class="crm-settings-field-value">${escapeHtml(state.session.email || 'Not available')}</div>
                </label>
                <label class="crm-settings-field">
                    <span class="form-label">Workspace session</span>
                    <div class="crm-settings-field-value">${escapeHtml(isAdminSession(state.session) ? 'Admin maintenance enabled' : 'Sales workspace session')}</div>
                </label>
            </div>

            <div class="settings-actions crm-settings-action-row crm-settings-inline-actions">
                <button class="crm-button" data-action="logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</button>
            </div>
        </section>
    `;
}

function renderWorkspaceToolsSettingsSection({ leadCount = 0, memberCount = 0, canManageSettings = false, canExport = false } = {}) {
    return `
        <div class="crm-settings-stage-grid crm-settings-stage-grid-two">
            <section class="crm-settings-card crm-settings-card-compact">
                <div class="crm-settings-card-head">
                    <div class="crm-settings-card-title">
                        <span class="crm-settings-card-icon"><i class="fa-solid fa-file-export"></i></span>
                        <div><h2>Exports</h2></div>
                    </div>
                </div>

                <div class="crm-settings-quick-stats crm-settings-quick-stats-compact">
                    <div class="crm-settings-quick-stat">
                        <span>Lead inventory</span>
                        <strong>${leadCount.toLocaleString()}</strong>
                    </div>
                    <div class="crm-settings-quick-stat">
                        <span>Member inventory</span>
                        <strong>${memberCount.toLocaleString()}</strong>
                    </div>
                </div>

                <div class="settings-actions crm-settings-action-row crm-settings-inline-actions">
                    ${canExport ? '<button class="crm-button-secondary" data-action="export-clients"><i class="fa-solid fa-file-export"></i> Export CSV</button>' : ''}
                </div>
                <div class="crm-settings-support-note">${canExport ? 'Exports mirror the current CRM workspace so your team can work from the latest snapshot.' : 'Export access is reserved for admin sessions.'}</div>
            </section>

            <section class="crm-settings-card crm-settings-card-compact">
                <div class="crm-settings-card-head">
                    <div class="crm-settings-card-title">
                        <span class="crm-settings-card-icon"><i class="fa-solid fa-globe"></i></span>
                        <div><h2>Time zone automation</h2></div>
                    </div>
                </div>

                <div class="crm-settings-quick-stats crm-settings-quick-stats-compact">
                    <div class="crm-settings-quick-stat">
                        <span>Lead inventory</span>
                        <strong>${leadCount.toLocaleString()}</strong>
                    </div>
                    <div class="crm-settings-quick-stat">
                        <span>Mode</span>
                        <strong>Auto + manual</strong>
                    </div>
                </div>

                <div class="settings-actions crm-settings-action-row crm-settings-inline-actions">
                    ${canManageSettings ? '<button class="crm-button-secondary" data-action="backfill-time-zones"><i class="fa-solid fa-rotate"></i> Backfill time zones</button>' : ''}
                </div>
                <div class="crm-settings-support-note">${canManageSettings ? 'Manual overrides stay untouched. Non-overridden leads are normalized to the shared CRM time zone labels.' : 'Only admin users can run the time zone backfill.'}</div>
            </section>

            <section class="crm-settings-card crm-settings-card-compact crm-settings-card-danger crm-settings-card-full">
                <div class="crm-settings-card-head">
                    <div class="crm-settings-card-title">
                        <span class="crm-settings-card-icon"><i class="fa-solid fa-triangle-exclamation"></i></span>
                        <div><h2>Danger zone</h2></div>
                    </div>
                </div>

                <div class="settings-actions crm-settings-action-row crm-settings-inline-actions">
                    ${canManageSettings ? `
                        <button class="crm-button-danger" data-action="open-clear-confirm">
                            <i class="fa-solid fa-trash"></i> Clear all data
                        </button>
                    ` : ''}
                </div>
                <div class="crm-settings-support-note">${canManageSettings ? 'You will need to type CLEAR in the confirmation step before the reset can proceed.' : 'Only admin users can reset the workspace.'}</div>
            </section>
        </div>
    `;
}

function renderSettingsStageContent(sectionId, context = {}) {
    if (sectionId === 'calling') {
        return renderCallPreferenceSettingsCard();
    }

    if (sectionId === 'personal_mailbox') {
        return renderPersonalMailboxSettingsCard();
    }

    if (sectionId === 'support_mailbox') {
        return renderSupportMailboxSettingsCard();
    }

    if (sectionId === 'workspace_tools') {
        return renderWorkspaceToolsSettingsSection(context);
    }

    return renderSettingsAccountSection(context);
}
function renderLeadEmailHistoryCard(lead) {
    const emailHistory = getLeadEmailHistory(lead);
    const canSendEmail = canSendEmailForLead(lead);

    return `
        <section class="crm-card lead-detail-side-card lead-detail-email-card">
            <div class="panel-head">
                <div>
                    <span class="lead-detail-card-label">Email</span>
                    <h2 class="section-title">Email history</h2>
                </div>
                ${canSendEmail ? `
                    <button class="crm-button-secondary lead-detail-action-button" type="button" data-action="open-email-composer" data-client-id="${escapeHtml(lead.id)}">
                        <i class="fa-solid fa-paper-plane"></i> Send Email
                    </button>
                ` : ''}
            </div>

            ${emailHistory.length ? `
                <div class="history-list crm-email-history-list">
                    ${emailHistory.map((entry) => `
                        <article class="history-card crm-email-history-card ${escapeHtml(entry.status || 'sent')}">
                            <div class="history-head">
                                <div>
                                    <div class="history-title">${escapeHtml(entry.subject || 'No subject')}</div>
                                    <div class="panel-subtitle">${escapeHtml(entry.senderDisplayName || entry.senderName || 'CRM user')} · ${escapeHtml(entry.toEmail || lead.email || 'No recipient')}</div>
                                </div>
                                <span class="summary-chip ${escapeHtml(entry.status || 'sent')}">${escapeHtml(titleCase(entry.displayStatus || entry.status || 'sent'))}</span>
                            </div>
                            <div class="note-history-copy">${escapeHtml(truncate(entry.bodyText || '', 220) || 'No message body.')}</div>
                            <div class="crm-email-history-meta">
                                <span>${escapeHtml(formatDateTime(entry.receivedAt || entry.sentAt || entry.createdAt))}</span>
                                <span>${escapeHtml(entry.direction === 'incoming' ? 'Incoming' : (entry.senderKind === 'support' ? 'Support inbox' : 'Personal mailbox'))}</span>
                                ${entry.errorMessage ? `<span class="crm-email-history-error">${escapeHtml(entry.errorMessage)}</span>` : ''}
                            </div>
                        </article>
                    `).join('')}
                </div>
            ` : '<div class="panel-subtitle lead-detail-empty-copy">No email has been logged for this record yet.</div>'}
        </section>
    `;
}

function renderEmailComposeDrawer() {
    const lead = getEmailComposerLead();
    const senderOptions = getEmailSenderOptions();
    const draft = {
        ...createDefaultEmailComposerState(),
        ...state.emailComposer,
        leadId: lead?.id || normalizeWhitespace(state.emailComposer.leadId)
    };
    const defaultSenderMode = resolveEmailComposerSenderMode(draft.senderMode, senderOptions);
    const normalizedRecipientEmail = normalizeEmailAddress(draft.recipientEmail);
    const leadEmail = normalizeEmailAddress(lead?.email);
    const titleTarget = lead?.fullName || normalizedRecipientEmail || draft.recipientName || 'recipient';
    const subtitle = lead
        ? `Send from your connected mailbox${getSupportMailboxSender() && canUseSupportMailbox() ? ' or the support inbox' : ''} without leaving CRM.`
        : `Send from your connected mailbox${getSupportMailboxSender() && canUseSupportMailbox() ? ' or the support inbox' : ''} without leaving CRM.`;

    return `
        <div class="drawer-surface">
            <div class="drawer-head">
                <div>
                    <span class="crm-kicker"><i class="fa-solid fa-envelope"></i> Email</span>
                    <h2 class="drawer-title">${escapeHtml(lead ? `Email ${titleTarget}` : 'Compose Email')}</h2>
                    <p class="panel-subtitle">${escapeHtml(subtitle)}</p>
                </div>
                <button class="crm-button-ghost" data-action="close-drawer"><i class="fa-solid fa-xmark"></i></button>
            </div>

            ${!senderOptions.length ? `
                <div class="crm-admin-empty compact">
                    <div>Connect your mailbox in Settings before sending CRM email.</div>
                </div>
                <div class="drawer-actions">
                    <button class="crm-button-secondary" type="button" data-action="jump-to-view" data-view="settings" data-settings-section="personal_mailbox" data-mailbox-kind="personal">
                        <i class="fa-solid fa-gear"></i> Open Settings
                    </button>
                    <button class="crm-button-ghost" type="button" data-action="close-drawer">Close</button>
                </div>
            ` : `
                <form id="email-compose-form" class="crm-email-drawer-form">
                    <input type="hidden" name="leadId" value="${escapeHtml(draft.leadId || '')}">
                    <div class="form-grid">
                        <label class="form-field form-field-full">
                            <span class="form-label">To</span>
                            <input
                                class="crm-input"
                                name="recipientEmail"
                                type="email"
                                value="${escapeHtml(draft.recipientEmail || '')}"
                                placeholder="name@example.com"
                                autocomplete="email"
                                maxlength="254"
                                required
                            >
                        </label>
                        ${lead ? `
                            <div class="crm-email-drawer-note form-field-full">
                                Logged to this lead only while the recipient stays on <strong>${escapeHtml(leadEmail || 'the saved lead email')}</strong>.
                            </div>
                        ` : ''}
                        <label class="form-field">
                            <span class="form-label">From</span>
                            ${senderOptions.length > 1 ? `
                                <select class="crm-select" name="senderMode">
                                    ${senderOptions.map((option) => `
                                        <option value="${escapeHtml(option.value)}" ${option.value === defaultSenderMode ? 'selected' : ''}>${escapeHtml(option.label)}</option>
                                    `).join('')}
                                </select>
                            ` : `
                                <input type="hidden" name="senderMode" value="${escapeHtml(defaultSenderMode)}">
                                <input class="crm-input" value="${escapeHtml(senderOptions[0]?.label || 'Personal mailbox')}" readonly>
                            `}
                        </label>
                        <label class="form-field form-field-full">
                            <span class="form-label">Subject</span>
                            <input
                                class="crm-input"
                                name="subject"
                                value="${escapeHtml(draft.subject || '')}"
                                placeholder="Follow-up from Blue Chip Signals"
                                maxlength="160"
                                required
                            >
                        </label>
                        <label class="form-field form-field-full">
                            <span class="form-label">Message</span>
                            <textarea
                                class="crm-textarea"
                                name="bodyText"
                                placeholder="Write your email here..."
                                maxlength="10000"
                                required
                            >${escapeHtml(draft.bodyText || '')}</textarea>
                            <span class="panel-subtitle">Your saved signature is added automatically when the email sends.</span>
                        </label>
                    </div>
                    <div class="drawer-actions">
                        <button class="crm-button" type="submit"><i class="fa-solid fa-paper-plane"></i> Send Email</button>
                        <button class="crm-button-ghost" type="button" data-action="close-drawer">Cancel</button>
                    </div>
                </form>
            `}
        </div>
    `;
}

function renderSettingsPanel() {
    const leadCount = getWorkspaceDisplayCount('leads', { ignoreSearch: true, ignoreFilters: true });
    const memberCount = getWorkspaceDisplayCount('members', { ignoreSearch: true, ignoreFilters: true });
    const canManageSettings = hasPermission(state.session, PERMISSIONS.MANAGE_SETTINGS);
    const canExport = hasPermission(state.session, PERMISSIONS.EXPORT_LEADS);
    const settingsSections = getSettingsSectionDefinitions(leadCount, memberCount);
    const selectedSection = getValidSettingsSection(state.selectedSettingsSection);
    state.selectedSettingsSection = selectedSection;
    const activeSection = settingsSections.find((section) => section.id === selectedSection) || settingsSections[0];

    return `
        <div class="settings-grid crm-settings-page">
            <div class="crm-settings-shell">
                <aside class="crm-settings-rail">
                    <nav class="crm-settings-nav-card" aria-label="Settings sections">
                        ${settingsSections.map((section) => {
                            const isActive = section.id === selectedSection;
                            return `
                                <button
                                    class="crm-settings-nav-button ${isActive ? 'is-active' : ''}"
                                    type="button"
                                    data-action="select-settings-section"
                                    data-settings-section="${escapeHtml(section.id)}"
                                >
                                    <span class="crm-settings-nav-button-copy">
                                        <strong>${escapeHtml(section.label)}</strong>
                                    </span>
                                </button>
                            `;
                        }).join('')}
                    </nav>
                </aside>

                <section class="crm-settings-main">
                    <section class="crm-settings-mobile-nav" aria-label="Settings section selector">
                        <label class="crm-settings-mobile-nav-label" for="crm-settings-section-select">Section</label>
                        <select
                            id="crm-settings-section-select"
                            class="crm-select crm-settings-section-select"
                            data-settings-section-select
                            aria-label="Choose settings section"
                        >
                            ${settingsSections.map((section) => `
                                <option value="${escapeHtml(section.id)}" ${section.id === selectedSection ? 'selected' : ''}>${escapeHtml(section.label)}</option>
                            `).join('')}
                        </select>
                    </section>

                    <section class="crm-settings-stage-header">
                        <h2>${escapeHtml(activeSection?.label || 'Settings')}</h2>
                    </section>

                    <div class="crm-settings-stage-body">
                        ${renderSettingsStageContent(selectedSection, {
                            leadCount,
                            memberCount,
                            canManageSettings,
                            canExport
                        })}
                    </div>
                </section>
            </div>
        </div>
    `;
}

function renderLookupPreviewDrawer(client) {
    const latestNote = Array.isArray(client.noteHistory) && client.noteHistory.length
        ? [...client.noteHistory].sort((left, right) => Date.parse(right.createdAt ?? 0) - Date.parse(left.createdAt ?? 0))[0]
        : null;
    const latestActivity = getLeadHistoryEntries(client)[0] || null;
    const headerSummary = [
        client.phone || '',
        client.email || ''
    ].filter(Boolean).join(' · ');
    const tagsMarkup = client.tags?.length
        ? client.tags.map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('')
        : '<div class="panel-subtitle">No tags on this record yet.</div>';

    return `
        <div class="drawer-surface crm-search-preview-drawer">
            <div class="crm-search-preview-shell">
                <div class="crm-search-preview-shell-head">
                    <div class="crm-search-preview-header">
                        <span class="crm-kicker"><i class="fa-solid fa-magnifying-glass"></i> Quick view</span>
                        <h2 class="drawer-title">${escapeHtml(client.fullName || 'Unnamed lead')}</h2>
                        <p class="crm-search-preview-subtitle">${escapeHtml(headerSummary || buildClientMetaLine(client))}</p>
                    </div>
                    <button class="crm-search-preview-close" data-action="close-drawer" aria-label="Close quick view">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>

                <div class="crm-search-preview-meta">
                    <div class="row-actions crm-search-preview-pills">
                        <span class="summary-chip"><i class="fa-solid fa-layer-group"></i> ${escapeHtml(titleCase(client.lifecycleType || 'lead'))}</span>
                        <span class="summary-chip"><i class="fa-solid fa-signal"></i> ${escapeHtml(titleCase(client.status || 'new'))}</span>
                        <span class="summary-chip"><i class="fa-solid fa-user-check"></i> ${escapeHtml(client.assignedTo || 'Unassigned')}</span>
                        <span class="summary-chip"><i class="fa-solid fa-clock"></i> ${escapeHtml(client.timeZone || 'Unknown')}</span>
                        <span class="summary-chip"><i class="fa-solid fa-star"></i> ${escapeHtml(client.subscriptionType || 'No subscription')}</span>
                    </div>
                </div>

                <div class="crm-search-preview-grid">
                    <section class="crm-search-preview-section">
                        <div class="crm-search-preview-section-head">
                            <span class="crm-search-preview-section-title">Contact</span>
                            <p class="crm-search-preview-section-copy">Primary ways to reach this record.</p>
                        </div>
                        <div class="crm-search-preview-field-grid">
                            ${renderPreviewField('Phone', {
                                html: renderPhoneLink(client.phone, {
                                    className: 'crm-phone-link crm-search-preview-phone-link',
                                    includeIcon: true
                                })
                            })}
                            ${renderPreviewField('Email', {
                                html: renderEmailLink(client.email, {
                                    className: 'crm-email-link crm-search-preview-email-link',
                                    includeIcon: true,
                                    clientId: client.id,
                                    recipientName: client.fullName || client.firstName || client.lastName || ''
                                })
                            }, { fullWidth: true })}
                            ${renderPreviewField('Business', client.businessName || '—', { fullWidth: true })}
                        </div>
                    </section>

                    <section class="crm-search-preview-section">
                        <div class="crm-search-preview-section-head">
                            <span class="crm-search-preview-section-title">Workspace</span>
                            <p class="crm-search-preview-section-copy">Team assignment and lifecycle context.</p>
                        </div>
                        <div class="crm-search-preview-field-grid">
                            ${renderPreviewField('Assigned rep', client.assignedTo || 'Unassigned', { fullWidth: true })}
                            ${renderPreviewField('Status', titleCase(client.status || 'new'))}
                            ${renderPreviewField('Subscription', client.subscriptionType || '—')}
                            ${renderPreviewField('Time zone', client.timeZone || 'Unknown')}
                            ${renderPreviewField('Updated', formatDateTime(client.updatedAt || client.createdAt), { fullWidth: true })}
                        </div>
                    </section>
                </div>

                <section class="crm-search-preview-section crm-search-preview-section-full">
                    <div class="crm-search-preview-section-head">
                        <span class="crm-search-preview-section-title">Tags</span>
                    </div>
                    <div class="tag-cloud crm-search-preview-chip-wrap">
                        ${tagsMarkup}
                    </div>
                </section>

                ${renderPreviewTextPanel(
                    'Latest note',
                    latestNote ? truncate(latestNote.content || '', 220) || 'No note content.' : 'No notes have been saved yet.',
                    latestNote ? formatDateTime(latestNote.updatedAt || latestNote.createdAt) : ''
                )}

                ${renderPreviewTextPanel(
                    'Recent activity',
                    latestActivity ? truncate(latestActivity.message || 'Recent activity is available on the full record.', 220) : 'No recent activity is available for this record.',
                    latestActivity ? formatDateTime(latestActivity.changedAt || latestActivity.createdAt) : ''
                )}

                <div class="drawer-actions crm-search-preview-actions">
                    <button class="crm-button-secondary" type="button" data-action="open-search-result-detail" data-client-id="${escapeHtml(client.id)}">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> Open full details
                    </button>
                    <button class="crm-button-ghost" type="button" data-action="close-drawer">Close</button>
                </div>
            </div>
        </div>
    `;
}

function renderDrawer() {
    if (!isDrawerOpen()) {
        refs.drawer.classList.add('hidden');
        refs.drawer.classList.remove('crm-drawer-preview');
        refs.drawer.innerHTML = '';
        return;
    }

    refs.drawer.classList.remove('hidden');
    refs.drawer.classList.toggle('crm-drawer-preview', state.drawerMode === 'lookup-preview');

    if (state.drawerMode === 'lookup-preview') {
        const previewClient = getAccessibleClientById(state.drawerClientId);
        refs.drawer.innerHTML = previewClient
            ? renderLookupPreviewDrawer(previewClient)
            : `
                <div class="drawer-surface crm-search-preview-drawer">
                    <div class="drawer-head">
                        <div>
                            <span class="crm-kicker"><i class="fa-solid fa-magnifying-glass"></i> Quick view</span>
                            <h2 class="drawer-title">Lead unavailable</h2>
                            <p class="panel-subtitle">This record is no longer accessible in the current session.</p>
                        </div>
                        <button class="crm-button-ghost" data-action="close-drawer"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div class="drawer-actions">
                        <button class="crm-button-ghost" type="button" data-action="close-drawer">Close</button>
                    </div>
                </div>
            `;
        return;
    }

    if (state.drawerMode === 'email-compose') {
        refs.drawer.innerHTML = renderEmailComposeDrawer();
        return;
    }

    if (state.drawerMode === 'calendar-event') {
        refs.drawer.innerHTML = renderCalendarEventDrawer();
        return;
    }

    const isCreatingMember = state.drawerMode === 'create-member';
    const client = createBlankClient(isCreatingMember ? 'member' : 'lead');

    if (!client) {
        refs.drawer.innerHTML = '';
        return;
    }

    const canAdminEdit = hasPermission(state.session, PERMISSIONS.EDIT_ADMIN_FIELDS);
    const assigneeOptions = getAssignableUsers({ includeAdmin: true });
    const entityLabel = isCreatingMember ? 'member' : 'lead';
    const title = isCreatingMember ? 'Create member' : 'Create lead';
    const subtitle = isCreatingMember
        ? 'Add a new member manually. Successful saves open directly in the member detail workflow.'
        : 'Add a new lead manually. Duplicate checks run before saving, and successful creates open directly in the lead detail workflow.';

    refs.drawer.innerHTML = `
        <div class="drawer-surface">
            <div class="drawer-head">
                <div>
                    <span class="crm-kicker"><i class="fa-solid fa-user-pen"></i> New ${entityLabel}</span>
                    <h2 class="drawer-title">${escapeHtml(title)}</h2>
                    <p class="panel-subtitle">${escapeHtml(subtitle)}</p>
                </div>
                <button class="crm-button-ghost" data-action="close-drawer"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <form id="client-form">
                <input type="hidden" name="id" value="${escapeHtml(client.id || '')}">
                <input type="hidden" name="lifecycleType" value="${escapeHtml(client.lifecycleType || 'lead')}">
                ${canAdminEdit ? '' : `
                    <input type="hidden" name="assignedRepId" value="${escapeHtml(client.assignedRepId || state.session.id)}">
                    <input type="hidden" name="assignedTo" value="${escapeHtml(client.assignedTo || state.session.name)}">
                `}

                <div class="form-grid">
                    <label class="form-field">
                        <span class="form-label">First name</span>
                        <input class="crm-input" name="firstName" value="${escapeHtml(client.firstName || '')}" placeholder="Jordan" required>
                    </label>
                    <label class="form-field">
                        <span class="form-label">Last name</span>
                        <input class="crm-input" name="lastName" value="${escapeHtml(client.lastName || '')}" placeholder="Hale" required>
                    </label>
                    <label class="form-field">
                        <span class="form-label">Email</span>
                        <input class="crm-input" name="email" type="email" value="${escapeHtml(client.email || '')}" placeholder="prospect@example.com" required>
                    </label>
                    <label class="form-field">
                        <span class="form-label">Phone</span>
                        <input class="crm-input" name="phone" value="${escapeHtml(client.phone || '')}" placeholder="(555) 123-4567" required>
                    </label>
                    <label class="form-field">
                        <span class="form-label">Status</span>
                        <select class="crm-select" name="status">
                            ${CRM_STATUS_OPTIONS.map((status) => `
                                <option value="${status}" ${client.status === status ? 'selected' : ''}>${titleCase(status)}</option>
                            `).join('')}
                        </select>
                    </label>
                    ${canAdminEdit ? renderLeadSelectField('Assigned rep', 'assignedRepId', assigneeOptions.map((user) => user.id), client.assignedRepId || '', true, assigneeOptions, { emptyLabel: 'Unassigned' }) : ''}
                    ${canAdminEdit ? `
                        <label class="form-field">
                            <span class="form-label">Subscription type</span>
                            <input class="crm-input" name="subscriptionType" value="${escapeHtml(client.subscriptionType || '')}" placeholder="Premium, Trial, Enterprise">
                        </label>
                    ` : ''}
                    ${(canAdminEdit || isSalesWorkspaceSession(state.session)) ? `
                        <label class="form-field">
                            <span class="form-label">Time zone override</span>
                            <select class="crm-select" name="timeZone">
                                <option value="">Auto detect (Unknown)</option>
                                ${CRM_TIME_ZONE_OPTIONS.map((timeZone) => `
                                    <option value="${escapeHtml(timeZone)}">${escapeHtml(timeZone)}</option>
                                `).join('')}
                            </select>
                        </label>
                    ` : ''}
                    <label class="form-field form-field-full">
                        <span class="form-label">Tags</span>
                        ${renderTagPicker({
                            name: 'tags',
                            selectedTags: client.tags || [],
                            editable: true
                        })}
                    </label>
                    <label class="form-field form-field-full">
                        <span class="form-label">Initial note</span>
                        <textarea class="crm-textarea" name="notes" placeholder="Capture context, next steps, or objections...">${escapeHtml(client.notes || '')}</textarea>
                    </label>
                </div>

                <div class="drawer-actions">
                    <button class="crm-button" type="submit"><i class="fa-solid fa-floppy-disk"></i> Save ${entityLabel}</button>
                    <button class="crm-button-ghost" type="button" data-action="close-drawer">Cancel</button>
                </div>
            </form>
        </div>
    `;
}

function getCalendarLeadOptions() {
    return [...state.clients]
        .filter((client) => canAccessClient(client))
        .sort((left, right) => (left.fullName || '').localeCompare(right.fullName || ''));
}

function buildDefaultCalendarStartValue(dateKey = state.drawerDate || state.calendar.selectedDate) {
    if (dateKey) {
        const parsedDate = parseDateKey(dateKey);
        return toDateTimeInputValue(new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate(), 10, 0, 0, 0));
    }

    const now = new Date();
    const roundedMinutes = now.getMinutes() > 30 ? 60 : 30;
    const suggested = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), roundedMinutes, 0, 0);
    return toDateTimeInputValue(suggested);
}

function buildCalendarClientMeta(client = {}) {
    return getSearchSuggestionMeta(client) || buildClientMetaLine(client);
}

function captureCalendarEventDraft() {
    const form = refs.drawer?.querySelector('#calendar-event-form');

    if (!form) {
        return state.calendar.formDraft;
    }

    const formData = new FormData(form);
    return {
        eventId: normalizeWhitespace(formData.get('eventId')),
        title: String(formData.get('title') ?? ''),
        actionText: String(formData.get('actionText') ?? ''),
        notes: String(formData.get('notes') ?? ''),
        startAt: String(formData.get('startAt') ?? ''),
        endAt: String(formData.get('endAt') ?? ''),
        eventTimeZone: String(formData.get('eventTimeZone') ?? ''),
        visibility: String(formData.get('visibility') ?? ''),
        sharedWithUserIds: formData.getAll('sharedWithUserIds').map((value) => normalizeWhitespace(value)).filter(Boolean)
    };
}

function preserveCalendarEventDraft() {
    state.calendar.formDraft = captureCalendarEventDraft();
}

function syncCalendarClientPicker({ leadId = '', name = '', meta = '' } = {}) {
    state.calendar.clientPicker = {
        ...createDefaultCalendarClientPickerState(),
        query: name || '',
        selectedLeadId: leadId || '',
        selectedLeadName: name || '',
        selectedLeadMeta: meta || ''
    };
}

function syncCalendarClientPickerFromDrawerContext() {
    const eventRecord = getCalendarEventById(state.drawerEventId);
    const clientId = normalizeWhitespace(state.drawerClientId || eventRecord?.leadId);
    const selectedLead = getAccessibleClientById(clientId);
    const fallbackName = selectedLead?.fullName || eventRecord?.leadName || '';
    const fallbackMeta = selectedLead
        ? buildCalendarClientMeta(selectedLead)
        : [eventRecord?.leadPhone, eventRecord?.leadEmail, eventRecord?.leadLifecycleType ? titleCase(eventRecord.leadLifecycleType) : ''].filter(Boolean).join(' · ');

    syncCalendarClientPicker({
        leadId: clientId,
        name: fallbackName,
        meta: fallbackMeta
    });
}

function focusCalendarClientSearchInput(caret = null) {
    const input = refs.drawer?.querySelector('.calendar-client-search-input');

    if (!input) {
        return;
    }

    calendarClientFocusRestorePending = true;
    input.focus();
    const position = typeof caret === 'number' ? caret : input.value.length;
    input.setSelectionRange(position, position);
}

function applyCalendarClientSuggestionSelection(suggestion) {
    if (!suggestion) {
        return;
    }

    if (!state.drawerEventId && state.calendar.formDraft) {
        const previousSuggestedTitle = `Follow-up with ${state.calendar.clientPicker.selectedLeadName || 'Client'}`;
        if (normalizeWhitespace(state.calendar.formDraft.title).toLowerCase() === normalizeWhitespace(previousSuggestedTitle).toLowerCase()) {
            state.calendar.formDraft.title = '';
        }
    }

    state.calendar.clientPicker = {
        ...createDefaultCalendarClientPickerState(),
        query: suggestion.fullName || '',
        selectedLeadId: suggestion.id,
        selectedLeadName: suggestion.fullName || '',
        selectedLeadMeta: getSearchSuggestionMeta(suggestion) || buildClientMetaLine(suggestion)
    };
}

function renderCalendarClientSuggestionList() {
    const picker = state.calendar.clientPicker;

    if (!picker.isOpen) {
        return '';
    }

    return `
        <div class="crm-search-suggestion-panel calendar-client-suggestion-panel">
            <div class="crm-search-suggestion-head">
                <span>Matches</span>
                <span>${picker.isLoading ? 'Searching...' : `${picker.suggestions.length} showing`}</span>
            </div>
            <div class="crm-search-suggestion-list" role="listbox" aria-label="Calendar client suggestions">
                ${picker.isLoading ? `
                    <div class="crm-search-suggestion-empty">
                        <i class="fa-solid fa-circle-notch fa-spin"></i>
                        Looking up clients...
                    </div>
                ` : picker.suggestions.length ? picker.suggestions.map((suggestion, index) => `
                    <button
                        type="button"
                        class="crm-search-suggestion-item ${index === picker.activeIndex ? 'active' : ''}"
                        data-action="select-calendar-client-suggestion"
                        data-client-id="${escapeHtml(suggestion.id)}"
                    >
                        <span class="crm-search-suggestion-copy">
                            <span class="crm-search-suggestion-label">
                                ${escapeHtml(suggestion.fullName || 'Unnamed lead')}
                                <span class="crm-search-suggestion-type ${suggestion.lifecycleType === 'member' ? 'member' : 'lead'}">
                                    ${escapeHtml(titleCase(suggestion.lifecycleType || 'lead'))}
                                </span>
                            </span>
                            <span class="crm-search-suggestion-meta">${escapeHtml(getSearchSuggestionMeta(suggestion) || buildClientMetaLine(suggestion))}</span>
                        </span>
                    </button>
                `).join('') : `
                    <div class="crm-search-suggestion-empty">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        No matching leads or members.
                    </div>
                `}
            </div>
        </div>
    `;
}

function queueCalendarClientSuggestions({ immediate = false, caret = null } = {}) {
    const query = normalizeWhitespace(state.calendar.clientPicker.query);

    preserveCalendarEventDraft();
    window.clearTimeout(calendarClientSuggestionsTimer);
    calendarClientSuggestionsRequestId += 1;

    if (!query) {
        state.calendar.clientPicker.suggestions = [];
        state.calendar.clientPicker.isLoading = false;
        state.calendar.clientPicker.isOpen = false;
        state.calendar.clientPicker.activeIndex = -1;
        state.calendar.clientPicker.lastQuery = '';
        renderDrawer();
        focusCalendarClientSearchInput(caret);
        return;
    }

    const requestId = calendarClientSuggestionsRequestId;
    const runLookup = async () => {
        try {
            const suggestions = await dataService.searchClientSuggestions({ query, limit: 5 });

            if (requestId !== calendarClientSuggestionsRequestId || normalizeWhitespace(state.calendar.clientPicker.query) !== query) {
                return;
            }

            state.calendar.clientPicker.suggestions = suggestions;
            state.calendar.clientPicker.activeIndex = suggestions.length ? 0 : -1;
        } catch (error) {
            if (requestId !== calendarClientSuggestionsRequestId) {
                return;
            }

            state.calendar.clientPicker.suggestions = [];
            state.calendar.clientPicker.activeIndex = -1;
            flashNotice(error.message || 'Unable to load client suggestions.', 'error');
        } finally {
            if (requestId !== calendarClientSuggestionsRequestId) {
                return;
            }

            state.calendar.clientPicker.isLoading = false;
            state.calendar.clientPicker.isOpen = true;
            state.calendar.clientPicker.lastQuery = query;
            renderDrawer();
            focusCalendarClientSearchInput(caret);
        }
    };

    state.calendar.clientPicker.isLoading = true;
    state.calendar.clientPicker.isOpen = true;
    renderDrawer();
    focusCalendarClientSearchInput(caret);

    if (immediate) {
        runLookup();
        return;
    }

    calendarClientSuggestionsTimer = window.setTimeout(runLookup, SEARCH_SUGGESTION_DEBOUNCE_MS);
}

function renderCalendarEventDrawer() {
    const eventRecord = getCalendarEventById(state.drawerEventId);
    const canManage = !eventRecord || canManageCalendarEvent(eventRecord);
    const picker = state.calendar.clientPicker;
    const draft = state.calendar.formDraft || {};
    const selectedLeadId = normalizeWhitespace(picker.selectedLeadId || state.drawerClientId || eventRecord?.leadId);
    const selectedLead = getAccessibleClientById(selectedLeadId);
    const selectedLeadName = picker.selectedLeadName || selectedLead?.fullName || eventRecord?.leadName || '';
    const selectedLeadMeta = picker.selectedLeadMeta || (
        selectedLead
            ? buildCalendarClientMeta(selectedLead)
            : [eventRecord?.leadPhone, eventRecord?.leadEmail, eventRecord?.leadLifecycleType ? titleCase(eventRecord.leadLifecycleType) : ''].filter(Boolean).join(' · ')
    );
    const suggestedTitle = `Follow-up with ${selectedLeadName || 'Client'}`;
    const titleValue = !eventRecord && (!normalizeWhitespace(draft.title) || normalizeWhitespace(draft.title).toLowerCase() === 'follow-up with client')
        ? suggestedTitle
        : (draft.title ?? eventRecord?.title ?? suggestedTitle);
    const startAtValue = draft.startAt ?? (eventRecord ? toDateTimeInputValue(eventRecord.startAt) : buildDefaultCalendarStartValue());
    const endAtValue = draft.endAt ?? toDateTimeInputValue(eventRecord?.endAt || '');
    const actionTextValue = draft.actionText ?? eventRecord?.actionText ?? '';
    const notesValue = draft.notes ?? eventRecord?.notes ?? '';
    const eventTimeZoneOptions = dedupeStrings([
        draft.eventTimeZone,
        eventRecord?.eventTimeZone,
        selectedLead?.timeZone,
        eventRecord?.leadTimeZone,
        ...CRM_TIME_ZONE_OPTIONS
    ]).filter(Boolean);
    const shareableUsers = getAssignableUsers({ includeAdmin: true })
        .filter((user) => user.id !== (eventRecord?.ownerUserId || state.session?.id));
    const selectedShareIds = new Set(draft.sharedWithUserIds?.length ? draft.sharedWithUserIds : (eventRecord?.sharedWithUserIds || []));
    const visibility = draft.visibility || eventRecord?.visibility || 'private';

    if (eventRecord && !canManage) {
        return `
            <div class="drawer-surface calendar-event-drawer">
                <div class="drawer-head">
                    <div>
                        <h2 class="drawer-title">${escapeHtml(eventRecord.title)}</h2>
                    </div>
                    <button class="crm-button-ghost" data-action="close-drawer"><i class="fa-solid fa-xmark"></i></button>
                </div>

                <div class="calendar-drawer-readonly">
                    <div class="calendar-event-badges">
                        <span class="calendar-status-pill ${escapeHtml(eventRecord.status)}">${escapeHtml(titleCase(eventRecord.status))}</span>
                        <span class="calendar-visibility-pill ${escapeHtml(eventRecord.visibility)}">${escapeHtml(titleCase(eventRecord.visibility))}</span>
                    </div>
                    ${eventRecord.leadName ? `<div class="calendar-readonly-line"><strong>Client:</strong> ${escapeHtml(eventRecord.leadName)}</div>` : ''}
                    ${eventRecord.ownerName ? `<div class="calendar-readonly-line"><strong>Owner:</strong> ${escapeHtml(eventRecord.ownerName)}</div>` : ''}
                    <div class="calendar-readonly-line"><strong>When:</strong> ${escapeHtml(formatCalendarEventStamp(eventRecord))} · ${escapeHtml(eventRecord.eventTimeZone || 'Unknown')}</div>
                    ${eventRecord.actionText ? `<div class="calendar-readonly-line"><strong>Action:</strong> ${escapeHtml(eventRecord.actionText)}</div>` : ''}
                    ${eventRecord.notes ? `<div class="calendar-readonly-copy">${escapeHtml(eventRecord.notes)}</div>` : ''}
                    <div class="drawer-actions">
                        ${getAccessibleClientById(eventRecord.leadId) ? `
                            <button class="crm-button-secondary" type="button" data-action="open-lead-page" data-client-id="${escapeHtml(eventRecord.leadId)}">
                                <i class="fa-solid fa-user-large"></i> Open Client
                            </button>
                        ` : ''}
                        <button class="crm-button-ghost" type="button" data-action="close-drawer">Close</button>
                    </div>
                </div>
            </div>
        `;
    }

    const actionLabel = eventRecord ? 'Save follow-up changes' : 'Schedule follow-up';
    const canSubmit = Boolean(selectedLeadId);

    return `
        <div class="drawer-surface calendar-event-drawer">
            <div class="drawer-head">
                <div>
                    <h2 class="drawer-title">${escapeHtml(titleValue)}</h2>
                </div>
                <button class="crm-button-ghost" data-action="close-drawer"><i class="fa-solid fa-xmark"></i></button>
            </div>

            ${eventRecord ? `
                <div class="calendar-drawer-status-row">
                    <div class="calendar-event-badges">
                        <span class="calendar-status-pill ${escapeHtml(eventRecord.status)}">${escapeHtml(titleCase(eventRecord.status))}</span>
                        <span class="calendar-visibility-pill ${escapeHtml(eventRecord.visibility)}">${escapeHtml(titleCase(eventRecord.visibility))}</span>
                    </div>
                    <div class="calendar-event-actions">
                        ${renderCalendarStatusActions(eventRecord, true)}
                    </div>
                </div>
            ` : ''}

            <form id="calendar-event-form" class="calendar-event-form">
                <input type="hidden" name="eventId" value="${escapeHtml(eventRecord?.id || '')}">
                <input type="hidden" name="leadId" value="${escapeHtml(selectedLeadId)}">

                <div class="form-grid">
                    <label class="form-field form-field-full">
                        <span class="form-label">Client</span>
                        <div class="search-shell calendar-client-search-shell ${picker.isOpen ? 'is-expanded' : ''}">
                            <i class="fa-solid fa-magnifying-glass"></i>
                            <input
                                class="calendar-client-search-input"
                                type="search"
                                value="${escapeHtml(picker.query)}"
                                placeholder="Search by name, email, or phone"
                                autocomplete="off"
                                role="combobox"
                                aria-autocomplete="list"
                                aria-expanded="${picker.isOpen ? 'true' : 'false'}"
                            >
                            ${renderCalendarClientSuggestionList()}
                        </div>
                        ${selectedLeadId ? `
                            <div class="calendar-client-selection">
                                <strong>${escapeHtml(selectedLeadName || 'Client selected')}</strong>
                                ${selectedLeadMeta ? `<span>${escapeHtml(selectedLeadMeta)}</span>` : ''}
                            </div>
                        ` : '<div class="calendar-client-selection empty">Pick a client before saving.</div>'}
                    </label>

                    <label class="form-field">
                        <span class="form-label">Title</span>
                        <input class="crm-input" name="title" value="${escapeHtml(titleValue)}" placeholder="Follow-up with client" required>
                    </label>

                    <label class="form-field">
                        <span class="form-label">Start time</span>
                        <input class="crm-input" name="startAt" type="datetime-local" value="${escapeHtml(startAtValue)}" required>
                    </label>

                    <label class="form-field">
                        <span class="form-label">End time</span>
                        <input class="crm-input" name="endAt" type="datetime-local" value="${escapeHtml(endAtValue)}">
                    </label>

                    <label class="form-field">
                        <span class="form-label">Event time zone</span>
                        <select class="crm-select" name="eventTimeZone">
                            ${eventTimeZoneOptions.map((timeZone) => `
                                <option value="${escapeHtml(timeZone)}" ${(draft.eventTimeZone || eventRecord?.eventTimeZone || selectedLead?.timeZone || eventRecord?.leadTimeZone || 'Unknown') === timeZone ? 'selected' : ''}>
                                    ${escapeHtml(timeZone)}
                                </option>
                            `).join('')}
                        </select>
                    </label>

                    <label class="form-field">
                        <span class="form-label">Visibility</span>
                        <select class="crm-select" name="visibility">
                            ${CALENDAR_EVENT_VISIBILITY_OPTIONS.map((option) => `
                                <option value="${escapeHtml(option)}" ${visibility === option ? 'selected' : ''}>${escapeHtml(titleCase(option))}</option>
                            `).join('')}
                        </select>
                    </label>

                    <label class="form-field form-field-full">
                        <span class="form-label">Action text</span>
                        <input class="crm-input" name="actionText" value="${escapeHtml(actionTextValue)}" placeholder="Review objection, confirm payment, final onboarding call">
                    </label>

                    <label class="form-field form-field-full">
                        <span class="form-label">Notes</span>
                        <textarea class="crm-textarea" name="notes" placeholder="Add extra context the next rep or shared teammate should see...">${escapeHtml(notesValue)}</textarea>
                    </label>

                    <fieldset class="form-field form-field-full calendar-share-fieldset">
                        <span class="form-label">Share with teammates</span>
                        <div class="calendar-share-grid">
                            ${shareableUsers.length ? shareableUsers.map((user) => `
                                <label class="calendar-share-option">
                                    <input
                                        type="checkbox"
                                        name="sharedWithUserIds"
                                        value="${escapeHtml(user.id)}"
                                        ${selectedShareIds.has(user.id) ? 'checked' : ''}
                                    >
                                    <span>${escapeHtml(user.name)}</span>
                                </label>
                            `).join('') : '<div class="panel-subtitle">No additional teammates are available to share with.</div>'}
                        </div>
                        <span class="panel-subtitle">Shares apply only when visibility is set to Shared.</span>
                    </fieldset>
                </div>

                <div class="drawer-actions">
                    <button class="crm-button" type="submit" ${canSubmit ? '' : 'disabled'}>
                        <i class="fa-solid fa-floppy-disk"></i> ${escapeHtml(actionLabel)}
                    </button>
                    <button class="crm-button-ghost" type="button" data-action="close-drawer">Cancel</button>
                </div>
            </form>
        </div>
    `;
}

function renderModal() {
    if (!state.modal) {
        refs.modalLayer.classList.add('hidden');
        refs.modalLayer.classList.remove('crm-modal-layer-history');
        refs.modalLayer.innerHTML = '';
        return;
    }

    refs.modalLayer.classList.remove('hidden');
    refs.modalLayer.classList.toggle('crm-modal-layer-history', state.modal.type === 'lead-history');

    if (state.modal.type === 'import') {
        refs.modalLayer.innerHTML = renderImportModal();
        return;
    }

    if (state.modal.type === 'user-form') {
        refs.modalLayer.innerHTML = renderUserFormModal();
        return;
    }

    if (state.modal.type === 'create-duplicate') {
        refs.modalLayer.innerHTML = renderCreateDuplicateModal();
        return;
    }

    if (state.modal.type === 'duplicate-merge') {
        refs.modalLayer.innerHTML = renderDuplicateMergeModal();
        return;
    }

    if (state.modal.type === 'confirm-delete') {
        refs.modalLayer.innerHTML = `
            <div class="crm-modal">
                <div class="modal-head">
                    <div>
                        <span class="crm-kicker"><i class="fa-solid fa-triangle-exclamation"></i> Confirm delete</span>
                        <h2 class="modal-title">Delete this lead record?</h2>
                        <p class="panel-subtitle">This removes the lead from this workspace.</p>
                    </div>
                    <button class="crm-button-ghost" data-action="close-modal"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-actions" style="margin-top: 1.2rem;">
                    <button class="crm-button-danger" data-action="confirm-delete" data-client-id="${escapeHtml(state.modal.clientId)}">
                        <i class="fa-solid fa-trash"></i> Delete lead
                    </button>
                    <button class="crm-button-ghost" data-action="close-modal">Cancel</button>
                </div>
            </div>
        `;
        return;
    }

    if (state.modal.type === 'confirm-clear') {
        refs.modalLayer.innerHTML = `
            <div class="crm-modal">
                <div class="modal-head">
                    <div>
                        <span class="crm-kicker"><i class="fa-solid fa-skull-crossbones"></i> Danger</span>
                        <h2 class="modal-title">Clear all CRM data?</h2>
                        <p class="panel-subtitle">Type <span class="inline-code">CLEAR</span> to remove all leads, members, and import history from this workspace.</p>
                    </div>
                    <button class="crm-button-ghost" data-action="close-modal"><i class="fa-solid fa-xmark"></i></button>
                </div>

                <form id="clear-data-form" style="margin-top: 1rem;">
                    <label class="form-field">
                        <span class="form-label">Confirmation text</span>
                        <input class="crm-input" name="confirmation" placeholder="Type CLEAR">
                    </label>
                    <div class="modal-actions" style="margin-top: 1rem;">
                        <button class="crm-button-danger" type="submit"><i class="fa-solid fa-trash"></i> Clear data</button>
                        <button class="crm-button-ghost" type="button" data-action="close-modal">Cancel</button>
                    </div>
                </form>
            </div>
        `;
        return;
    }

    if (state.modal.type === 'lead-history') {
        refs.modalLayer.innerHTML = renderLeadHistoryModal();
    }
}

function renderLeadHistoryModal() {
    const lead = getAccessibleClientById(state.modal?.clientId || state.detailClientId);

    if (!lead) {
        return `
            <div class="crm-modal crm-history-modal" role="dialog" aria-modal="true" aria-labelledby="crm-history-modal-title">
                <div class="crm-history-modal-head">
                    <div class="crm-history-modal-copy">
                        <span class="crm-kicker">Lead history</span>
                        <h2 id="crm-history-modal-title" class="modal-title">History unavailable</h2>
                        <p class="panel-subtitle">This record is no longer available in the current workspace view.</p>
                    </div>
                    <button class="crm-button-ghost" data-action="close-modal" aria-label="Close lead history">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
        `;
    }

    const entityLabel = lead.lifecycleType === 'member' ? 'Member' : 'Lead';
    const detailName = lead.fullName || `Unnamed ${entityLabel.toLowerCase()}`;
    const leadHistoryEntries = getLeadHistoryEntries(lead);
    const latestEntry = leadHistoryEntries[0];

    return `
        <div class="crm-modal crm-history-modal" role="dialog" aria-modal="true" aria-labelledby="crm-history-modal-title">
            <div class="crm-history-modal-head">
                <div class="crm-history-modal-copy">
                    <span class="crm-kicker">${escapeHtml(entityLabel)} history</span>
                    <h2 id="crm-history-modal-title" class="modal-title">${escapeHtml(detailName)}</h2>
                    <div class="crm-history-modal-meta">
                        <span class="summary-chip"><i class="fa-solid fa-clock-rotate-left"></i> ${leadHistoryEntries.length.toLocaleString()} updates</span>
                        <span class="summary-chip"><i class="fa-solid fa-user-check"></i> ${escapeHtml(lead.assignedTo || 'Unassigned')}</span>
                        <span class="summary-chip"><i class="fa-solid fa-bolt"></i> ${escapeHtml(titleCase(lead.status || 'new'))}</span>
                        <span class="summary-chip"><i class="fa-solid fa-calendar-days"></i> ${escapeHtml(latestEntry ? `Latest ${formatDateTime(latestEntry.changedAt || latestEntry.createdAt)}` : 'No history yet')}</span>
                    </div>
                </div>
                <button class="crm-button-ghost" data-action="close-modal" aria-label="Close lead history">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <div class="crm-history-modal-body">
                <div class="crm-history-modal-scroll">
                    ${renderLeadHistoryEntries(leadHistoryEntries)}
                </div>
            </div>
        </div>
    `;
}

function renderCreateDuplicateModal() {
    const duplicateLead = state.modal?.duplicateLead;
    const incomingPayload = state.modal?.incomingPayload;

    if (!duplicateLead || !incomingPayload) {
        return '';
    }

    return `
        <div class="crm-modal">
            <div class="modal-head">
                <div>
                    <span class="crm-kicker"><i class="fa-solid fa-clone"></i> Duplicate detected</span>
                    <h2 class="modal-title">A lead with the same phone or email already exists.</h2>
                    <p class="panel-subtitle">Choose whether to open the existing lead, merge field by field, or cancel the create flow.</p>
                </div>
                <button class="crm-button-ghost" data-action="close-modal"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <div class="overview-grid" style="margin-top: 1rem;">
                <section class="crm-card">
                    <h3 class="section-title">Existing lead</h3>
                    <ul class="mini-list">
                        <li><span class="mini-list-title">Name</span><span class="mini-list-meta">${escapeHtml(duplicateLead.fullName || 'Unnamed lead')}</span></li>
                        <li><span class="mini-list-title">Email</span><span class="mini-list-meta">${renderEmailLink(duplicateLead.email, {
                            clientId: duplicateLead.id,
                            recipientName: duplicateLead.fullName || duplicateLead.firstName || duplicateLead.lastName || ''
                        })}</span></li>
                        <li><span class="mini-list-title">Phone</span><span class="mini-list-meta">${renderPhoneLink(duplicateLead.phone)}</span></li>
                        <li><span class="mini-list-title">Assigned rep</span><span class="mini-list-meta">${escapeHtml(duplicateLead.assignedTo || 'Unassigned')}</span></li>
                    </ul>
                </section>
                <section class="crm-card">
                    <h3 class="section-title">Incoming lead</h3>
                    <ul class="mini-list">
                        <li><span class="mini-list-title">Name</span><span class="mini-list-meta">${escapeHtml(`${incomingPayload.firstName || ''} ${incomingPayload.lastName || ''}`.trim() || 'Unnamed lead')}</span></li>
                        <li><span class="mini-list-title">Email</span><span class="mini-list-meta">${renderEmailLink(incomingPayload.email, {
                            recipientName: incomingPayload.fullName || incomingPayload.firstName || incomingPayload.lastName || ''
                        })}</span></li>
                        <li><span class="mini-list-title">Phone</span><span class="mini-list-meta">${renderPhoneLink(incomingPayload.phone)}</span></li>
                        <li><span class="mini-list-title">Status</span><span class="mini-list-meta">${escapeHtml(titleCase(incomingPayload.status || 'new'))}</span></li>
                    </ul>
                </section>
            </div>

            <div class="modal-actions" style="margin-top: 1.2rem;">
                <button class="crm-button-secondary" data-action="open-duplicate-existing"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open existing lead</button>
                <button class="crm-button" data-action="show-duplicate-merge"><i class="fa-solid fa-code-merge"></i> Merge into existing</button>
                <button class="crm-button-ghost" data-action="close-modal">Cancel</button>
            </div>
        </div>
    `;
}

function renderDuplicateMergeModal() {
    const duplicateLead = state.modal?.duplicateLead;
    const incomingPayload = state.modal?.incomingPayload;
    const fields = duplicateLead && incomingPayload ? getMergeComparisonFields(duplicateLead, incomingPayload) : [];

    if (!duplicateLead || !incomingPayload) {
        return '';
    }

    return `
        <div class="crm-modal">
            <div class="modal-head">
                <div>
                    <span class="crm-kicker"><i class="fa-solid fa-code-merge"></i> Resolve merge</span>
                    <h2 class="modal-title">Choose the winning value for each conflicting field.</h2>
                    <p class="panel-subtitle">Nothing is guessed globally. Each field is resolved independently before the existing lead is updated.</p>
                </div>
                <button class="crm-button-ghost" data-action="close-modal"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <form id="duplicate-merge-form" style="margin-top: 1rem;">
                <input type="hidden" name="existingLeadId" value="${escapeHtml(duplicateLead.id)}">
                ${fields.length ? `
                    <div class="history-list">
                        ${fields.map((field) => `
                            <article class="history-card">
                                <div class="history-head">
                                    <div>
                                        <div class="history-title">${escapeHtml(field.label)}</div>
                                    </div>
                                </div>
                                <div class="merge-resolution-grid">
                                    ${field.choices.map((choice) => `
                                        <label class="merge-choice-card">
                                            <input type="radio" name="resolve-${field.key}" value="${choice}" ${choice === 'existing' ? 'checked' : ''}>
                                            <strong>${escapeHtml(choice === 'combine' ? 'Combine' : titleCase(choice))}</strong>
                                            <div class="panel-subtitle">${escapeHtml(getMergeChoicePreview(field, choice))}</div>
                                        </label>
                                    `).join('')}
                                </div>
                            </article>
                        `).join('')}
                    </div>
                ` : '<div class="panel-subtitle">No conflicting fields were found. You can merge directly.</div>'}
                <div class="modal-actions" style="margin-top: 1rem;">
                    <button class="crm-button" type="submit"><i class="fa-solid fa-code-merge"></i> Merge lead</button>
                    <button class="crm-button-ghost" type="button" data-action="close-modal">Cancel</button>
                </div>
            </form>
        </div>
    `;
}

function renderUserFormModal() {
    const user = state.modal?.userId ? authService.getUserById(state.modal.userId) : null;

    if (!user) {
        return `
            <div class="crm-modal">
                <div class="modal-head">
                    <div>
                        <span class="crm-kicker"><i class="fa-solid fa-user-shield"></i> CRM account</span>
                        <h2 class="modal-title">Account required</h2>
                        <p class="panel-subtitle">Create the user account first, then return here to edit their CRM profile.</p>
                    </div>
                    <button class="crm-button-ghost" data-action="close-modal"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-actions" style="margin-top: 1rem;">
                    <button class="crm-button-ghost" type="button" data-action="close-modal">Close</button>
                </div>
            </div>
        `;
    }

    return `
        <div class="crm-modal">
            <div class="modal-head">
                <div>
                    <span class="crm-kicker"><i class="fa-solid fa-user-shield"></i> CRM account</span>
                    <h2 class="modal-title">Edit CRM account</h2>
                    <p class="panel-subtitle">Update the CRM profile for this teammate. Email and password changes should be managed from account administration.</p>
                </div>
                <button class="crm-button-ghost" data-action="close-modal"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <form id="user-form" style="margin-top: 1rem;">
                <input type="hidden" name="id" value="${escapeHtml(user?.id || '')}">
                <div class="form-grid">
                    <label class="form-field">
                        <span class="form-label">Name</span>
                        <input class="crm-input" name="name" value="${escapeHtml(user?.name || '')}" placeholder="Bill Carter">
                    </label>
                    <label class="form-field">
                        <span class="form-label">Email</span>
                        <input class="crm-input" name="email" type="email" value="${escapeHtml(user?.email || '')}" readonly>
                        <span class="panel-subtitle">Managed in account administration.</span>
                    </label>
                    <label class="form-field">
                        <span class="form-label">Role</span>
                        <select class="crm-select" name="role">
                            <option value="sales" ${user?.role === 'sales' ? 'selected' : ''}>Sales rep</option>
                            <option value="senior" ${user?.role === 'senior' ? 'selected' : ''}>Senior rep</option>
                            <option value="support" ${user?.role === 'support' ? 'selected' : ''}>Support</option>
                        </select>
                    </label>
                    <label class="form-field">
                        <span class="form-label">Status</span>
                        <select class="crm-select" name="isActive">
                            <option value="true" ${user?.isActive !== false ? 'selected' : ''}>Active</option>
                            <option value="false" ${user?.isActive === false ? 'selected' : ''}>Inactive</option>
                        </select>
                    </label>
                </div>

                <div class="modal-actions" style="margin-top: 1rem;">
                    <button class="crm-button" type="submit"><i class="fa-solid fa-floppy-disk"></i> Save account</button>
                    <button class="crm-button-ghost" type="button" data-action="close-modal">Cancel</button>
                </div>
            </form>
        </div>
    `;
}

function renderImportModal() {
    const flow = state.importFlow;

    if (!flow || flow.step === 'select') {
        return `
            <div class="crm-modal">
                <div class="modal-head">
                    <div>
                        <span class="crm-kicker"><i class="fa-solid fa-file-csv"></i> CSV Import</span>
                        <h2 class="modal-title">Upload lead data</h2>
                        <p class="panel-subtitle">Review the CSV, map the fields, and import the records into the workspace.</p>
                    </div>
                    <button class="crm-button-ghost" data-action="close-modal"><i class="fa-solid fa-xmark"></i></button>
                </div>

                <div class="empty-state" style="margin-top: 1rem;">
                    <div>
                        <div class="empty-copy">Choose a CSV with lead columns like name, email, phone, tags, notes, subscription type, or time zone.</div>
                        <div class="auth-actions" style="justify-content: center; margin-top: 1rem;">
                            <label class="crm-button-secondary" for="import-file-input">
                                <i class="fa-solid fa-upload"></i> Choose CSV file
                            </label>
                            <input id="import-file-input" type="file" accept=".csv,text/csv" class="hidden">
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    if (flow.step === 'loading') {
        return `
            <div class="crm-modal">
                ${renderLoadingState('Parsing CSV and preparing the import preview...')}
            </div>
        `;
    }

    if (flow.step === 'result') {
        return `
            <div class="crm-modal">
                <div class="modal-head">
                    <div>
                        <span class="crm-kicker"><i class="fa-solid fa-circle-check"></i> Import complete</span>
                        <h2 class="modal-title">${escapeHtml(flow.fileName)}</h2>
                        <p class="panel-subtitle">The CRM data has been updated and the summary was added to import history.</p>
                    </div>
                    <button class="crm-button-ghost" data-action="close-modal"><i class="fa-solid fa-xmark"></i></button>
                </div>

                <div class="stats-strip">
                    ${renderStatTile('Imported', flow.result.importedCount)}
                    ${renderStatTile('Replaced', flow.result.replacedCount)}
                    ${renderStatTile('Merged', flow.result.mergedCount)}
                    ${renderStatTile('Skipped', flow.result.skippedCount)}
                </div>
                <div class="stats-strip">
                    ${renderStatTile('Failed', flow.result.failedCount)}
                    ${renderStatTile('Rows', flow.result.totalRows)}
                    ${renderStatTile('Mode', flow.duplicateMode)}
                    ${renderStatTile('When', formatDateTime(flow.result.historyEntry.importedAt))}
                </div>

                <div class="modal-actions" style="margin-top: 1.2rem;">
                    <button class="crm-button-secondary" data-action="close-modal"><i class="fa-solid fa-check"></i> Close</button>
                    <button class="crm-button-ghost" data-action="jump-to-view" data-view="admin" data-admin-tab="imports"><i class="fa-solid fa-clock-rotate-left"></i> View history</button>
                </div>
            </div>
        `;
    }

    const preview = flow.preview;
    const mappingIssues = preview.mappingIssues.unresolvedRequiredFields;

    return `
        <div class="crm-modal">
            <div class="modal-head">
                <div>
                    <span class="crm-kicker"><i class="fa-solid fa-wand-magic-sparkles"></i> Map and review</span>
                    <h2 class="modal-title">${escapeHtml(flow.fileName)}</h2>
                    <p class="panel-subtitle">
                        ${flow.rawRows.length.toLocaleString()} rows detected. Adjust the auto-mapping if needed, then choose how duplicates should be handled.
                    </p>
                </div>
                <button class="crm-button-ghost" data-action="close-modal"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <form id="import-mapping-form">
                <div class="import-grid">
                    <section class="crm-card">
                        <h3 class="section-title">Column mapping</h3>
                        <div class="mapping-grid" style="margin-top: 1rem;">
                            ${importFields.map((field) => `
                                <div class="mapping-row">
                                    <div>
                                        <div class="mapping-label">${escapeHtml(field.label)}</div>
                                        <div class="mapping-hint">${escapeHtml(field.hint)}</div>
                                    </div>
                                    <select class="crm-select" name="map-${field.key}" data-map-field="${field.key}">
                                        <option value="">Ignore this field</option>
                                        ${flow.headers.map((header) => `
                                            <option value="${escapeHtml(header)}" ${flow.mapping[field.key] === header ? 'selected' : ''}>${escapeHtml(header)}</option>
                                        `).join('')}
                                    </select>
                                </div>
                            `).join('')}
                        </div>

                        <h3 class="section-title" style="margin-top: 1.5rem;">Duplicate handling</h3>
                        <div class="auth-actions" style="margin-top: 0.75rem;">
                            ${[
                                { value: 'skip', label: 'Skip duplicates', copy: 'Keep existing records untouched.' },
                                { value: 'replace', label: 'Replace existing', copy: 'Overwrite mapped fields on duplicates.' },
                                { value: 'merge', label: 'Merge notes and tags', copy: 'Keep the record and combine notes/tags.' }
                            ].map((option) => `
                                <label class="auth-user-card" style="flex: 1; min-width: 220px;">
                                    <div class="auth-user-head">
                                        <div>
                                            <div class="auth-user-name">${escapeHtml(option.label)}</div>
                                            <div class="panel-subtitle">${escapeHtml(option.copy)}</div>
                                        </div>
                                        <input type="radio" name="duplicate-mode" value="${option.value}" ${flow.duplicateMode === option.value ? 'checked' : ''}>
                                    </div>
                                </label>
                            `).join('')}
                        </div>
                    </section>

                    <section class="crm-card">
                        <h3 class="section-title">Preview</h3>
                        <div class="stats-strip">
                            ${renderStatTile('Rows', preview.totalRows)}
                            ${renderStatTile('Valid', preview.validCount)}
                            ${renderStatTile('Duplicates', preview.duplicateCount)}
                            ${renderStatTile('Failed', preview.failedCount)}
                        </div>
                        <div class="stats-strip">
                            ${renderStatTile('File duplicates', preview.duplicateInFileCount)}
                            ${renderStatTile('Headers', flow.headers.length)}
                            ${renderStatTile('Mode', flow.duplicateMode)}
                            ${renderStatTile('Target', 'Workspace')}
                        </div>

                        ${mappingIssues.length ? `
                            <div class="crm-alert crm-alert-error" style="margin-top: 1rem;">
                                <div>${escapeHtml(mappingIssues.join(' '))}</div>
                            </div>
                        ` : ''}

                        ${preview.duplicateSamples.length ? `
                            <ul class="mini-list">
                                ${preview.duplicateSamples.map((sample) => `
                                    <li>
                                        <div class="mini-list-main">
                                            <span class="mini-list-title">Row ${sample.rowNumber}: ${escapeHtml(sample.incomingName)}</span>
                                            <span class="mini-list-meta">Possible match: ${escapeHtml(sample.existingName)}</span>
                                        </div>
                                    </li>
                                `).join('')}
                            </ul>
                        ` : '<div class="panel-subtitle" style="margin-top: 1rem;">No duplicate samples detected in the preview.</div>'}
                    </section>
                </div>

                <table class="sample-table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Email</th>
                            <th>Phone</th>
                            <th>Tags</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${preview.previewRecords.map((client) => `
                            <tr>
                                <td>${escapeHtml(client.fullName || 'Unnamed lead')}</td>
                                <td>${renderEmailLink(client.email, {
                                    recipientName: client.fullName || client.firstName || client.lastName || ''
                                })}</td>
                                <td>${renderPhoneLink(client.phone)}</td>
                                <td>${escapeHtml((client.tags || []).join(', ') || '—')}</td>
                                <td>${escapeHtml(client.status || 'new')}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>

                <div class="modal-actions" style="margin-top: 1rem;">
                    <button class="crm-button-ghost" type="button" data-action="reset-import"><i class="fa-solid fa-arrow-left"></i> Choose another file</button>
                    <button class="crm-button" type="button" data-action="confirm-import">
                        <i class="fa-solid fa-cloud-arrow-up"></i> Import ${preview.validCount.toLocaleString()} valid rows
                    </button>
                </div>
            </form>
        </div>
    `;
}

function renderTableHeaders({ canBulkAssign = false, allPageSelected = false } = {}) {
    const usingServerPaging = supportsServerWorkspacePaging();
    const headers = [
        { key: 'name', label: 'Name' },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Phone' },
        { key: 'tags', label: 'Tags' },
        { key: 'notes', label: 'Notes preview' },
        { key: 'status', label: 'Status' },
        { key: 'updatedAt', label: 'Updated' }
    ];

    return `
        ${canBulkAssign ? `
            <th class="selection-cell">
                <input
                    type="checkbox"
                    class="crm-checkbox"
                    data-action="toggle-select-page"
                    ${allPageSelected ? 'checked' : ''}
                    aria-label="Select current page"
                >
            </th>
        ` : ''}
        ${headers.map((header) => `
        <th>
            ${usingServerPaging && ['tags', 'notes'].includes(header.key) ? `
                <span class="sort-button disabled" aria-disabled="true">${header.label}</span>
            ` : `
                <button class="sort-button ${state.sort.field === header.key ? 'active' : ''}" data-action="sort-table" data-field="${header.key}">
                    ${header.label}
                    <i class="fa-solid ${getSortIcon(header.key)}"></i>
                </button>
            `}
        </th>
    `).join('')}
    `;
}

function renderLoadingState(message) {
    return `
        <div class="loading-state">
            <div>
                <div class="loading-spinner"></div>
                <div class="empty-copy">${escapeHtml(message)}</div>
            </div>
        </div>
    `;
}

function renderEmptyState({ title, copy, actions }) {
    return `
        <div class="empty-state">
            <div>
                <h3 class="section-title">${escapeHtml(title)}</h3>
                <p class="empty-copy">${escapeHtml(copy)}</p>
                <div class="auth-actions" style="justify-content: center; margin-top: 1rem;">${actions}</div>
            </div>
        </div>
    `;
}

function renderStatTile(label, value) {
    return `
        <div class="stat-tile">
            <div class="stat-tile-label">${escapeHtml(String(label))}</div>
            <div class="stat-tile-value">${escapeHtml(String(value))}</div>
        </div>
    `;
}

function getDashboardMetrics() {
    if (state.clientCacheMode !== 'full') {
        const leads = getWorkspaceResult('leads').rows;
        const members = getWorkspaceResult('members').rows;
        const totalLeads = getWorkspaceSummaryCount('leads');
        const totalMembers = getWorkspaceSummaryCount('members');
        const totalRecords = totalLeads + totalMembers;

        return {
            totalLeads,
            totalMembers,
            tagCounts: [],
            statusCounts: [],
            taggedLeadCount: 0,
            recentlyUpdated: [...leads, ...members]
                .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))
                .slice(0, 5),
            memberShare: totalRecords ? Math.round((totalMembers / totalRecords) * 100) : 0,
            topTag: { label: '', count: 0 },
            topStatus: { label: '', count: 0 }
        };
    }

    const leads = getScopedClients('leads', { ignoreSearch: true, ignoreFilters: true });
    const members = getScopedClients('members', { ignoreSearch: true, ignoreFilters: true });
    const tagCounts = aggregateCounts(leads.flatMap((client) => client.tags));
    const statusCounts = aggregateCounts(leads.map((client) => client.status || 'new'));
    const taggedLeadCount = leads.filter((client) => Array.isArray(client.tags) && client.tags.length).length;
    const recentlyUpdated = [...leads]
        .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))
        .slice(0, 5);
    const totalRecords = leads.length + members.length;

    return {
        totalLeads: leads.length,
        totalMembers: members.length,
        tagCounts,
        statusCounts,
        taggedLeadCount,
        recentlyUpdated,
        memberShare: totalRecords ? Math.round((members.length / totalRecords) * 100) : 0,
        topTag: tagCounts[0] ? { label: tagCounts[0][0], count: tagCounts[0][1] } : { label: '', count: 0 },
        topStatus: statusCounts[0] ? { label: titleCase(statusCounts[0][0]), count: statusCounts[0][1] } : { label: '', count: 0 }
    };
}

function aggregateCounts(values) {
    const counts = values.reduce((map, value) => {
        const key = normalizeWhitespace(value) || 'unassigned';
        map.set(key, (map.get(key) ?? 0) + 1);
        return map;
    }, new Map());

    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

function getVisibleClients(scope = getDefaultScopeForView()) {
    const clients = getScopedClients(scope);

    if (scope !== 'leads' || !hasPermission(state.session, PERMISSIONS.ASSIGN_LEADS)) {
        return clients;
    }

    const assignmentState = getLeadAssignmentStateForScope(scope);

    if (assignmentState === 'assigned') {
        return clients.filter((client) => normalizeWhitespace(client.assignedRepId));
    }

    if (assignmentState === 'unassigned') {
        return clients.filter((client) => !normalizeWhitespace(client.assignedRepId));
    }

    return clients;
}

function getLeadNavigationSet(scope = getDefaultScopeForView()) {
    if (supportsServerWorkspacePaging()) {
        const workspaceRows = getWorkspacePageRows(scope);

        if (workspaceRows.length) {
            return workspaceRows;
        }
    }

    return getVisibleClients(scope);
}

function getScopedClients(scope = 'leads', options = {}) {
    const ignoreSearch = options.ignoreSearch === true;
    const ignoreFilters = options.ignoreFilters === true;
    const filtersKey = JSON.stringify({
        scope,
        ignoreSearch,
        ignoreFilters,
        search: normalizeWhitespace(state.workspaceSearch).toLowerCase(),
        status: state.filters.status,
        tag: state.filters.tag,
        multi: state.filters.multi
    });
    const sortKey = `${state.sort.field}:${state.sort.direction}`;

    if (
        visibleClientsCache.clientsRef === state.clients
        && visibleClientsCache.filtersKey === filtersKey
        && visibleClientsCache.sortKey === sortKey
    ) {
        return visibleClientsCache.result;
    }

    const searchTerm = normalizeWhitespace(state.workspaceSearch).toLowerCase();
    const matchers = buildFilterMatchers();
    const result = [...state.clients]
        .filter((client) => {
            if (!canAccessClient(client)) {
                return false;
            }

            if (!matchesScope(client, scope)) {
                return false;
            }

            if (!ignoreFilters) {
                if (state.filters.status !== 'all' && client.status !== state.filters.status) {
                    return false;
                }

                if (state.filters.tag !== 'all' && !client.tags.includes(state.filters.tag)) {
                    return false;
                }

                if (!matchesMultiValueFilters(client, matchers)) {
                    return false;
                }
            }

            if (ignoreSearch || !searchTerm) {
                return true;
            }

            const searchable = [
                client.fullName,
                client.firstName,
                client.lastName,
                client.email,
                client.phone,
                client.phoneKey,
                client.businessName,
                client.tags.join(' '),
                client.notes,
                client.status,
                client.assignedTo,
                client.subscriptionType,
                client.timeZone
            ].join(' ').toLowerCase();

            return searchable.includes(searchTerm);
        })
        .sort((left, right) => compareClients(left, right, state.sort));

    visibleClientsCache.clientsRef = state.clients;
    visibleClientsCache.filtersKey = filtersKey;
    visibleClientsCache.sortKey = sortKey;
    visibleClientsCache.result = result;

    return result;
}

function matchesScope(client, scope) {
    if (scope === 'members') {
        return client.lifecycleType === 'member';
    }

    if (scope === 'all') {
        return true;
    }

    return client.lifecycleType !== 'member';
}

function canAccessClient(client) {
    if (!client) {
        return false;
    }

    if (hasPermission(state.session, PERMISSIONS.VIEW_ALL_RECORDS)) {
        return true;
    }

    return client.assignedRepId === state.session?.id;
}

function getAccessibleClientById(clientId) {
    const client = state.clients.find((item) => item.id === clientId) || null;
    return canAccessClient(client) ? client : null;
}

function buildFilterMatchers() {
    return {
        firstNames: new Set(state.filters.multi.firstNames.map((value) => value.toLowerCase())),
        lastNames: new Set(state.filters.multi.lastNames.map((value) => value.toLowerCase())),
        areaCodes: new Set(state.filters.multi.areaCodes),
        subscriptionTypes: new Set(state.filters.multi.subscriptionTypes.map((value) => value.toLowerCase())),
        timeZones: new Set(state.filters.multi.timeZones.map((value) => value.toLowerCase()))
    };
}

function matchesMultiValueFilters(client, matchers) {
    const firstName = normalizeWhitespace(client.firstName).toLowerCase();
    const lastName = normalizeWhitespace(client.lastName).toLowerCase();
    const areaCode = extractAreaCode(client.phoneKey || client.phone);
    const subscriptionType = normalizeWhitespace(client.subscriptionType).toLowerCase();
    const timeZone = normalizeWhitespace(client.timeZone).toLowerCase();

    if (matchers.firstNames.size && !matchers.firstNames.has(firstName)) {
        return false;
    }

    if (matchers.lastNames.size && !matchers.lastNames.has(lastName)) {
        return false;
    }

    if (matchers.areaCodes.size && !matchers.areaCodes.has(areaCode)) {
        return false;
    }

    if (matchers.subscriptionTypes.size && !matchers.subscriptionTypes.has(subscriptionType)) {
        return false;
    }

    if (matchers.timeZones.size && !matchers.timeZones.has(timeZone)) {
        return false;
    }

    return true;
}

function getPaginatedClients(clients) {
    const totalPages = Math.max(1, Math.ceil(clients.length / state.pageSize));

    if (state.page > totalPages) {
        state.page = totalPages;
    }

    const start = (state.page - 1) * state.pageSize;
    return clients.slice(start, start + state.pageSize);
}

function compareClients(left, right, sort) {
    const direction = sort.direction === 'asc' ? 1 : -1;
    const leftValue = getComparableValue(left, sort.field);
    const rightValue = getComparableValue(right, sort.field);

    if (typeof leftValue === 'number' || typeof rightValue === 'number') {
        return ((leftValue || 0) - (rightValue || 0)) * direction;
    }

    return String(leftValue || '').localeCompare(String(rightValue || '')) * direction;
}

function getComparableValue(client, field) {
    switch (field) {
        case 'name':
            return client.fullName || '';
        case 'tags':
            return client.tags.join(', ');
        case 'notes':
            return client.notes || '';
        case 'updatedAt':
            return Date.parse(client.updatedAt || 0);
        default:
            return client[field] || '';
    }
}

function getAvailableTags() {
    return [...getActiveTagLabels()].sort((left, right) => left.localeCompare(right));
}

function dedupeAllowedTags(tags) {
    const allowedMap = buildAllowedTagMap(getActiveTagLabels());

    return parseTags(tags)
        .map((tag) => allowedMap.get(tag.toLowerCase()) || tag)
        .filter((tag, index, values) => values.findIndex((value) => value.toLowerCase() === tag.toLowerCase()) === index);
}

function buildAllowedTagMap(tags = state.allowedTags) {
    return parseTags(tags).reduce((map, tag) => {
        map.set(tag.toLowerCase(), tag);
        return map;
    }, new Map());
}

function getTagSuggestions(query, selectedTags = []) {
    const selectedKeys = new Set(parseTags(selectedTags).map((tag) => tag.toLowerCase()));
    const normalizedQuery = normalizeWhitespace(query).toLowerCase();

    return parseTags(getActiveTagLabels())
        .filter((tag) => !selectedKeys.has(tag.toLowerCase()))
        .filter((tag) => !normalizedQuery || tag.toLowerCase().includes(normalizedQuery))
        .slice(0, 8);
}

function getVisibleSavedFilters() {
    return state.savedFilters;
}

function canManageSavedFilter(filter) {
    return canManageSavedFilterForSession(state.session, filter);
}

function getActiveFilterCount() {
    return Object.values(state.filters.multi).reduce((count, values) => count + values.length, 0)
        + (state.filters.status !== 'all' ? 1 : 0)
        + (state.filters.tag !== 'all' ? 1 : 0);
}

function openFilterAccordionForActiveGroups({ includeDefault = false } = {}) {
    let hasOpenGroup = false;

    MULTI_FILTER_CONFIG.forEach((config) => {
        const hasValues = Boolean(state.filters.multi[config.key]?.length);
        if (hasValues) {
            state.filterAccordionOpen[config.key] = true;
            hasOpenGroup = true;
        }
    });

    if (!hasOpenGroup && includeDefault) {
        state.filterAccordionOpen[DEFAULT_MULTI_FILTER_SECTION_KEY] = true;
    }
}

function initializeFilterAccordionState() {
    state.filterAccordionOpen = createDefaultFilterAccordionState();
    openFilterAccordionForActiveGroups({ includeDefault: true });
    state.filterAccordionInitialized = true;
}

function toggleFilterAccordionSection(sectionKey) {
    if (!Object.prototype.hasOwnProperty.call(state.filterAccordionOpen, sectionKey)) {
        return;
    }

    state.filterAccordionOpen[sectionKey] = !state.filterAccordionOpen[sectionKey];
    state.filterAccordionInitialized = true;
}

function focusAdvancedFilterTrigger() {
    requestAnimationFrame(() => {
        document.querySelector('.lead-history-advanced-shell [data-action="open-filters"]')?.focus();
    });
}

function closeAdvancedFiltersPanel({ shouldFocusTrigger = false } = {}) {
    if (!state.filtersPanelOpen) {
        return;
    }

    state.filtersPanelOpen = false;
    renderPanels();

    if (shouldFocusTrigger) {
        focusAdvancedFilterTrigger();
    }
}

function getDefaultScopeForView() {
    return state.currentView === 'members' ? 'members' : 'leads';
}

function getSortIcon(field) {
    if (state.sort.field !== field) {
        return 'fa-sort';
    }

    return state.sort.direction === 'asc' ? 'fa-sort-up' : 'fa-sort-down';
}

function isDrawerOpen() {
    return ['create', 'create-member', 'lookup-preview', 'calendar-event', 'email-compose'].includes(state.drawerMode);
}

function createBlankClient(lifecycleType = 'lead') {
    return {
        id: '',
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        tags: [],
        notes: '',
        status: lifecycleType === 'member' ? 'won' : 'new',
        subscriptionType: '',
        timeZone: 'Unknown',
        timezoneOverridden: false,
        assignedRepId: state.session?.id || '',
        assignedTo: state.session?.name || '',
        lifecycleType,
        disposition: '',
        followUpAction: '',
        followUpAt: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
}

function buildClientMetaLine(client) {
    return [
        client.assignedTo || 'Unassigned',
        client.lifecycleType === 'member' ? 'Member' : 'Lead',
        client.subscriptionType || null,
        client.timeZone || null
    ].filter(Boolean).join(' · ');
}

function buildLeadDetailSummary(lead) {
    return [
        lead.phone || 'No phone',
        lead.email || 'No email',
        lead.assignedTo || 'Unassigned',
        lead.lifecycleType === 'member' ? 'Member' : 'Lead'
    ].join(' · ');
}

function toDateTimeInputValue(value) {
    if (!value) {
        return '';
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const pad = (part) => String(part).padStart(2, '0');

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function addFilterTokens(groupKey, rawValue) {
    const config = MULTI_FILTER_LOOKUP[groupKey];

    if (!config) {
        return false;
    }

    const nextValues = config.parser(rawValue);

    if (!nextValues.length) {
        return false;
    }

    const merged = [...state.filters.multi[groupKey]];
    const existing = new Set(merged.map((value) => value.toLowerCase()));
    let changed = false;

    nextValues.forEach((value) => {
        const key = value.toLowerCase();

        if (!existing.has(key)) {
            merged.push(value);
            existing.add(key);
            changed = true;
        }
    });

    if (!changed) {
        return false;
    }

    state.filters.multi[groupKey] = merged;
    state.activeSavedFilterId = null;
    state.page = 1;
    return true;
}

function setSelectFilterValue(groupKey, rawValue) {
    const config = MULTI_FILTER_LOOKUP[groupKey];

    if (!config?.options) {
        return false;
    }

    const normalizedValue = normalizeWhitespace(rawValue);
    const canonicalValue = config.options.find((option) => option.toLowerCase() === normalizedValue.toLowerCase()) || '';
    const nextValues = canonicalValue ? [canonicalValue] : [];
    const currentValues = state.filters.multi[groupKey];

    if (currentValues.length === nextValues.length && currentValues.every((value, index) => value === nextValues[index])) {
        return false;
    }

    state.filters.multi[groupKey] = nextValues;
    state.activeSavedFilterId = null;
    state.page = 1;
    return true;
}

function removeFilterToken(groupKey, rawValue) {
    const current = state.filters.multi[groupKey];
    const valueKey = String(rawValue ?? '').toLowerCase();
    const next = current.filter((value) => value.toLowerCase() !== valueKey);

    if (next.length === current.length) {
        return;
    }

    state.filters.multi[groupKey] = next;
    state.activeSavedFilterId = null;
    state.page = 1;
}

function clearFilterGroup(groupKey) {
    state.filters.multi[groupKey] = [];
    state.activeSavedFilterId = null;
    state.page = 1;
}

function clearClientFilters() {
    state.filters = normalizeFilterState(createDefaultFilters());
    state.activeSavedFilterId = null;
    state.page = 1;
}

function normalizeFilterState(filters) {
    const input = filters && typeof filters === 'object' ? filters : {};

    return {
        status: normalizeLeadStatusFilter(input.status),
        tag: typeof input.tag === 'string' && input.tag ? input.tag : 'all',
        multi: Object.fromEntries(MULTI_FILTER_CONFIG.map((config) => {
            const rawValues = Array.isArray(input.multi?.[config.key]) ? input.multi[config.key] : [];
            return [config.key, config.parser(rawValues.join('\n'))];
        }))
    };
}

function sanitizeLeadPayloadForSession(payload, existingLead = null) {
    const nextPayload = {
        ...payload
    };

    nextPayload.tags = dedupeAllowedTags(payload.tags);
    nextPayload.assignedRepId = normalizeWhitespace(nextPayload.assignedRepId || '');
    nextPayload.assignedTo = nextPayload.assignedRepId ? (getUserNameById(nextPayload.assignedRepId) || '') : '';
    nextPayload.lifecycleType = nextPayload.lifecycleType || existingLead?.lifecycleType || 'lead';
    nextPayload.status = normalizeLeadStatus(nextPayload.status || existingLead?.status || 'new');
    nextPayload.disposition = normalizeWhitespace(nextPayload.disposition || '');
    if (Object.prototype.hasOwnProperty.call(nextPayload, 'followUpAction')) {
        nextPayload.followUpAction = normalizeWhitespace(nextPayload.followUpAction || '');
    }
    if (Object.prototype.hasOwnProperty.call(nextPayload, 'followUpAt')) {
        nextPayload.followUpAt = normalizeWhitespace(nextPayload.followUpAt || '');
    }
    if (Object.prototype.hasOwnProperty.call(nextPayload, 'timeZone')) {
        nextPayload.timeZone = normalizeWhitespace(nextPayload.timeZone || '');
    }

    if (!nextPayload.assignedRepId) {
        nextPayload.assignedRepId = existingLead?.assignedRepId || state.session.id;
        nextPayload.assignedTo = getUserNameById(nextPayload.assignedRepId) || existingLead?.assignedTo || state.session.name;
    }

    if (!hasPermission(state.session, PERMISSIONS.EDIT_ADMIN_FIELDS)) {
        nextPayload.assignedRepId = existingLead ? (existingLead.assignedRepId || '') : state.session.id;
        nextPayload.assignedTo = existingLead ? (existingLead.assignedTo || '') : state.session.name;
        nextPayload.lifecycleType = existingLead?.lifecycleType || 'lead';
        nextPayload.subscriptionType = existingLead?.subscriptionType || '';

        if (!canEditLeadField(state.session, 'timeZone', existingLead, { workflowOnly: false })) {
            delete nextPayload.timeZone;
        }
    }

    if (nextPayload.disposition.toLowerCase() === 'won') {
        nextPayload.lifecycleType = 'member';
        nextPayload.status = 'won';

        if (!nextPayload.assignedRepId) {
            nextPayload.assignedRepId = state.session.id;
            nextPayload.assignedTo = state.session.name;
        }
    }

    if (isToDispositionValue(nextPayload.disposition)) {
        const seniorRep = getSeniorRepUsers().find((user) => user.id === normalizeWhitespace(payload.toSeniorRepId));

        if (!seniorRep) {
            throw new Error('Choose a senior rep before saving a TO disposition.');
        }

        nextPayload.assignedRepId = seniorRep.id;
        nextPayload.assignedTo = seniorRep.name;
        nextPayload.lifecycleType = 'lead';
    }

    if (nextPayload.lifecycleType === 'member') {
        nextPayload.status = 'won';
    } else if (nextPayload.status === 'won') {
        nextPayload.lifecycleType = 'member';

        if (!nextPayload.assignedRepId) {
            nextPayload.assignedRepId = existingLead?.assignedRepId || state.session.id;
            nextPayload.assignedTo = getUserNameById(nextPayload.assignedRepId) || existingLead?.assignedTo || state.session.name;
        }
    }

    return nextPayload;
}

function getRoleLabel(role) {
    if (role === 'admin') {
        return 'Admin';
    }

    if (role === 'support') {
        return 'Support';
    }

    if (role === 'senior') {
        return 'Senior Rep';
    }

    return 'Sales';
}

function isToDispositionValue(value) {
    return normalizeWhitespace(value).toLowerCase() === 'to';
}

function getAssignableUsers({ includeAdmin = true, includeSupport = false, salesFloorOnly = false, seniorOnly = false, includeInactive = false } = {}) {
    return state.users.filter((user) => {
        if (!includeInactive && user.isActive === false) {
            return false;
        }

        if (seniorOnly) {
            return user.role === 'senior';
        }

        if (salesFloorOnly) {
            return user.role === 'sales' || user.role === 'senior';
        }

        if (!includeAdmin && user.role === 'admin') {
            return false;
        }

        if (!includeSupport && user.role === 'support') {
            return false;
        }

        return true;
    }).sort((left, right) => left.name.localeCompare(right.name));
}

function getSalesUsers() {
    return getAssignableUsers({ includeAdmin: false, salesFloorOnly: true });
}

function getSeniorRepUsers() {
    return getAssignableUsers({ includeAdmin: false, seniorOnly: true });
}

function getUserNameById(userId) {
    return state.users.find((user) => user.id === userId)?.name || '';
}

function getActiveTagDefinitions() {
    return state.tagDefinitions.filter((definition) => definition.isArchived !== true);
}

function getActiveTagLabels() {
    return getActiveTagDefinitions().map((definition) => definition.label);
}

function getActiveDispositionDefinitions() {
    return state.dispositionDefinitions.filter((definition) => definition.isArchived !== true);
}

function getDispositionOptions(currentValue = '') {
    const activeLabels = getActiveDispositionDefinitions().map((definition) => definition.label);
    if (currentValue && !activeLabels.some((label) => label.toLowerCase() === currentValue.toLowerCase())) {
        return [currentValue, ...activeLabels];
    }

    return activeLabels;
}

function normalizeLeadStatus(status) {
    const key = normalizeWhitespace(status).toLowerCase();
    if (key === 'member') {
        return 'won';
    }

    return CRM_STATUS_OPTIONS.includes(key) ? key : 'new';
}

function normalizeLeadStatusFilter(status) {
    if (normalizeWhitespace(status).toLowerCase() === 'all') {
        return 'all';
    }

    return normalizeLeadStatus(status);
}

function canEditCurrentLead(lead) {
    return canEnterLeadEditMode(state.session, lead);
}

function canEditLeadWorkflowField(lead, fieldName) {
    return canEditLeadField(state.session, fieldName, lead, { workflowOnly: true });
}

function canAddNotesToLead(lead) {
    if (!lead) {
        return false;
    }

    if (isAdminSession(state.session)) {
        return true;
    }

    return isSalesWorkspaceSession(state.session) && lead.lifecycleType !== 'member';
}

function getLeadNoteById(lead, noteId) {
    return (lead?.noteHistory || []).find((entry) => entry.id === noteId) || null;
}

function getLeadFormSnapshot(lead) {
    return {
        firstName: lead.firstName || '',
        lastName: lead.lastName || '',
        email: lead.email || '',
        phone: lead.phone || '',
        status: lead.status || 'new',
        disposition: lead.disposition || '',
        subscriptionType: lead.subscriptionType || '',
        timeZone: lead.timezoneOverridden ? (lead.timeZone || '') : '',
        assignedRepId: lead.assignedRepId || '',
        lifecycleType: lead.lifecycleType || 'lead',
        tags: parseTags(lead.tags || []).join(', ')
    };
}

function getLeadFormState(form) {
    const formData = new FormData(form);

    return {
        firstName: normalizeWhitespace(formData.get('firstName')),
        lastName: normalizeWhitespace(formData.get('lastName')),
        email: normalizeWhitespace(formData.get('email')).toLowerCase(),
        phone: normalizeWhitespace(formData.get('phone')),
        status: normalizeLeadStatus(formData.get('status')),
        disposition: normalizeWhitespace(formData.get('disposition')),
        subscriptionType: normalizeWhitespace(formData.get('subscriptionType')),
        timeZone: normalizeWhitespace(formData.get('timeZone')),
        assignedRepId: normalizeWhitespace(formData.get('assignedRepId')),
        lifecycleType: normalizeWhitespace(formData.get('lifecycleType')) || 'lead',
        tags: parseTags(formData.get('tags')).join(', ')
    };
}

function hasUnsavedLeadEditChanges(form, lead) {
    return JSON.stringify(getLeadFormState(form)) !== JSON.stringify(getLeadFormSnapshot(lead));
}

function getLeadHistoryEntries(lead) {
    return [...(lead?.activityLog || [])]
        .sort((left, right) => Date.parse(right.changedAt ?? right.createdAt ?? 0) - Date.parse(left.changedAt ?? left.createdAt ?? 0));
}

function looksLikeCrmUserId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizeWhitespace(value));
}

function resolveHistoryActorName(name, userId) {
    const normalizedName = normalizeWhitespace(name);
    const normalizedUserId = normalizeWhitespace(userId);

    if (normalizedUserId) {
        const matchedUser = state.users.find((user) => user.id === normalizedUserId) || authService.getUserById(normalizedUserId);

        if (matchedUser?.role === 'admin') {
            return 'Admin';
        }

        if (matchedUser?.name) {
            return matchedUser.name;
        }
    }

    if (normalizedName && !looksLikeCrmUserId(normalizedName)) {
        return normalizedName;
    }

    if (normalizedUserId && looksLikeCrmUserId(normalizedUserId)) {
        return 'Admin';
    }

    return normalizedName || normalizedUserId || '';
}

function getLeadHistoryActorLabel(entry) {
    return resolveHistoryActorName(entry?.changedByName, entry?.changedByUserId)
        || resolveHistoryActorName(entry?.createdByName, entry?.createdByUserId)
        || 'System';
}

function getLeadDetailDispositionOptions(lead) {
    const currentValue = normalizeWhitespace(lead?.disposition || '');
    const options = getDispositionOptions(currentValue);
    return currentValue && !options.includes(currentValue) ? [currentValue, ...options] : options;
}

function getAdminMetrics() {
    const leads = getScopedClients('leads', { ignoreSearch: true, ignoreFilters: true });
    const members = getScopedClients('members', { ignoreSearch: true, ignoreFilters: true });
    const calendarEvents = [...(state.calendar.events || [])];
    const reps = getAdminWorkspaceUsers();
    const assignedLeads = leads.filter((lead) => lead.assignedRepId).length;
    const unassignedLeads = leads.length - assignedLeads;
    const leadsByRepMap = leads.reduce((map, lead) => {
        const name = lead.assignedTo || 'Unassigned';
        map.set(name, (map.get(name) ?? 0) + 1);
        return map;
    }, new Map());
    const membersByRepMap = members.reduce((map, member) => {
        const name = member.assignedTo || 'Unassigned';
        map.set(name, (map.get(name) ?? 0) + 1);
        return map;
    }, new Map());
    const leadsByRep = [...leadsByRepMap.entries()].sort((left, right) => right[1] - left[1]);
    const leadsByStatus = aggregateCounts(leads.map((lead) => lead.status || 'new'));
    const activityEntries = state.clients.flatMap((lead) =>
        (lead.activityLog || []).map((entry) => ({
            ...entry,
            leadName: lead.fullName || 'Unnamed lead'
        }))
    ).sort((left, right) => Date.parse(right.createdAt ?? 0) - Date.parse(left.createdAt ?? 0));
    const recentAssignments = activityEntries.filter((entry) => entry.type === 'assignment').slice(0, 5);
    const recentActivity = activityEntries.slice(0, 6);
    const noteEntriesByRep = aggregateCounts(
        state.clients.flatMap((lead) => (lead.noteHistory || []).map((entry) => entry.createdByName || entry.createdByUserId || 'Local user'))
    );
    const leadsTouchedByRep = aggregateCounts(activityEntries.map((entry) => entry.createdByName || entry.createdByUserId || 'Local user'));
    const dispositionChangesByRep = aggregateCounts(
        activityEntries.filter((entry) => entry.type === 'disposition').map((entry) => entry.createdByName || entry.createdByUserId || 'Local user')
    );
    const followUpsByRep = aggregateCounts(
        calendarEvents.map((event) => event.ownerName || getUserNameById(event.ownerUserId) || 'Local user')
    );
    const followUpsDue = calendarEvents.filter((event) =>
        event.status === 'scheduled' && Date.parse(event.startAt || 0) <= Date.now()
    ).length;

    return {
        totalReps: reps.length,
        activeReps: reps.filter((user) => user.isActive !== false).length,
        totalLeads: leads.length,
        totalMembers: members.length,
        assignedLeads,
        unassignedLeads,
        leadsByRep,
        leadsByRepMap,
        membersByRepMap,
        leadsByStatus,
        recentAssignments,
        recentActivity,
        noteEntriesByRep,
        leadsTouchedByRep,
        dispositionChangesByRep,
        followUpsByRep,
        followUpsDue
    };
}

function openModal(modal) {
    state.modal = modal;
    renderModal();
}

function closeModal() {
    state.modal = null;
    state.importFlow = null;
    renderModal();
}

function openDrawer(mode, options = {}) {
    state.drawerMode = mode;
    state.drawerClientId = options.clientId || null;
    state.drawerEventId = options.eventId || null;
    state.drawerDate = options.date || '';
    state.calendar.formDraft = null;
    if (mode === 'calendar-event') {
        syncCalendarClientPickerFromDrawerContext();
    }
    renderDrawer();
    syncShellState();
}

function closeDrawer() {
    window.clearTimeout(calendarClientSuggestionsTimer);
    calendarClientSuggestionsRequestId += 1;
    state.drawerMode = null;
    state.drawerClientId = null;
    state.drawerEventId = null;
    state.drawerDate = '';
    state.emailComposer = createDefaultEmailComposerState();
    state.calendar.clientPicker = createDefaultCalendarClientPickerState();
    state.calendar.formDraft = null;
    syncShellState();
    renderDrawer();
}

async function openSearchPreviewDrawer(clientId) {
    if (!clientId) {
        return;
    }

    try {
        const detailedLead = await dataService.getClientById(clientId);

        if (!detailedLead || !canAccessClient(detailedLead)) {
            flashNotice('That lead is not assigned to your session.', 'error');
            return;
        }

        mergeClientCache([detailedLead]);
        setSearchShellExpanded(false);
        state.drawerMode = 'lookup-preview';
        state.drawerClientId = clientId;
        state.drawerEventId = null;
        state.drawerDate = '';
        renderDrawer();
        syncShellState();
    } catch (error) {
        flashNotice(error.message || 'Unable to load the lead preview.', 'error');
    }
}

function resetAuthenticatedCrmState() {
    workspacePageCache.clear();
    clearVisibleClientsCache();
    window.clearTimeout(emailWorkspaceAutoRefreshTimer);
    emailWorkspaceAutoRefreshTimer = null;
    state.calendar = createDefaultCalendarState();
    state.emailComposer = createDefaultEmailComposerState();
    state.emailWorkspace = createDefaultEmailWorkspaceState();
    state.clients = [];
    state.allowedTags = [];
    state.tagDefinitions = [];
    state.dispositionDefinitions = [];
    state.users = [];
    state.mailboxSenders = [];
    state.mailboxSignatureDrafts = createDefaultMailboxSignatureDraftState();
    Object.assign(state, createDefaultSettingsUiState());
    state.savedFilters = [];
    state.importHistory = [];
    state.workspaceSummary = createEmptyWorkspaceSummary();
    state.clientCacheMode = 'partial';
    state.workspaceLoaded = false;
    state.adminTab = 'team';
    state.adminUserSearch = '';
    state.adminUserFilter = 'all';
    state.workspaceSearch = '';
    state.lookupQuery = '';
    resetToolbarSuggestions({ clearResults: true });
    state.activeSearchSurface = 'desktop';
    state.activeSearchCaret = null;
    state.searchShellExpanded = false;
    state.workspaceResults = {
        leads: createEmptyWorkspaceResult(),
        members: createEmptyWorkspaceResult()
    };
    state.mobileSearchOpen = false;
    state.filtersPanelOpen = false;
    state.filterAccordionOpen = createDefaultFilterAccordionState();
    state.filterAccordionInitialized = false;
    state.selectedLeadIds = [];
    state.bulkAssignRepId = '';
    state.detailClientId = null;
    state.detailEditMode = false;
    state.detailEditSnapshot = null;
    state.editingNoteId = null;
    closeDrawer();
    closeModal();
}

function flashNotice(message, kind = 'success') {
    state.notice = { message, kind };
    render();

    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
        state.notice = null;
        render();
    }, 4200);
}

function findInlineFeedbackContainer(targetOrKey) {
    if (!targetOrKey) {
        return null;
    }

    if (typeof targetOrKey === 'string') {
        const normalizedKey = normalizeWhitespace(targetOrKey);

        if (!normalizedKey) {
            return null;
        }

        return Array.from(document.querySelectorAll('[data-inline-feedback-container]'))
            .find((node) => node.dataset.inlineFeedbackContainer === normalizedKey) || null;
    }

    if (typeof targetOrKey.closest === 'function') {
        return targetOrKey.closest('[data-inline-feedback-container]');
    }

    return null;
}

function showInlineActionFeedback(targetOrKey, message, kind = 'success', { duration = 2800 } = {}) {
    const container = findInlineFeedbackContainer(targetOrKey);
    const normalizedMessage = normalizeWhitespace(message);

    if (!container || !normalizedMessage) {
        return false;
    }

    const feedbackKey = container.dataset.inlineFeedbackContainer || normalizedMessage;
    let feedbackNode = container.querySelector('[data-inline-feedback-message]');

    if (!feedbackNode) {
        feedbackNode = document.createElement('span');
        feedbackNode.dataset.inlineFeedbackMessage = 'true';
        container.appendChild(feedbackNode);
    }

    feedbackNode.className = `crm-inline-feedback crm-inline-feedback-${kind === 'error' ? 'error' : 'success'}`;
    feedbackNode.textContent = normalizedMessage;
    feedbackNode.setAttribute('role', 'status');
    feedbackNode.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');

    clearTimeout(inlineFeedbackTimers.get(feedbackKey));
    inlineFeedbackTimers.set(feedbackKey, setTimeout(() => {
        if (feedbackNode?.isConnected) {
            feedbackNode.remove();
        }

        inlineFeedbackTimers.delete(feedbackKey);
    }, duration));

    return true;
}

function queueInlineActionFeedback(targetOrKey, message, kind = 'success', options = {}) {
    window.requestAnimationFrame(() => {
        if (!showInlineActionFeedback(targetOrKey, message, kind, options)) {
            flashNotice(message, kind);
        }
    });
}

function refreshWorkspaceChrome() {
    renderSidebar();
    renderPanels();
    syncToolbarFilterButton();

    if (isWorkspaceListView(state.currentView)) {
        if (supportsServerWorkspacePaging()) {
            queueWorkspaceRefresh(getDefaultScopeForView());
            return;
        }

        if (shouldUseLocalWorkspaceFiltering() && state.clientCacheMode !== 'full') {
            void refreshWorkspacePage(getDefaultScopeForView());
        }
    }
}

async function refreshWorkspaceAfterMutation() {
    invalidateWorkspacePageCache();
    await refreshData();
}

function buildTimeZoneBackfillSummary(result) {
    const updatedCount = Number(result?.updatedCount) || 0;
    const unchangedCount = Number(result?.unchangedCount) || 0;
    const skippedOverriddenCount = Number(result?.skippedOverriddenCount) || 0;
    const unknownCount = Number(result?.unknownCount) || 0;

    return `Time zone backfill complete: ${updatedCount.toLocaleString()} updated, ${unchangedCount.toLocaleString()} unchanged, ${skippedOverriddenCount.toLocaleString()} manual overrides skipped, ${unknownCount.toLocaleString()} set to Unknown.`;
}

function syncToolbarFilterButton() {
    const button = refs.topbar.querySelector('[data-action="open-filters"]');

    if (!button) {
        return;
    }

    const activeFilterCount = getActiveFilterCount();
    button.innerHTML = `<i class="fa-solid fa-filter"></i> Filters${activeFilterCount ? ` (${activeFilterCount})` : ''}`;
}

document.addEventListener('click', async (event) => {
    if (event.target.matches('.crm-search')) {
        state.activeSearchSurface = getSearchSurfaceFromElement(event.target);
        state.activeSearchCaret = event.target.selectionStart ?? event.target.value.length;
    }

    const signatureTabButton = event.target.closest('[data-signature-tab-button]');
    if (signatureTabButton) {
        const form = signatureTabButton.closest('form');
        const nextTab = signatureTabButton.dataset.signatureTab;

        if (form) {
            setSignatureEditorActiveTab(form, nextTab);

            if (nextTab === 'template') {
                setSignatureEditorMode(form, 'template', { activateTab: false });
            } else if (nextTab === 'html') {
                setSignatureEditorMode(form, 'html_override', { activateTab: false });
            } else {
                updateSignatureEditorPreview(form, {
                    preservePlainText: normalizeSignatureModeValue(form.querySelector('[data-signature-mode-input]')?.value) === 'plain_text'
                });
            }
        }

        return;
    }

    const signatureGroupButton = event.target.closest('[data-signature-group-button]');
    if (signatureGroupButton) {
        setSignatureEditorActiveSubpanel(signatureGroupButton.closest('form'), signatureGroupButton.dataset.signatureGroup);
        return;
    }

    const signaturePreviewToggle = event.target.closest('[data-signature-preview-toggle]');
    if (signaturePreviewToggle) {
        const form = signaturePreviewToggle.closest('form');
        const templateShell = form?.querySelector('[data-signature-template-shell]');
        const isCurrentlyVisible = templateShell ? !templateShell.classList.contains('is-preview-hidden-mobile') : state.showSignaturePreview;
        setSignaturePreviewVisibility(form, !isCurrentlyVisible);
        return;
    }

    const setPlainTextButton = event.target.closest('[data-signature-set-mode]');
    if (setPlainTextButton) {
        const form = setPlainTextButton.closest('form');

        if (form) {
            setSignatureEditorMode(form, setPlainTextButton.dataset.signatureSetMode);
        }

        return;
    }

    const clearSignatureAssetButton = event.target.closest('[data-signature-clear-asset]');
    if (clearSignatureAssetButton) {
        clearSignatureAsset(clearSignatureAssetButton.closest('form'), clearSignatureAssetButton.dataset.signatureClearAsset);
        return;
    }

    const actionEl = event.target.closest('[data-action]');
    const clickedInsideAdvancedFilters = event.target.closest('.lead-history-advanced-shell');
    const clickedInsideDesktopNav = event.target.closest('.crm-primary-nav');

    if (!actionEl) {
        if (state.filtersPanelOpen && !clickedInsideAdvancedFilters) {
            closeAdvancedFiltersPanel();
            return;
        }

        let shouldRefreshTopbar = false;

        if (state.desktopNavOpen && !clickedInsideDesktopNav) {
            state.desktopNavOpen = false;
            shouldRefreshTopbar = true;
        }

        if (shouldShowSearchSuggestions() && !event.target.closest('.search-shell')) {
            resetToolbarSuggestions();
            shouldRefreshTopbar = true;
        }

        if (shouldRefreshTopbar) {
            renderTopbar();
        }
        return;
    }

    const { action } = actionEl.dataset;

    if (state.desktopNavOpen && action !== 'toggle-desktop-nav' && !clickedInsideDesktopNav) {
        state.desktopNavOpen = false;
    }

    if (state.searchSuggestionsOpen && action !== 'select-search-suggestion' && !actionEl.closest('.search-shell')) {
        resetToolbarSuggestions();
        renderTopbar();
    }

    if (state.filtersPanelOpen && action !== 'open-filters' && !actionEl.closest('.lead-history-advanced-shell')) {
        state.filtersPanelOpen = false;
    }

    if (action === 'quick-login') {
        try {
            state.session = await authService.quickLogin(actionEl.dataset.userId);
            flashNotice(`Logged in as ${state.session.name}.`, 'success');
            await refreshData();
        } catch (error) {
            flashNotice(error.message, 'error');
        }
        return;
    }

    if (action === 'logout') {
        try {
            await authService.logout();
        } catch (error) {
            flashNotice(error.message || 'Unable to sign out of the CRM.', 'error');
            return;
        }
        return;
    }

    if (action === 'return-main-site') {
        window.location.href = '../';
        return;
    }

    if (action === 'dismiss-notice') {
        state.notice = null;
        render();
        return;
    }

    if (action === 'toggle-auth-password') {
        const input = document.getElementById('crm-login-password');
        const icon = actionEl.querySelector('i');

        if (!input || !icon) {
            return;
        }

        const showPassword = input.type === 'password';
        input.type = showPassword ? 'text' : 'password';
        icon.classList.toggle('fa-eye', !showPassword);
        icon.classList.toggle('fa-eye-slash', showPassword);
        actionEl.setAttribute('aria-label', showPassword ? 'Hide password' : 'Show password');
        actionEl.setAttribute('aria-pressed', showPassword ? 'true' : 'false');
        return;
    }

    if (action === 'toggle-sidebar') {
        const nextIsOpen = !state.sidebarOpen;
        state.desktopNavOpen = false;
        state.mobileSearchOpen = false;
        resetToolbarSuggestions();
        setSidebarOpen(nextIsOpen);
        renderTopbar();
        return;
    }

    if (action === 'toggle-desktop-nav') {
        if (state.searchSuggestionsOpen) {
            resetToolbarSuggestions();
        }
        state.desktopNavOpen = !state.desktopNavOpen;
        renderTopbar();
        return;
    }

    if (action === 'toggle-mobile-search') {
        if (state.sidebarOpen) {
            setSidebarOpen(false);
        }

        state.desktopNavOpen = false;

        if (shouldShowMobileSearch() && !hasActiveToolbarSearch()) {
            state.mobileSearchOpen = false;
            setSearchShellExpanded(false);
            renderTopbar();
            return;
        }

        state.mobileSearchOpen = true;
        renderTopbar();
        focusToolbarSearchInput('mobile');
        return;
    }

    if (action === 'select-search-suggestion') {
        state.desktopNavOpen = false;
        resetToolbarSuggestions();
        renderTopbar();
        await openSearchPreviewDrawer(actionEl.dataset.clientId);
        return;
    }

    if (action === 'open-search-result-detail') {
        const previewLead = getAccessibleClientById(actionEl.dataset.clientId);
        await openLeadDetailPage(
            actionEl.dataset.clientId,
            previewLead?.lifecycleType === 'member'
                ? 'members'
                : (isAssignedLeadsView() ? 'assigned-leads' : 'clients')
        );
        return;
    }

    if (action === 'select-settings-section') {
        state.selectedSettingsSection = getValidSettingsSection(actionEl.dataset.settingsSection);
        renderPanels();
        return;
    }

    if (action === 'toggle-mailbox-editor') {
        const mailboxKind = normalizeMailboxKind(actionEl.dataset.mailboxKind);
        state.expandedMailboxEditorKind = state.expandedMailboxEditorKind === mailboxKind ? '' : mailboxKind;

        if (state.expandedMailboxEditorKind) {
            state.selectedSettingsSection = mailboxKind === 'support' ? 'support_mailbox' : 'personal_mailbox';
        }

        renderPanels();
        return;
    }

    if (action === 'set-view' || action === 'jump-to-view') {
        const targetView = actionEl.dataset.view;

        if (targetView === 'admin' && !hasActiveAdminProfile()) {
            flashNotice('Admin access is required for that section.', 'error');
            return;
        }

        if (targetView === 'assigned-leads' && !hasPermission(state.session, PERMISSIONS.ASSIGN_LEADS)) {
            flashNotice('Only admin users can open assigned leads.', 'error');
            return;
        }

        if (targetView === 'imports' && !hasPermission(state.session, PERMISSIONS.IMPORT_LEADS)) {
            flashNotice('Only admin users can import leads.', 'error');
            return;
        }

        if (targetView === 'email' && !hasPermission(state.session, PERMISSIONS.SEND_EMAIL)) {
            flashNotice('Email access is not enabled for this CRM session.', 'error');
            return;
        }

        if (targetView === 'settings') {
            state.selectedSettingsSection = getValidSettingsSection(actionEl.dataset.settingsSection || state.selectedSettingsSection);

            if (actionEl.dataset.mailboxKind) {
                state.expandedMailboxEditorKind = normalizeMailboxKind(actionEl.dataset.mailboxKind);
            }
        }

        if (action === 'jump-to-view' && state.drawerMode) {
            closeDrawer();
        }

        if (targetView === 'admin' && actionEl.dataset.adminTab) {
            state.adminTab = getValidAdminTab(actionEl.dataset.adminTab);
        }

        state.desktopNavOpen = false;
        state.currentView = targetView === 'imports' ? 'admin' : targetView;
        if (targetView === 'imports') {
            state.adminTab = 'imports';
        }
        state.mobileSearchOpen = false;
        resetToolbarSuggestions();
        setSidebarOpen(false);
        state.detailEditMode = false;
        state.detailEditSnapshot = null;
        state.editingNoteId = null;
        if (state.modal) {
            closeModal();
        }
        if (isWorkspaceListView(targetView)) {
            state.lastWorkspaceView = targetView;
            await refreshWorkspacePage(targetView === 'members' ? 'members' : 'leads');
            return;
        }
        if (targetView === 'admin') {
            await loadFullClientDataset();
            await refreshCalendarEvents({ force: true, renderWhileLoading: false });
            render();
            return;
        }
        if (targetView === 'calendar') {
            await refreshCalendarEvents({ anchorDate: getMonthCursorDate(), force: true, renderWhileLoading: false });
            render();
            return;
        }
        if (targetView === 'email') {
            await ensureEmailWorkspaceLoaded({ renderWhileLoading: false, preserveThread: true });
            render();
            return;
        }
        if (targetView === 'imports') {
            await loadFullClientDataset();
            render();
            return;
        }
        render();
        return;
    }

    if (action === 'new-client') {
        openDrawer('create');
        return;
    }

    if (action === 'new-member') {
        openDrawer('create-member');
        return;
    }

    if (action === 'open-calendar-event-drawer') {
        openDrawer('calendar-event', {
            clientId: actionEl.dataset.clientId || '',
            eventId: actionEl.dataset.eventId || '',
            date: actionEl.dataset.date || ''
        });
        return;
    }

    if (action === 'select-calendar-client-suggestion') {
        const suggestion = state.calendar.clientPicker.suggestions.find((entry) => entry.id === actionEl.dataset.clientId);

        if (!suggestion) {
            return;
        }

        preserveCalendarEventDraft();
        applyCalendarClientSuggestionSelection(suggestion);
        renderDrawer();
        focusCalendarClientSearchInput();
        return;
    }

    if (action === 'set-calendar-filter') {
        const nextFilter = actionEl.dataset.filter || 'mine';
        if (nextFilter === 'all' && !hasActiveAdminProfile()) {
            state.calendar.filter = 'mine';
        } else {
            state.calendar.filter = nextFilter;
        }
        renderPanels();
        return;
    }

    if (action === 'select-calendar-date') {
        const nextDate = parseDateKey(actionEl.dataset.date || state.calendar.selectedDate);
        state.calendar.selectedDate = getDateKey(nextDate);
        state.calendar.monthCursor = getMonthCursorValue(nextDate);
        await ensureCalendarEventsForDate(nextDate);
        renderPanels();
        return;
    }

    if (action === 'set-calendar-view') {
        state.calendar.view = actionEl.dataset.view === 'month' ? 'month' : 'week';
        await ensureCalendarEventsForDate(getCalendarSelectedDate());
        renderPanels();
        return;
    }

    if (action === 'calendar-prev-period') {
        const currentDate = getCalendarSelectedDate();
        const previousDate = state.calendar.view === 'month'
            ? new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1, 12)
            : new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() - 7, 12);
        state.calendar.selectedDate = getDateKey(previousDate);
        state.calendar.monthCursor = getMonthCursorValue(previousDate);
        await ensureCalendarEventsForDate(previousDate);
        renderPanels();
        return;
    }

    if (action === 'calendar-next-period') {
        const currentDate = getCalendarSelectedDate();
        const nextDate = state.calendar.view === 'month'
            ? new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1, 12)
            : new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() + 7, 12);
        state.calendar.selectedDate = getDateKey(nextDate);
        state.calendar.monthCursor = getMonthCursorValue(nextDate);
        await ensureCalendarEventsForDate(nextDate);
        renderPanels();
        return;
    }

    if (action === 'calendar-prev-mini-month') {
        const previousMonth = new Date(getMonthCursorDate().getFullYear(), getMonthCursorDate().getMonth() - 1, 1, 12);
        state.calendar.monthCursor = getMonthCursorValue(previousMonth);
        if (state.calendar.view === 'month') {
            state.calendar.selectedDate = getDateKey(previousMonth);
        }
        await ensureCalendarEventsForDate(previousMonth);
        renderPanels();
        return;
    }

    if (action === 'calendar-next-mini-month') {
        const nextMonth = new Date(getMonthCursorDate().getFullYear(), getMonthCursorDate().getMonth() + 1, 1, 12);
        state.calendar.monthCursor = getMonthCursorValue(nextMonth);
        if (state.calendar.view === 'month') {
            state.calendar.selectedDate = getDateKey(nextMonth);
        }
        await ensureCalendarEventsForDate(nextMonth);
        renderPanels();
        return;
    }

    if (action === 'calendar-prev-month') {
        const previousMonth = new Date(getMonthCursorDate().getFullYear(), getMonthCursorDate().getMonth() - 1, 1, 12);
        state.calendar.monthCursor = getMonthCursorValue(previousMonth);
        state.calendar.selectedDate = getDateKey(previousMonth);
        await refreshCalendarEvents({ anchorDate: previousMonth, force: true, renderWhileLoading: false });
        renderPanels();
        return;
    }

    if (action === 'calendar-next-month') {
        const nextMonth = new Date(getMonthCursorDate().getFullYear(), getMonthCursorDate().getMonth() + 1, 1, 12);
        state.calendar.monthCursor = getMonthCursorValue(nextMonth);
        state.calendar.selectedDate = getDateKey(nextMonth);
        await refreshCalendarEvents({ anchorDate: nextMonth, force: true, renderWhileLoading: false });
        renderPanels();
        return;
    }

    if (action === 'calendar-today') {
        const today = new Date();
        state.calendar.monthCursor = getMonthCursorValue(today);
        state.calendar.selectedDate = getDateKey(today);
        await ensureCalendarEventsForDate(today);
        renderPanels();
        return;
    }

    if (action === 'set-calendar-event-status') {
        try {
            const eventRecord = getCalendarEventById(actionEl.dataset.eventId);

            if (!eventRecord || !canManageCalendarEvent(eventRecord)) {
                throw new Error('Only the event owner or an admin can update follow-up statuses.');
            }

            await dataService.updateCalendarEventStatus(actionEl.dataset.eventId, actionEl.dataset.status);
            await refreshWorkspaceAfterMutation();
            flashNotice('Follow-up status updated.', 'success');
        } catch (error) {
            flashNotice(error.message || 'Unable to update the follow-up status.', 'error');
        }
        return;
    }

    if (action === 'set-admin-tab') {
        state.adminTab = getValidAdminTab(actionEl.dataset.adminTab);
        renderPanels();
        return;
    }

    if (action === 'set-admin-user-filter') {
        state.adminUserFilter = actionEl.dataset.filterValue || 'all';
        renderPanels();
        return;
    }

    if (action === 'open-filters') {
        if (!isWorkspaceListView(state.currentView)) {
            state.currentView = state.lastWorkspaceView || 'clients';
        }

        state.filtersPanelOpen = !state.filtersPanelOpen;
        if (state.filtersPanelOpen && !state.filterAccordionInitialized) {
            initializeFilterAccordionState();
        }
        render();
        return;
    }

    if (action === 'toggle-filter-section') {
        toggleFilterAccordionSection(actionEl.dataset.section);
        renderPanels();
        return;
    }

    if (action === 'clear-active-saved-filter') {
        state.activeSavedFilterId = null;
        state.filterAccordionOpen.savedViews = true;
        renderPanels();
        return;
    }

    if (action === 'set-status-filter') {
        state.filters.status = actionEl.dataset.status || 'all';
        state.activeSavedFilterId = null;
        state.page = 1;
        refreshWorkspaceChrome();
        return;
    }

    if (action === 'load-saved-filter') {
        const filter = state.savedFilters.find((item) => item.id === actionEl.dataset.filterId);

        if (!filter) {
            flashNotice('That saved filter is not available in this session.', 'error');
            return;
        }

        applySavedFilter(filter);
        if (!isWorkspaceListView(state.currentView) && state.currentView !== 'lead-detail') {
            state.currentView = state.lastWorkspaceView || 'clients';
        }
        flashNotice(`Loaded saved filter "${filter.name}".`, 'success');
        renderTopbar();
        await refreshWorkspacePage((state.currentView === 'members' || state.lastWorkspaceView === 'members') ? 'members' : 'leads');
        return;
    }

    if (action === 'edit-saved-filter') {
        state.activeSavedFilterId = actionEl.dataset.filterId;
        state.filtersPanelOpen = true;
        state.filterAccordionOpen.savedViews = true;
        state.filterAccordionInitialized = true;
        renderPanels();
        return;
    }

    if (action === 'delete-saved-filter') {
        try {
            await savedFilterService.deleteFilter(state.session, actionEl.dataset.filterId);
            if (state.activeSavedFilterId === actionEl.dataset.filterId) {
                state.activeSavedFilterId = null;
            }
            state.savedFilters = await savedFilterService.listVisible(state.session);
            flashNotice('Saved filter deleted.', 'success');
            refreshWorkspaceChrome();
        } catch (error) {
            flashNotice(error.message, 'error');
        }
        return;
    }

    if (action === 'toggle-select-lead') {
        toggleLeadSelection(actionEl.dataset.clientId);
        renderPanels();
        return;
    }

    if (action === 'toggle-select-page') {
        togglePageLeadSelection();
        renderPanels();
        return;
    }

    if (action === 'select-visible-leads') {
        selectVisibleLeads();
        renderPanels();
        return;
    }

    if (action === 'clear-lead-selection') {
        state.selectedLeadIds = [];
        renderPanels();
        return;
    }

    if (action === 'bulk-assign-selected') {
        if (!hasPermission(state.session, PERMISSIONS.ASSIGN_LEADS)) {
            flashNotice('Only admin users can bulk assign leads.', 'error');
            return;
        }

        await handleBulkAssign(state.bulkAssignRepId);
        return;
    }

    if (action === 'bulk-unassign-selected') {
        if (!hasPermission(state.session, PERMISSIONS.ASSIGN_LEADS)) {
            flashNotice('Only admin users can bulk assign leads.', 'error');
            return;
        }

        await handleBulkAssign('');
        return;
    }

    if (action === 'open-lead-page') {
        await openLeadDetailPage(
            actionEl.dataset.clientId,
            state.currentView === 'members'
                ? 'members'
                : (isAssignedLeadsView() ? 'assigned-leads' : 'clients')
        );
        return;
    }

    if (action === 'toggle-lead-edit') {
        const lead = getAccessibleClientById(state.detailClientId);

        if (!lead || !canEnterLeadEditMode(state.session, lead)) {
            flashNotice('This record cannot be edited in the current session.', 'error');
            return;
        }

        state.detailEditMode = true;
        state.detailEditSnapshot = getLeadFormSnapshot(lead);
        state.editingNoteId = null;
        renderPanels();
        return;
    }

    if (action === 'cancel-lead-edit') {
        const lead = getAccessibleClientById(state.detailClientId);
        const form = document.getElementById('lead-detail-form');

        if (lead && form && hasUnsavedLeadEditChanges(form, lead) && !window.confirm('Discard unsaved lead changes?')) {
            return;
        }

        state.detailEditMode = false;
        state.detailEditSnapshot = null;
        renderPanels();
        return;
    }

    if (action === 'toggle-lead-history') {
        const isLeadHistoryOpen = state.modal?.type === 'lead-history' && state.modal?.clientId === state.detailClientId;

        if (isLeadHistoryOpen) {
            closeModal();
            return;
        }

        openModal({ type: 'lead-history', clientId: state.detailClientId });
        return;
    }

    if (action === 'open-email-composer') {
        if (!hasPermission(state.session, PERMISSIONS.SEND_EMAIL)) {
            flashNotice('This session cannot send CRM email.', 'error');
            return;
        }

        const lead = getAccessibleClientById(actionEl.dataset.clientId);
        const recipientEmail = normalizeWhitespace(actionEl.dataset.recipientEmail);
        const recipientName = normalizeWhitespace(actionEl.dataset.recipientName || lead?.fullName || '');

        if (actionEl.dataset.clientId && !lead && !normalizeEmailAddress(recipientEmail)) {
            flashNotice('This record is not available for CRM email.', 'error');
            return;
        }

        await openEmailComposerDrawer({
            clientId: lead?.id || '',
            recipientEmail: recipientEmail || lead?.email || '',
            recipientName
        });
        return;
    }

    if (action === 'copy-phone-number') {
        try {
            const phoneValue = normalizeWhitespace(actionEl.dataset.phone);
            const copyResult = await copyTextToClipboard(phoneValue, { promptLabel: 'Copy this phone number:' });
            flashNotice(copyResult === 'prompt' ? 'Phone number ready to copy.' : 'Phone number copied.', 'success');
        } catch (error) {
            flashNotice(error.message || 'Unable to copy that phone number.', 'error');
        }
        return;
    }

    if (action === 'use-system-default-call') {
        try {
            const phoneValue = normalizeWhitespace(actionEl.dataset.phone);
            const copyResult = await copyTextToClipboard(phoneValue, { promptLabel: 'Copy this phone number for your system phone app:' });
            flashNotice(
                copyResult === 'prompt'
                    ? 'Open your system phone app and place the call using the number shown.'
                    : 'Phone number copied. Open your system phone app to place this call.',
                'success'
            );
        } catch (error) {
            flashNotice(error.message || 'Unable to prepare that system-default call.', 'error');
        }
        return;
    }
    if (action === 'sync-email-mailbox') {
        await syncActiveEmailMailbox();
        return;
    }

    if (action === 'select-email-folder') {
        state.emailWorkspace.selectedFolder = normalizeWhitespace(actionEl.dataset.folder).toUpperCase() || 'INBOX';
        state.emailWorkspace.previewMode = 'thread';
        await loadEmailThreads({ renderWhileLoading: true, preserveThread: false });
        return;
    }

    if (action === 'open-email-thread') {
        state.emailWorkspace.selectedThreadId = normalizeWhitespace(actionEl.dataset.threadId);
        state.emailWorkspace.previewMode = 'thread';
        await loadSelectedEmailThread({ renderWhileLoading: true, markRead: true });
        return;
    }

    if (action === 'toggle-email-thread-star') {
        const threadId = normalizeWhitespace(actionEl.dataset.threadId);
        const mailboxId = normalizeWhitespace(state.emailWorkspace.selectedMailboxId);
        const currentThread = state.emailWorkspace.threads.find((thread) => thread.id === threadId);

        if (!threadId || !mailboxId || !currentThread) {
            return;
        }

        try {
            await dataService.toggleEmailThreadStar({
                threadId,
                mailboxId,
                isStarred: !currentThread.isStarred
            });

            state.emailWorkspace.threads = state.emailWorkspace.threads.map((thread) =>
                thread.id === threadId
                    ? { ...thread, isStarred: !thread.isStarred }
                    : thread
            );

            if (state.emailWorkspace.selectedThread?.id === threadId) {
                state.emailWorkspace.selectedThread = {
                    ...state.emailWorkspace.selectedThread,
                    isStarred: !state.emailWorkspace.selectedThread.isStarred
                };
            }

            renderPanels();
        } catch (error) {
            flashNotice(error.message || 'Unable to update the thread star.', 'error');
        }
        return;
    }

    if (action === 'reply-email-thread') {
        openReplyComposer(state.emailWorkspace.selectedThread, { includeAll: false });
        return;
    }

    if (action === 'reply-all-email-thread') {
        openReplyComposer(state.emailWorkspace.selectedThread, { includeAll: true });
        return;
    }

    if (action === 'close-email-compose') {
        state.emailWorkspace.previewMode = 'thread';
        renderPanels();
        return;
    }

    if (action === 'edit-note-entry') {
        const lead = getAccessibleClientById(state.detailClientId);
        const note = getLeadNoteById(lead, actionEl.dataset.noteId);

        if (!lead || !note || !canEditNoteEntry(state.session, lead, note)) {
            flashNotice('You can only edit notes you own unless you are admin.', 'error');
            return;
        }

        state.editingNoteId = note.id;
        renderPanels();
        return;
    }

    if (action === 'cancel-note-edit') {
        state.editingNoteId = null;
        renderPanels();
        return;
    }

    if (action === 'remove-tag-token') {
        removeTagFromPicker(actionEl);
        return;
    }

    if (action === 'select-tag-suggestion') {
        addTagFromSuggestion(actionEl);
        return;
    }

    if (action === 'back-to-list') {
        state.currentView = state.lastWorkspaceView || 'clients';
        state.detailClientId = null;
        state.detailEditMode = false;
        state.detailEditSnapshot = null;
        state.editingNoteId = null;
        if (state.modal) {
            closeModal();
        }
        render();
        return;
    }

    if (action === 'navigate-lead') {
        await navigateLeadDetail(actionEl.dataset.direction);
        return;
    }

    if (action === 'close-drawer') {
        closeDrawer();
        return;
    }

    if (action === 'open-delete-confirm') {
        if (!hasPermission(state.session, PERMISSIONS.DELETE_ANY_LEAD)) {
            flashNotice('Only admin users can delete leads.', 'error');
            return;
        }
        openModal({ type: 'confirm-delete', clientId: actionEl.dataset.clientId });
        return;
    }

    if (action === 'confirm-delete') {
        if (!hasPermission(state.session, PERMISSIONS.DELETE_ANY_LEAD)) {
            flashNotice('Only admin users can delete leads.', 'error');
            return;
        }
        await dataService.deleteClient(actionEl.dataset.clientId);
        closeModal();
        closeDrawer();
        state.currentView = state.lastWorkspaceView || 'clients';
        state.detailClientId = null;
        flashNotice('Lead deleted from the CRM.', 'success');
        await refreshWorkspaceAfterMutation();
        return;
    }

    if (action === 'open-clear-confirm') {
        if (!hasPermission(state.session, PERMISSIONS.MANAGE_SETTINGS)) {
            flashNotice('Only admin users can clear CRM data.', 'error');
            return;
        }
        openModal({ type: 'confirm-clear' });
        return;
    }

    if (action === 'close-modal') {
        closeModal();
        return;
    }

    if (action === 'open-duplicate-existing') {
        const duplicateLead = state.modal?.duplicateLead;

        if (!duplicateLead) {
            closeModal();
            return;
        }

        closeModal();
        closeDrawer();
        await openLeadDetailPage(duplicateLead.id, duplicateLead.lifecycleType === 'member' ? 'members' : 'clients');
        return;
    }

    if (action === 'show-duplicate-merge') {
        if (state.modal?.duplicateLead && state.modal?.incomingPayload) {
            state.modal = {
                type: 'duplicate-merge',
                duplicateLead: state.modal.duplicateLead,
                incomingPayload: state.modal.incomingPayload
            };
            renderModal();
        }
        return;
    }

    if (action === 'open-import') {
        if (!hasPermission(state.session, PERMISSIONS.IMPORT_LEADS)) {
            flashNotice('Only admin users can import leads.', 'error');
            return;
        }
        state.importFlow = { step: 'select' };
        openModal({ type: 'import' });
        return;
    }

    if (action === 'reset-import') {
        state.importFlow = { step: 'select' };
        renderModal();
        return;
    }

    if (action === 'confirm-import') {
        await handleImportConfirm();
        return;
    }

    if (action === 'prev-page') {
        state.page = Math.max(1, state.page - 1);
        await refreshWorkspacePage(getDefaultScopeForView());
        return;
    }

    if (action === 'next-page') {
        const totalPages = Math.max(1, Math.ceil(getWorkspaceDisplayCount(getDefaultScopeForView()) / state.pageSize));
        state.page = Math.min(totalPages, state.page + 1);
        await refreshWorkspacePage(getDefaultScopeForView());
        return;
    }

    if (action === 'sort-table') {
        const field = actionEl.dataset.field;

        if (state.sort.field === field) {
            state.sort.direction = state.sort.direction === 'asc' ? 'desc' : 'asc';
        } else {
            state.sort.field = field;
            state.sort.direction = field === 'updatedAt' ? 'desc' : 'asc';
        }

        state.activeSavedFilterId = null;
        await refreshWorkspacePage(getDefaultScopeForView());
        return;
    }

    if (action === 'remove-filter-token') {
        removeFilterToken(actionEl.dataset.group, actionEl.dataset.value);
        refreshWorkspaceChrome();
        focusFilterInput(actionEl.dataset.group);
        return;
    }

    if (action === 'clear-filter-group') {
        clearFilterGroup(actionEl.dataset.group);
        refreshWorkspaceChrome();
        focusFilterInput(actionEl.dataset.group);
        return;
    }

    if (action === 'clear-client-filters') {
        clearClientFilters();
        refreshWorkspaceChrome();
        return;
    }

    if (action === 'export-clients') {
        if (!hasPermission(state.session, PERMISSIONS.EXPORT_LEADS)) {
            flashNotice('Only admin users can export leads.', 'error');
            return;
        }

        if (state.clientCacheMode !== 'full') {
            await loadFullClientDataset();
            if (state.clientCacheMode !== 'full') {
                return;
            }
        }

        const visibleClients = getVisibleClients(getDefaultScopeForView());
        const clientsToExport = visibleClients.length ? visibleClients : state.clients;
        const csv = dataService.exportClientsToCsv(clientsToExport);
        downloadTextFile(`bluechip-crm-leads-export-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
        flashNotice(`Exported ${clientsToExport.length.toLocaleString()} leads to CSV.`, 'success');
        return;
    }

    if (action === 'restore-sample-data') {
        if (!hasPermission(state.session, PERMISSIONS.MANAGE_SETTINGS)) {
            flashNotice('Only admin users can restore workspace starter records.', 'error');
            return;
        }
        await dataService.restoreSampleData();
        flashNotice('Workspace starter records were restored when no records were present.', 'success');
        await refreshWorkspaceAfterMutation();
        return;
    }

    if (action === 'backfill-time-zones') {
        if (!hasPermission(state.session, PERMISSIONS.MANAGE_SETTINGS)) {
            flashNotice('Only admin users can backfill lead time zones.', 'error');
            return;
        }

        const result = await dataService.backfillLeadTimeZones();
        flashNotice(buildTimeZoneBackfillSummary(result), 'success');
        await refreshWorkspaceAfterMutation();
        return;
    }

    if (action === 'toggle-member-state') {
        if (!hasPermission(state.session, PERMISSIONS.MOVE_TO_MEMBERS)) {
            flashNotice('Only admin users can move leads into Members.', 'error');
            return;
        }

        const lead = state.clients.find((client) => client.id === actionEl.dataset.clientId);

        if (!lead) {
            return;
        }

        await saveLeadPayload({
            ...lead,
            lifecycleType: lead.lifecycleType === 'member' ? 'lead' : 'member',
            status: lead.lifecycleType === 'member'
                ? (lead.status === 'won' ? 'contacted' : lead.status)
                : 'won'
        });
        flashNotice(lead.lifecycleType === 'member' ? 'Lead moved back into Leads.' : 'Lead moved into Members.', 'success');
        return;
    }

    if (action === 'open-user-form') {
        if (!hasPermission(state.session, PERMISSIONS.MANAGE_USERS)) {
            flashNotice('Only admin users can manage sales rep accounts.', 'error');
            return;
        }

        if (!actionEl.dataset.userId) {
            flashNotice('Create the user account first, then edit their CRM profile here.', 'error');
            return;
        }

        openModal({ type: 'user-form', userId: actionEl.dataset.userId || '' });
        return;
    }

    if (action === 'delete-user-account') {
        if (!hasPermission(state.session, PERMISSIONS.MANAGE_USERS)) {
            flashNotice('Only admin users can manage sales rep accounts.', 'error');
            return;
        }

        const user = authService.getUserById(actionEl.dataset.userId);

        if (!user) {
            return;
        }

        if (!window.confirm(`Delete ${user.name}'s CRM profile? This removes the profile and reassigns their leads to you.`)) {
            return;
        }

        if (user.isActive !== false) {
            await dataService.reassignClientsFromUser(user.id, state.session.id, state.session.name);
        }

        await authService.deleteUser(user.id);
        flashNotice(`${user.name}'s CRM profile was deleted.`, 'success');
        await refreshWorkspaceAfterMutation();
        if (state.modal?.type === 'user-form') {
            closeModal();
        }
        return;
    }

    if (action === 'edit-tag-definition') {
        if (!hasActiveAdminProfile()) {
            flashNotice('Only active admin users can manage tags.', 'error');
            return;
        }

        state.adminTab = 'tags';
        state.editingTagDefinitionId = actionEl.dataset.definitionId;
        renderPanels();
        return;
    }

    if (action === 'clear-tag-definition-edit') {
        state.adminTab = 'tags';
        state.editingTagDefinitionId = null;
        renderPanels();
        return;
    }

    if (action === 'toggle-tag-archive') {
        if (!hasActiveAdminProfile()) {
            flashNotice('Only active admin users can manage tags.', 'error');
            return;
        }

        const definition = state.tagDefinitions.find((item) => item.id === actionEl.dataset.definitionId);

        if (!definition) {
            return;
        }

        await dataService.saveTagDefinition({
            ...definition,
            isArchived: definition.isArchived !== true
        });
        state.editingTagDefinitionId = null;
        flashNotice(`Tag ${definition.isArchived ? 'restored' : 'archived'}.`, 'success');
        await refreshWorkspaceAfterMutation();
        return;
    }

    if (action === 'delete-tag-definition') {
        if (!hasActiveAdminProfile()) {
            flashNotice('Only active admin users can manage tags.', 'error');
            return;
        }

        const definition = state.tagDefinitions.find((item) => item.id === actionEl.dataset.definitionId);

        if (!definition) {
            return;
        }

        const replacementInput = window.prompt(
            `Delete "${definition.label}". Enter replacement tags separated by commas, or leave blank to remove it from affected leads.`
        );

        if (replacementInput === null) {
            return;
        }

        const validReplacementLabels = parseTags(replacementInput).filter((label) =>
            state.tagDefinitions.some((definitionItem) =>
                definitionItem.id !== definition.id
                && definitionItem.label.toLowerCase() === label.toLowerCase()
            )
        );

        if (normalizeWhitespace(replacementInput) && !validReplacementLabels.length) {
            flashNotice('Choose replacement tags from the current admin-managed catalog.', 'error');
            return;
        }

        await dataService.deleteTagDefinition(definition.id, {
            replacementLabels: validReplacementLabels,
            actor: state.session
        });
        state.editingTagDefinitionId = null;
        flashNotice(`Tag "${definition.label}" deleted.`, 'success');
        await refreshWorkspaceAfterMutation();
        return;
    }

    if (action === 'edit-disposition-definition') {
        if (!hasActiveAdminProfile()) {
            flashNotice('Only active admin users can manage dispositions.', 'error');
            return;
        }

        state.adminTab = 'dispositions';
        state.editingDispositionDefinitionId = actionEl.dataset.definitionId;
        renderPanels();
        return;
    }

    if (action === 'clear-disposition-definition-edit') {
        state.adminTab = 'dispositions';
        state.editingDispositionDefinitionId = null;
        renderPanels();
        return;
    }

    if (action === 'toggle-disposition-archive') {
        if (!hasActiveAdminProfile()) {
            flashNotice('Only active admin users can manage dispositions.', 'error');
            return;
        }

        const definition = state.dispositionDefinitions.find((item) => item.id === actionEl.dataset.definitionId);

        if (!definition) {
            return;
        }

        await dataService.saveDispositionDefinition({
            ...definition,
            isArchived: definition.isArchived !== true
        });
        state.editingDispositionDefinitionId = null;
        flashNotice(`Disposition ${definition.isArchived ? 'restored' : 'archived'}.`, 'success');
        await refreshWorkspaceAfterMutation();
        return;
    }

    if (action === 'delete-disposition-definition') {
        if (!hasActiveAdminProfile()) {
            flashNotice('Only active admin users can manage dispositions.', 'error');
            return;
        }

        const definition = state.dispositionDefinitions.find((item) => item.id === actionEl.dataset.definitionId);

        if (!definition) {
            return;
        }

        await dataService.deleteDispositionDefinition(definition.id);
        state.editingDispositionDefinitionId = null;
        flashNotice(`Disposition "${definition.label}" deleted.`, 'success');
        await refreshWorkspaceAfterMutation();
    }
});

document.addEventListener('change', (event) => {
    if (event.target?.id === 'crm-login-remember') {
        state.authRemember = event.target.checked;
    }
});

document.addEventListener('submit', async (event) => {
    const formElement = event.target;
    const formId = typeof event.target?.getAttribute === 'function'
        ? event.target.getAttribute('id')
        : event.target?.id;

    if (formId === 'login-form') {
        event.preventDefault();
        const formData = new FormData(event.target);
        state.authRemember = formData.get('remember') === 'on';
        state.authSubmitting = true;
        state.authResolved = true;
        render();

        try {
            state.session = await authService.login({
                email: formData.get('email'),
                password: formData.get('password'),
                remember: state.authRemember
            });
            state.authUser = authService.getAuthUser();
            state.profile = authService.getProfile();
            flashNotice(`Logged in as ${state.session.name}.`, 'success');
            await refreshData();
        } catch (error) {
            flashNotice(
                getPublicAuthMessage(error.message, 'Unable to sign in right now. Please try again.'),
                'error'
            );
        } finally {
            state.authSubmitting = false;
            render();
        }
        return;
    }

    if (formId === 'client-form') {
        event.preventDefault();
        try {
            const formData = new FormData(event.target);
            const savedClient = await handleCreateLeadSubmit(Object.fromEntries(formData.entries()));

            if (!savedClient) {
                return;
            }

            flashNotice(`${savedClient.fullName || 'Lead'} saved.`, 'success');
            closeDrawer();
        } catch (error) {
            flashNotice(error.message || 'Unable to save the lead.', 'error');
        }
        return;
    }

    if (formId === 'call-preference-form') {
        event.preventDefault();

        try {
            const formData = new FormData(formElement);
            await dataService.saveCallPreference(formData.get('callPreference'));
            await refreshData();
            queueInlineActionFeedback(formId, 'Saved.');
        } catch (error) {
            if (!showInlineActionFeedback(formId, error.message || 'Unable to save your calling preference.', 'error')) {
                flashNotice(error.message || 'Unable to save your calling preference.', 'error');
            }
        }
        return;
    }

    if (formId === 'personal-mailbox-form') {
        event.preventDefault();

        try {
            const formData = new FormData(formElement);
            const signatureDraft = collectSignatureDraftFromForm(formElement);
            await dataService.savePersonalMailboxConnection({
                senderName: formData.get('senderName'),
                signatureMode: signatureDraft.signatureMode,
                signatureTemplate: signatureDraft.signatureTemplate,
                signatureHtmlOverride: signatureDraft.signatureHtmlOverride,
                signatureText: signatureDraft.signatureText,
                smtpUsername: formData.get('smtpUsername'),
                smtpPassword: formData.get('smtpPassword')
            });
            setMailboxSignatureDraft('personal', null);
            await refreshData();
            queueInlineActionFeedback(formId, 'Mailbox updated.');
        } catch (error) {
            if (!showInlineActionFeedback(formId, error.message || 'Unable to save your mailbox connection.', 'error')) {
                flashNotice(error.message || 'Unable to save your mailbox connection.', 'error');
            }
        }
        return;
    }

    if (formId === 'support-mailbox-form') {
        event.preventDefault();

        try {
            const formData = new FormData(formElement);
            const signatureDraft = collectSignatureDraftFromForm(formElement);
            await dataService.saveSupportMailboxConnection({
                senderEmail: formData.get('senderEmail'),
                senderName: formData.get('senderName'),
                signatureMode: signatureDraft.signatureMode,
                signatureTemplate: signatureDraft.signatureTemplate,
                signatureHtmlOverride: signatureDraft.signatureHtmlOverride,
                signatureText: signatureDraft.signatureText,
                smtpUsername: formData.get('smtpUsername'),
                smtpPassword: formData.get('smtpPassword')
            });
            setMailboxSignatureDraft('support', null);
            await refreshData();
            queueInlineActionFeedback(formId, 'Support mailbox updated.');
        } catch (error) {
            if (!showInlineActionFeedback(formId, error.message || 'Unable to save the support mailbox.', 'error')) {
                flashNotice(error.message || 'Unable to save the support mailbox.', 'error');
            }
        }
        return;
    }

    if (formId === 'email-compose-form') {
        event.preventDefault();

        try {
            const formData = new FormData(event.target);
            const message = await dataService.sendEmail({
                leadId: formData.get('leadId'),
                recipientEmail: formData.get('recipientEmail'),
                threadId: formData.get('threadId'),
                inReplyTo: formData.get('inReplyTo'),
                references: formData.get('references'),
                senderMode: formData.get('senderMode'),
                subject: formData.get('subject'),
                bodyText: formData.get('bodyText')
            });
            state.emailWorkspace.previewMode = 'thread';
            state.emailComposer = createDefaultEmailComposerState();
            await ensureEmailWorkspaceLoaded({ force: true, renderWhileLoading: false, preserveThread: true });

            if (normalizeWhitespace(message.threadId)) {
                state.emailWorkspace.selectedThreadId = normalizeWhitespace(message.threadId);
                await loadSelectedEmailThread({ renderWhileLoading: false, markRead: false });
            }

            if (message.loggedToLead && message.leadId) {
                const refreshedLead = await dataService.getClientById(message.leadId).catch(() => null);
                if (refreshedLead) {
                    mergeClientCache([refreshedLead]);
                }
                flashNotice(
                    message.warning
                        ? `Email sent and logged to this lead. ${message.warning}`
                        : 'Email sent and logged to this lead.',
                    message.warning ? 'error' : 'success'
                );
            } else if (normalizeWhitespace(formData.get('leadId'))) {
                flashNotice(
                    message.warning
                        ? `Email sent. Because the recipient changed, it was not logged to the lead. ${message.warning}`
                        : 'Email sent. Because the recipient changed, it was not logged to the lead.',
                    message.warning ? 'error' : 'success'
                );
            } else {
                flashNotice(message.warning ? `Email sent. ${message.warning}` : 'Email sent.', message.warning ? 'error' : 'success');
            }

            renderPanels();
        } catch (error) {
            flashNotice(error.message || 'Unable to send the email.', 'error');
        }
        return;
    }

    if (formId === 'lead-detail-form') {
        event.preventDefault();
        try {
            const formData = new FormData(event.target);
            const payload = Object.fromEntries(formData.entries());
            payload.assignedTo = getUserNameById(payload.assignedRepId) || '';
            const savedLead = await saveLeadPayload(payload);
            state.detailEditMode = false;
            state.detailEditSnapshot = null;
            flashNotice(
                isToDispositionValue(payload.disposition) && savedLead.assignedRepId !== state.session.id
                    ? `Lead handed off to ${savedLead.assignedTo || 'the selected senior rep'} with disposition TO.`
                    : 'Lead updated.',
                'success'
            );
        } catch (error) {
            flashNotice(error.message || 'Unable to update the lead.', 'error');
        }
        return;
    }

    if (formId === 'calendar-event-form') {
        event.preventDefault();

        try {
            const formData = new FormData(event.target);
            const eventId = normalizeWhitespace(formData.get('eventId'));
            const payload = {
                leadId: normalizeWhitespace(formData.get('leadId')),
                title: normalizeWhitespace(formData.get('title')),
                actionText: normalizeWhitespace(formData.get('actionText')),
                notes: String(formData.get('notes') ?? ''),
                startAt: normalizeWhitespace(formData.get('startAt')),
                endAt: normalizeWhitespace(formData.get('endAt')),
                eventTimeZone: normalizeWhitespace(formData.get('eventTimeZone')),
                visibility: normalizeWhitespace(formData.get('visibility')) || 'private',
                sharedWithUserIds: formData.getAll('sharedWithUserIds').map((value) => normalizeWhitespace(value))
            };

            if (eventId) {
                const existingEvent = getCalendarEventById(eventId);

                if (!existingEvent || !canManageCalendarEvent(existingEvent)) {
                    throw new Error('Only the event owner or an admin can edit this follow-up.');
                }

                await dataService.updateCalendarEvent(eventId, payload);
            } else {
                await dataService.createCalendarEvent(payload);
            }

            closeDrawer();
            await refreshWorkspaceAfterMutation();
            flashNotice(eventId ? 'Follow-up updated.' : 'Follow-up scheduled.', 'success');
        } catch (error) {
            flashNotice(error.message || 'Unable to save the follow-up.', 'error');
        }
        return;
    }

    if (formId === 'lead-note-form') {
        event.preventDefault();

        try {
            const lead = getAccessibleClientById(state.detailClientId);

            if (!lead || !canAddNotesToLead(lead)) {
                throw new Error('This session cannot save note entries.');
            }

            const formData = new FormData(event.target);
            const noteId = String(formData.get('noteId') ?? '').trim();

            if (noteId) {
                const note = getLeadNoteById(lead, noteId);

                if (!note || !canEditNoteEntry(state.session, lead, note)) {
                    throw new Error('You can only edit your own notes unless you are admin.');
                }

                await dataService.updateClientNote({
                    clientId: formData.get('leadId'),
                    noteId,
                    content: formData.get('noteEntry'),
                    actor: state.session
                });
            } else {
                await dataService.appendClientNote({
                    clientId: formData.get('leadId'),
                    content: formData.get('noteEntry'),
                    actor: state.session
                });
            }
            await refreshWorkspaceAfterMutation();
            state.currentView = 'lead-detail';
            state.editingNoteId = null;
            flashNotice(noteId ? 'Note updated with version history.' : 'Note saved to lead history.', 'success');
        } catch (error) {
            flashNotice(error.message || 'Unable to save the note entry.', 'error');
        }
        return;
    }

    if (formId === 'saved-filter-form') {
        event.preventDefault();

        try {
            const formData = new FormData(event.target);
            const isEditing = Boolean(String(formData.get('id') ?? '').trim());
            const savedFilter = await savedFilterService.saveFilter(state.session, {
                id: formData.get('id'),
                name: formData.get('name'),
                visibility: formData.get('visibility'),
                filterPayload: createSavedFilterPayload()
            });
            state.savedFilters = await savedFilterService.listVisible(state.session);
            state.activeSavedFilterId = savedFilter.id;
            flashNotice(`Saved filter "${savedFilter.name}" ${isEditing ? 'updated' : 'created'}.`, 'success');
            refreshWorkspaceChrome();
        } catch (error) {
            flashNotice(error.message, 'error');
        }
        return;
    }

    if (formId === 'duplicate-merge-form') {
        event.preventDefault();

        try {
            const duplicateLead = state.modal?.duplicateLead;
            const incomingPayload = state.modal?.incomingPayload;

            if (!duplicateLead || !incomingPayload) {
                throw new Error('The duplicate merge data is no longer available.');
            }

            const formData = new FormData(event.target);
            const { payload, resolvedNotes } = buildResolvedMergePayload(duplicateLead, incomingPayload, formData);
            const savedLead = await saveLeadPayload({
                ...incomingPayload,
                ...payload,
                id: duplicateLead.id,
                tags: payload.tags,
                notes: duplicateLead.notes
            });

            if (normalizeWhitespace(resolvedNotes) && normalizeWhitespace(resolvedNotes) !== normalizeWhitespace(duplicateLead.notes)) {
                await dataService.appendClientNote({
                    clientId: savedLead.id,
                    content: resolvedNotes,
                    actor: state.session
                });
                await refreshWorkspaceAfterMutation();
            }

            closeModal();
            closeDrawer();
            flashNotice(`Merged into ${savedLead.fullName || 'the existing lead'}.`, 'success');
        } catch (error) {
            flashNotice(error.message || 'Unable to merge the duplicate lead.', 'error');
        }
        return;
    }

    if (formId === 'user-form') {
        event.preventDefault();

        try {
            if (!hasPermission(state.session, PERMISSIONS.MANAGE_USERS)) {
                throw new Error('Only admin users can manage sales rep accounts.');
            }

            const formData = new FormData(event.target);
            await authService.saveUser({
                id: formData.get('id'),
                name: formData.get('name'),
                email: formData.get('email'),
                role: formData.get('role'),
                isActive: formData.get('isActive') === 'true'
            });
            flashNotice('CRM account saved.', 'success');
            closeModal();
            await refreshWorkspaceAfterMutation();
        } catch (error) {
            flashNotice(error.message, 'error');
        }
        return;
    }

    if (formId === 'tag-definition-form') {
        event.preventDefault();

        if (!hasActiveAdminProfile()) {
            flashNotice('Only active admin users can manage the master tag list.', 'error');
            return;
        }

        const formData = new FormData(event.target);
        await dataService.saveTagDefinition({
            id: formData.get('id'),
            label: formData.get('label'),
            isArchived: formData.get('isArchived') === 'true'
        });
        state.editingTagDefinitionId = null;
        flashNotice('Tag catalog updated.', 'success');
        await refreshWorkspaceAfterMutation();
        return;
    }

    if (formId === 'disposition-definition-form') {
        event.preventDefault();

        if (!hasActiveAdminProfile()) {
            flashNotice('Only active admin users can manage dispositions.', 'error');
            return;
        }

        const formData = new FormData(event.target);
        await dataService.saveDispositionDefinition({
            id: formData.get('id'),
            label: formData.get('label'),
            isArchived: formData.get('isArchived') === 'true'
        });
        state.editingDispositionDefinitionId = null;
        flashNotice('Disposition catalog updated.', 'success');
        await refreshWorkspaceAfterMutation();
        return;
    }

    if (formId === 'clear-data-form') {
        event.preventDefault();
        const formData = new FormData(event.target);

        if (!hasPermission(state.session, PERMISSIONS.MANAGE_SETTINGS)) {
            flashNotice('Only admin users can clear CRM data.', 'error');
            return;
        }

        if (String(formData.get('confirmation') ?? '').trim() !== 'CLEAR') {
            flashNotice('Type CLEAR to confirm the destructive action.', 'error');
            return;
        }

        await dataService.clearAllData();
        closeModal();
        closeDrawer();
        flashNotice('CRM data cleared from the workspace.', 'success');
        await refreshWorkspaceAfterMutation();
    }
});

document.addEventListener('change', (event) => {
    if (event.target.matches('#lead-detail-form select[name="disposition"]')) {
        syncToSeniorRepFieldState(event.target.closest('form'));
    }
});

document.addEventListener('input', (event) => {
    if (event.target.closest?.('.crm-signature-editor')) {
        const form = event.target.closest('form');
        const isPlainTextEdit = event.target.matches('[data-signature-plain-textarea]')
            && normalizeSignatureModeValue(form?.querySelector('[data-signature-mode-input]')?.value) === 'plain_text';

        if (form && event.target.closest('[data-signature-panel="template"]')) {
            const currentMode = normalizeSignatureModeValue(form.querySelector('[data-signature-mode-input]')?.value);

            if (currentMode !== 'template') {
                form.querySelector('[data-signature-mode-input]').value = 'template';
            }
        }

        if (form && event.target.closest('[data-signature-panel="html"]') && event.target.name === 'signatureHtmlOverride') {
            form.querySelector('[data-signature-mode-input]').value = 'html_override';
        }

        updateSignatureEditorPreview(form, { preservePlainText: isPlainTextEdit });
        return;
    }

    if (event.target.closest?.('#email-compose-form')) {
        syncEmailComposerDraft(event.target.closest('form'));
        return;
    }

    if (event.target.id === 'crm-email-search') {
        state.emailWorkspace.searchQuery = event.target.value;
        void loadEmailThreads({ renderWhileLoading: true, preserveThread: false });
        return;
    }

    if (event.target.matches('.tag-picker-input')) {
        refreshTagSuggestions(event.target);
        return;
    }

    if (event.target.id === 'admin-user-search') {
        const caretPosition = event.target.selectionStart ?? event.target.value.length;
        state.adminUserSearch = event.target.value;
        renderPanels();
        requestAnimationFrame(() => {
            const input = document.getElementById('admin-user-search');
            input?.focus();
            restoreInputCaret(input, caretPosition);
        });
        return;
    }

    if (
        event.target.matches('#lead-detail-form input[name="phone"]')
        || event.target.matches('#client-form input[name="phone"]')
    ) {
        const form = event.target.closest('form');
        const timeZoneSelect = form?.querySelector('select[name="timeZone"]');

        if (timeZoneSelect) {
            timeZoneSelect.value = '';
        }
        return;
    }

    if (event.target.matches('.calendar-client-search-input')) {
        const caretPosition = event.target.selectionStart ?? event.target.value.length;
        const nextValue = event.target.value;
        const normalizedValue = normalizeWhitespace(nextValue);
        const selectedLeadMatchesQuery = normalizeWhitespace(state.calendar.clientPicker.selectedLeadName).toLowerCase() === normalizedValue.toLowerCase();

        preserveCalendarEventDraft();
        state.calendar.clientPicker.query = nextValue;
        state.calendar.clientPicker.isOpen = Boolean(normalizedValue);
        state.calendar.clientPicker.isLoading = Boolean(normalizedValue);
        state.calendar.clientPicker.activeIndex = 0;

        if (!selectedLeadMatchesQuery) {
            state.calendar.clientPicker.selectedLeadId = '';
            state.calendar.clientPicker.selectedLeadName = '';
            state.calendar.clientPicker.selectedLeadMeta = '';
        }

        if (!normalizedValue) {
            state.calendar.clientPicker.suggestions = [];
            state.calendar.clientPicker.isOpen = false;
            state.calendar.clientPicker.isLoading = false;
            state.calendar.clientPicker.activeIndex = -1;
            state.calendar.clientPicker.lastQuery = '';
            renderDrawer();
            focusCalendarClientSearchInput(caretPosition);
            return;
        }

        renderDrawer();
        focusCalendarClientSearchInput(caretPosition);
        queueCalendarClientSuggestions({ caret: caretPosition });
        return;
    }

    if (event.target.matches('.crm-search')) {
        const searchSurface = getSearchSurfaceFromElement(event.target);
        const caretPosition = event.target.selectionStart ?? event.target.value.length;
        const nextValue = event.target.value;
        const inWorkspaceSearchView = isWorkspaceSearchView();

        state.activeSearchSurface = searchSurface;
        state.activeSearchCaret = caretPosition;

        if (event.target.hasAttribute('data-mobile-search-input')) {
            state.mobileSearchOpen = true;
        }
        setSearchShellExpanded(true);

        if (inWorkspaceSearchView) {
            state.workspaceSearch = nextValue;
            state.lookupQuery = nextValue;
            state.activeSavedFilterId = null;
            state.page = 1;
        } else {
            state.lookupQuery = nextValue;
        }

        if (normalizeWhitespace(nextValue)) {
            state.searchSuggestionsOpen = true;
            state.searchSuggestionsLoading = true;
            state.searchSuggestionsQuery = normalizeWhitespace(nextValue);
        } else {
            resetToolbarSuggestions({ clearResults: true });
        }

        const syncedSearchUi = syncToolbarSearchUi({
            activeSurface: searchSurface,
            caretPosition
        });

        if (!syncedSearchUi) {
            renderTopbar();
        }

        if (inWorkspaceSearchView) {
            renderSidebar();
            renderPanels();
            queueWorkspaceRefresh(getDefaultScopeForView());
        }

        if (!syncedSearchUi) {
            focusToolbarSearchInput(searchSurface, caretPosition);
        }

        if (normalizeWhitespace(nextValue)) {
            queueToolbarSuggestions({ surface: searchSurface });
        }
    }
});

window.addEventListener('resize', () => {
    if (!state.session) {
        return;
    }

    let shouldRefreshChrome = false;

    if (isMobileNavViewport()) {
        if (state.desktopNavOpen) {
            state.desktopNavOpen = false;
            shouldRefreshChrome = true;
        }

        if (shouldRefreshChrome) {
            renderTopbar();
        }
        return;
    }

    if (state.sidebarOpen) {
        setSidebarOpen(false);
        shouldRefreshChrome = true;
    }

    if (state.mobileSearchOpen) {
        state.mobileSearchOpen = false;
        shouldRefreshChrome = true;
    }

    if (state.desktopNavOpen) {
        state.desktopNavOpen = false;
        shouldRefreshChrome = true;
    }

    if (state.searchSuggestionsOpen) {
        resetToolbarSuggestions();
        shouldRefreshChrome = true;
    }

    if (shouldRefreshChrome) {
        renderTopbar();
        renderSidebar();
    }
});

document.addEventListener('paste', (event) => {
    if (!event.target.matches('.filter-token-input')) {
        return;
    }

    const pastedText = event.clipboardData?.getData('text') ?? '';

    if (!normalizeWhitespace(pastedText)) {
        return;
    }

    event.preventDefault();
    commitFilterInput(event.target, pastedText);
});

document.addEventListener('change', async (event) => {
    if (event.target.matches('[data-signature-upload]')) {
        try {
            await handleSignatureAssetUpload(event.target);
        } catch (error) {
            const mailboxKind = normalizeWhitespace(event.target.dataset.mailboxKind).toLowerCase() === 'support' ? 'support' : 'personal';
            const assetKind = normalizeWhitespace(event.target.dataset.signatureUpload).toLowerCase() === 'banner' ? 'banner' : 'headshot';

            if (!showInlineActionFeedback(
                getSignatureAssetFeedbackKey(mailboxKind, assetKind),
                error.message || 'Unable to upload that signature image.',
                'error',
                { duration: 3600 }
            )) {
                flashNotice(error.message || 'Unable to upload that signature image.', 'error');
            }
        }
        return;
    }

    if (event.target.matches('select[data-settings-section-select]')) {
        state.selectedSettingsSection = getValidSettingsSection(event.target.value);
        renderPanels();
        return;
    }

    if (event.target.closest?.('#email-compose-form')) {
        syncEmailComposerDraft(event.target.closest('form'));
        return;
    }

    if (event.target.matches('select[data-action="select-email-mailbox"]')) {
        state.emailWorkspace.selectedMailboxId = normalizeWhitespace(event.target.value);
        state.emailWorkspace.previewMode = 'thread';
        await loadEmailThreads({ renderWhileLoading: true, preserveThread: false });
        return;
    }

    if (event.target.id === 'bulk-assignee') {
        state.bulkAssignRepId = event.target.value;
        renderPanels();
        return;
    }

    if (event.target.matches('[data-filter-select-group]')) {
        if (setSelectFilterValue(event.target.dataset.filterSelectGroup, event.target.value)) {
            refreshWorkspaceChrome();
        }
        return;
    }

    if (event.target.id === 'status-filter') {
        state.filters.status = event.target.value;
        state.activeSavedFilterId = null;
        state.page = 1;
        refreshWorkspaceChrome();
        return;
    }

    if (event.target.id === 'tag-filter') {
        state.filters.tag = event.target.value;
        state.activeSavedFilterId = null;
        state.page = 1;
        refreshWorkspaceChrome();
        return;
    }

    if (event.target.id === 'page-size') {
        state.pageSize = Number(event.target.value);
        state.activeSavedFilterId = null;
        state.page = 1;
        await refreshWorkspacePage(getDefaultScopeForView());
        return;
    }

    if (event.target.id === 'import-file-input') {
        const [file] = event.target.files ?? [];

        if (file) {
            await handleImportFile(file);
        }
        return;
    }

    if (event.target.closest('#import-mapping-form')) {
        await syncImportPreviewFromForm();
    }
});

document.addEventListener('keydown', (event) => {
    if (event.target.matches('.calendar-client-search-input')) {
        const picker = state.calendar.clientPicker;

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const visibleQuery = normalizeWhitespace(picker.query);

            if (!visibleQuery) {
                return;
            }

            event.preventDefault();

            if (!picker.isOpen) {
                preserveCalendarEventDraft();
                state.calendar.clientPicker.isOpen = true;
                renderDrawer();
                focusCalendarClientSearchInput();
                queueCalendarClientSuggestions({ immediate: true });
                return;
            }

            if (!picker.suggestions.length) {
                return;
            }

            const direction = event.key === 'ArrowDown' ? 1 : -1;
            const nextIndex = picker.activeIndex < 0
                ? 0
                : (picker.activeIndex + direction + picker.suggestions.length) % picker.suggestions.length;
            state.calendar.clientPicker.activeIndex = nextIndex;
            preserveCalendarEventDraft();
            renderDrawer();
            focusCalendarClientSearchInput();
            return;
        }

        if (event.key === 'Enter' && picker.isOpen && picker.activeIndex >= 0) {
            const suggestion = picker.suggestions[picker.activeIndex];

            if (!suggestion) {
                return;
            }

            event.preventDefault();
            preserveCalendarEventDraft();
            applyCalendarClientSuggestionSelection(suggestion);
            renderDrawer();
            focusCalendarClientSearchInput();
            return;
        }

        if (event.key === 'Escape' && picker.isOpen) {
            event.preventDefault();
            preserveCalendarEventDraft();
            state.calendar.clientPicker.isOpen = false;
            state.calendar.clientPicker.isLoading = false;
            state.calendar.clientPicker.activeIndex = -1;
            renderDrawer();
            focusCalendarClientSearchInput();
            return;
        }
    }

    if (event.target.matches('.crm-search')) {
        const searchSurface = getSearchSurfaceFromElement(event.target);
        state.activeSearchSurface = searchSurface;
        state.activeSearchCaret = event.target.selectionStart ?? event.target.value.length;

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const visibleQuery = normalizeWhitespace(getToolbarSearchValue());

            if (!visibleQuery) {
                return;
            }

            event.preventDefault();

            if (!shouldShowSearchSuggestions()) {
                state.searchSuggestionsOpen = true;
                const syncedSearchUi = syncToolbarSearchUi({
                    activeSurface: searchSurface,
                    caretPosition: state.activeSearchCaret
                });

                if (!syncedSearchUi) {
                    renderTopbar();
                    focusToolbarSearchInput(searchSurface, state.activeSearchCaret);
                }

                if (!state.searchSuggestions.length && !state.searchSuggestionsLoading) {
                    state.searchSuggestionsLoading = true;
                    const syncedLoadingUi = syncToolbarSearchUi({
                        activeSurface: searchSurface,
                        caretPosition: state.activeSearchCaret
                    });

                    if (!syncedLoadingUi) {
                        renderTopbar();
                        focusToolbarSearchInput(searchSurface, state.activeSearchCaret);
                    }
                    queueToolbarSuggestions({ immediate: true, surface: searchSurface });
                }
                return;
            }

            if (!state.searchSuggestions.length) {
                return;
            }

            const direction = event.key === 'ArrowDown' ? 1 : -1;
            const nextIndex = state.activeSuggestionIndex < 0
                ? 0
                : (state.activeSuggestionIndex + direction + state.searchSuggestions.length) % state.searchSuggestions.length;

            state.activeSuggestionIndex = nextIndex;
            const syncedSearchUi = syncToolbarSearchUi({
                activeSurface: searchSurface,
                caretPosition: state.activeSearchCaret
            });

            if (!syncedSearchUi) {
                renderTopbar();
                focusToolbarSearchInput(searchSurface, state.activeSearchCaret);
            }
            return;
        }

        if (event.key === 'Enter' && shouldShowSearchSuggestions() && state.activeSuggestionIndex >= 0) {
            const suggestion = state.searchSuggestions[state.activeSuggestionIndex];

            if (!suggestion) {
                return;
            }

            event.preventDefault();
            resetToolbarSuggestions();
            renderTopbar();
            openSearchPreviewDrawer(suggestion.id);
            return;
        }

        if (event.key === 'Escape' && shouldShowSearchSuggestions()) {
            event.preventDefault();
            resetToolbarSuggestions();
            const syncedSearchUi = syncToolbarSearchUi({
                activeSurface: searchSurface,
                caretPosition: state.activeSearchCaret
            });

            if (!syncedSearchUi) {
                renderTopbar();
                focusToolbarSearchInput(searchSurface, state.activeSearchCaret);
            }
            return;
        }
    }

    if (event.target.matches('.tag-picker-input')) {
        if (event.key === 'Enter' || event.key === ',' || event.key === 'Tab') {
            event.preventDefault();
            commitTagInput(event.target);
            return;
        }

        if (event.key === 'Backspace' && !normalizeWhitespace(event.target.value)) {
            removeLastTagFromPicker(event.target);
        }

        return;
    }

    if (event.target.matches('.filter-token-input')) {
        if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            commitFilterInput(event.target);
            return;
        }

        if (event.key !== 'Escape') {
            return;
        }
    }

    if (event.key !== 'Escape') {
        return;
    }

    if (state.desktopNavOpen) {
        state.desktopNavOpen = false;
        renderTopbar();
        return;
    }

    if (state.modal) {
        closeModal();
        return;
    }

    if (state.filtersPanelOpen) {
        closeAdvancedFiltersPanel({ shouldFocusTrigger: true });
        return;
    }

    if (isDrawerOpen()) {
        closeDrawer();
    }
});

document.addEventListener('focusout', (event) => {
    if (event.target.matches('.calendar-client-search-input')) {
        window.setTimeout(() => {
            if (!document.activeElement?.closest('.calendar-client-search-shell')) {
                preserveCalendarEventDraft();
                state.calendar.clientPicker.isOpen = false;
                state.calendar.clientPicker.isLoading = false;
                state.calendar.clientPicker.activeIndex = -1;
                renderDrawer();
            }
        }, 120);
        return;
    }

    if (event.target.matches('.crm-search')) {
        window.setTimeout(() => {
            if (!document.activeElement?.closest('.search-shell')) {
                const searchSurface = getSearchSurfaceFromElement(event.target);
                resetToolbarSuggestions();
                setSearchShellExpanded(false);
                if (!syncToolbarSearchUi({
                    activeSurface: searchSurface,
                    caretPosition: state.activeSearchCaret
                })) {
                    renderTopbar();
                }
            }
        }, 120);
        return;
    }

    if (event.target.matches('.tag-picker-input')) {
        window.setTimeout(() => {
            const picker = event.target.closest('[data-tag-picker]');
            picker?.querySelector('.tag-suggestion-list')?.classList.add('hidden');
        }, 120);
        return;
    }

    if (!event.target.matches('.filter-token-input')) {
        return;
    }

    commitFilterInput(event.target, event.target.value, false);
});

refs.modalLayer.addEventListener('click', (event) => {
    if (event.target === refs.modalLayer) {
        closeModal();
    }
});

document.addEventListener('focusin', (event) => {
    if (event.target.matches('.calendar-client-search-input')) {
        if (calendarClientFocusRestorePending) {
            calendarClientFocusRestorePending = false;
            return;
        }

        const visibleQuery = normalizeWhitespace(state.calendar.clientPicker.query);

        if (!visibleQuery) {
            return;
        }

        preserveCalendarEventDraft();
        state.calendar.clientPicker.isOpen = true;

        if (state.calendar.clientPicker.lastQuery === visibleQuery && (state.calendar.clientPicker.suggestions.length || !state.calendar.clientPicker.isLoading)) {
            renderDrawer();
            focusCalendarClientSearchInput(event.target.selectionStart ?? event.target.value.length);
            return;
        }

        state.calendar.clientPicker.isLoading = true;
        renderDrawer();
        focusCalendarClientSearchInput(event.target.selectionStart ?? event.target.value.length);
        queueCalendarClientSuggestions({ immediate: true, caret: event.target.selectionStart ?? event.target.value.length });
        return;
    }

    if (event.target.matches('.crm-search')) {
        const searchSurface = getSearchSurfaceFromElement(event.target);
        const visibleQuery = normalizeWhitespace(getToolbarSearchValue());

        state.activeSearchSurface = searchSurface;
        state.activeSearchCaret = event.target.selectionStart ?? event.target.value.length;
        if (!state.searchShellExpanded) {
            setSearchShellExpanded(true);
            const syncedSearchUi = syncToolbarSearchUi({
                activeSurface: searchSurface,
                caretPosition: state.activeSearchCaret
            });

            if (!syncedSearchUi) {
                renderTopbar();
                focusToolbarSearchInput(searchSurface, state.activeSearchCaret);
            }
            return;
        }

        if (!visibleQuery) {
            return;
        }

        if (state.searchSuggestionsOpen && state.searchSuggestionsQuery === visibleQuery) {
            return;
        }

        state.searchSuggestionsOpen = true;

        if (state.searchSuggestionsQuery === visibleQuery && (state.searchSuggestions.length || !state.searchSuggestionsLoading)) {
            const syncedSearchUi = syncToolbarSearchUi({
                activeSurface: searchSurface,
                caretPosition: state.activeSearchCaret
            });

            if (!syncedSearchUi) {
                renderTopbar();
                focusToolbarSearchInput(searchSurface, state.activeSearchCaret);
            }
            return;
        }

        state.searchSuggestionsLoading = true;
        state.searchSuggestionsQuery = visibleQuery;
        const syncedSearchUi = syncToolbarSearchUi({
            activeSurface: searchSurface,
            caretPosition: state.activeSearchCaret
        });

        if (!syncedSearchUi) {
            renderTopbar();
            focusToolbarSearchInput(searchSurface, state.activeSearchCaret);
        }
        queueToolbarSuggestions({ immediate: true, surface: searchSurface });
        return;
    }

    if (event.target.matches('.tag-picker-input')) {
        refreshTagSuggestions(event.target);
    }
});

function commitFilterInput(input, overrideValue = input.value, shouldRefocus = true) {
    const groupKey = input.dataset.filterGroup;

    if (!addFilterTokens(groupKey, overrideValue)) {
        if (shouldRefocus) {
            focusFilterInput(groupKey);
        }
        return;
    }

    input.value = '';
    refreshWorkspaceChrome();

    if (shouldRefocus) {
        focusFilterInput(groupKey);
    }
}

function focusFilterInput(groupKey) {
    requestAnimationFrame(() => {
        const nextInput = document.querySelector(`.filter-token-input[data-filter-group="${groupKey}"]`);
        nextInput?.focus();
    });
}

function toggleLeadSelection(clientId) {
    if (!clientId) {
        return;
    }

    const client = getAccessibleClientById(clientId);

    if (client && normalizeWhitespace(client.assignedRepId)) {
        return;
    }

    const selectedIds = new Set(state.selectedLeadIds);

    if (selectedIds.has(clientId)) {
        selectedIds.delete(clientId);
    } else {
        selectedIds.add(clientId);
    }

    state.selectedLeadIds = [...selectedIds];
}

function getAssignableLeadPageRows() {
    return getUnassignedLeadRows(getWorkspacePageRows('leads'));
}

function togglePageLeadSelection() {
    const currentPageIds = getAssignableLeadPageRows().map((client) => client.id);
    const selectedIds = new Set(state.selectedLeadIds);
    const shouldSelectAll = currentPageIds.some((clientId) => !selectedIds.has(clientId));

    currentPageIds.forEach((clientId) => {
        if (shouldSelectAll) {
            selectedIds.add(clientId);
        } else {
            selectedIds.delete(clientId);
        }
    });

    state.selectedLeadIds = [...selectedIds];
}

function selectVisibleLeads() {
    state.selectedLeadIds = getAssignableLeadPageRows().map((client) => client.id);
}

async function handleBulkAssign(assignedRepId) {
    if (!state.selectedLeadIds.length) {
        flashNotice('Select one or more leads first.', 'error');
        return;
    }

    const assignedTo = assignedRepId ? getUserNameById(assignedRepId) : '';

    if (assignedRepId && !assignedTo) {
        flashNotice('Choose a valid sales rep before bulk assigning leads.', 'error');
        return;
    }

    try {
        const updatedLeads = await dataService.bulkAssignClients({
            clientIds: state.selectedLeadIds,
            assignedRepId,
            assignedTo,
            actor: state.session
        });

        state.selectedLeadIds = [];
        state.bulkAssignRepId = assignedRepId;
        await refreshWorkspaceAfterMutation();
        flashNotice(
            assignedRepId
                ? `${updatedLeads.length} leads assigned to ${assignedTo}.`
                : `${updatedLeads.length} leads unassigned.`,
            'success'
        );
    } catch (error) {
        flashNotice(error.message || 'Unable to update lead assignments.', 'error');
    }
}

async function findDuplicateLeadCandidate(payload) {
    const email = normalizeWhitespace(payload.email).toLowerCase();
    const phoneDigits = String(payload.phone ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

    const localMatch = state.clients.find((client) => {
        if (payload.id && client.id === payload.id) {
            return false;
        }

        return (email && client.email?.toLowerCase() === email)
            || (phoneDigits && client.phoneKey === phoneDigits);
    }) || null;

    if (localMatch) {
        if (!canAccessClient(localMatch) && !isAdminSession(state.session)) {
            return {
                id: localMatch.id,
                restricted: true
            };
        }

        return localMatch;
    }

    if (typeof dataService.findDuplicateClientCandidate === 'function') {
        const remoteMatch = await dataService.findDuplicateClientCandidate(payload);

        if (!remoteMatch) {
            return null;
        }

        mergeClientCache([remoteMatch]);

        if (!canAccessClient(remoteMatch) && !isAdminSession(state.session)) {
            return {
                id: remoteMatch.id,
                restricted: true
            };
        }

        return remoteMatch;
    }

    return null;
}

function getMergeComparisonFields(existingLead, incomingPayload) {
    const incomingTags = parseTags(incomingPayload.tags);
    const fields = [
        { key: 'firstName', label: 'First name', existing: existingLead.firstName || '', incoming: incomingPayload.firstName || '', choices: ['existing', 'incoming'] },
        { key: 'lastName', label: 'Last name', existing: existingLead.lastName || '', incoming: incomingPayload.lastName || '', choices: ['existing', 'incoming'] },
        { key: 'email', label: 'Email', existing: existingLead.email || '', incoming: incomingPayload.email || '', choices: ['existing', 'incoming'] },
        { key: 'phone', label: 'Phone', existing: existingLead.phone || '', incoming: incomingPayload.phone || '', choices: ['existing', 'incoming'] },
        { key: 'status', label: 'Status', existing: existingLead.status || '', incoming: incomingPayload.status || '', choices: ['existing', 'incoming'] },
        { key: 'subscriptionType', label: 'Subscription type', existing: existingLead.subscriptionType || '', incoming: incomingPayload.subscriptionType || '', choices: ['existing', 'incoming'] },
        { key: 'timeZone', label: 'Time zone', existing: existingLead.timezoneOverridden ? (existingLead.timeZone || '') : '', incoming: incomingPayload.timeZone || '', choices: ['existing', 'incoming'] },
        { key: 'disposition', label: 'Disposition', existing: existingLead.disposition || '', incoming: incomingPayload.disposition || '', choices: ['existing', 'incoming'] },
        { key: 'tags', label: 'Tags', existing: (existingLead.tags || []).join(', '), incoming: incomingTags.join(', '), choices: ['existing', 'incoming', 'combine'] },
        { key: 'notes', label: 'Notes', existing: existingLead.notes || '', incoming: incomingPayload.notes || '', choices: ['existing', 'incoming', 'combine'] }
    ];

    return fields.filter((field) => normalizeWhitespace(field.incoming) && normalizeWhitespace(field.existing) !== normalizeWhitespace(field.incoming));
}

async function handleCreateLeadSubmit(clientPayload) {
    const duplicateLead = await findDuplicateLeadCandidate(clientPayload);

    if (duplicateLead) {
        if (duplicateLead.restricted) {
            throw new Error('A matching lead already exists in the CRM but is outside your current assignment scope.');
        }

        openModal({
            type: 'create-duplicate',
            duplicateLead,
            incomingPayload: clientPayload
        });
        return null;
    }

    return saveLeadPayload(clientPayload);
}

function buildResolvedMergePayload(existingLead, incomingPayload, formData) {
    const fields = getMergeComparisonFields(existingLead, incomingPayload);
    const resolved = {
        ...existingLead
    };
    let resolvedNotes = existingLead.notes || incomingPayload.notes || '';

    [
        'firstName',
        'lastName',
        'email',
        'phone',
        'status',
        'subscriptionType',
        'timeZone',
        'disposition'
    ].forEach((field) => {
        if (!normalizeWhitespace(existingLead[field]) && normalizeWhitespace(incomingPayload[field])) {
            resolved[field] = incomingPayload[field];
        }
    });

    if (!(existingLead.tags || []).length && parseTags(incomingPayload.tags).length) {
        resolved.tags = dedupeAllowedTags(incomingPayload.tags);
    }

    fields.forEach((field) => {
        const decision = String(formData.get(`resolve-${field.key}`) ?? 'existing');

        if (field.key === 'tags') {
            if (decision === 'combine') {
                resolved.tags = dedupeAllowedTags([...existingLead.tags, ...parseTags(incomingPayload.tags)]);
            } else if (decision === 'incoming') {
                resolved.tags = dedupeAllowedTags(incomingPayload.tags);
            } else {
                resolved.tags = [...existingLead.tags];
            }
            return;
        }

        if (field.key === 'notes') {
            if (decision === 'combine') {
                resolvedNotes = [existingLead.notes, incomingPayload.notes].filter(Boolean).join('\n\n');
            } else if (decision === 'incoming') {
                resolvedNotes = incomingPayload.notes || '';
            } else {
                resolvedNotes = existingLead.notes || '';
            }
            return;
        }

        resolved[field.key] = decision === 'incoming' ? incomingPayload[field.key] : existingLead[field.key];
    });

    return {
        payload: resolved,
        resolvedNotes
    };
}

function getMergeChoicePreview(field, choice) {
    if (choice === 'combine') {
        if (field.key === 'tags') {
            return dedupeAllowedTags(`${field.existing}, ${field.incoming}`).join(', ') || 'No tags';
        }

        if (field.key === 'notes') {
            return [field.existing, field.incoming].filter(Boolean).join(' / ') || 'No notes';
        }
    }

    return choice === 'incoming' ? (field.incoming || 'Blank') : (field.existing || 'Blank');
}

function getTagPickerState(picker) {
    const hiddenInput = picker.querySelector('input[type="hidden"][name="tags"]');
    const selectedTags = parseTags(hiddenInput?.value ?? '');
    return { hiddenInput, selectedTags };
}

function updateTagPicker(picker, selectedTags, query = '') {
    const { hiddenInput } = getTagPickerState(picker);
    const nextTags = dedupeAllowedTags(selectedTags);
    const chipContainer = picker.querySelector('.tag-picker-chips');
    const suggestionList = picker.querySelector('.tag-suggestion-list');
    const input = picker.querySelector('.tag-picker-input');

    if (hiddenInput) {
        hiddenInput.value = nextTags.join(', ');
    }

    if (chipContainer) {
        chipContainer.innerHTML = renderTagPickerChips(nextTags, Boolean(input));
    }

    if (input) {
        renderTagSuggestions(suggestionList, getTagSuggestions(query, nextTags));
    }
}

function renderTagSuggestions(container, suggestions) {
    if (!container) {
        return;
    }

    if (!suggestions.length) {
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }

    container.innerHTML = suggestions.map((tag) => `
        <button type="button" class="tag-suggestion" data-action="select-tag-suggestion" data-tag="${escapeHtml(tag)}">
            ${escapeHtml(tag)}
        </button>
    `).join('');
    container.classList.remove('hidden');
}

function refreshTagSuggestions(input) {
    const picker = input.closest('[data-tag-picker]');

    if (!picker) {
        return;
    }

    const { selectedTags } = getTagPickerState(picker);
    renderTagSuggestions(picker.querySelector('.tag-suggestion-list'), getTagSuggestions(input.value, selectedTags));
}

function commitTagInput(input) {
    const picker = input.closest('[data-tag-picker]');

    if (!picker) {
        return;
    }

    const { selectedTags } = getTagPickerState(picker);
    const query = normalizeWhitespace(input.value);
    const allowedMap = buildAllowedTagMap();
    const canonicalTag = allowedMap.get(query.toLowerCase()) || getTagSuggestions(query, selectedTags)[0] || '';

    if (!canonicalTag) {
        flashNotice('Choose a tag from the admin-managed suggestions.', 'error');
        input.value = '';
        renderTagSuggestions(picker.querySelector('.tag-suggestion-list'), []);
        return;
    }

    updateTagPicker(picker, [...selectedTags, canonicalTag], '');
    input.value = '';
    input.focus();
}

function removeTagFromPicker(actionEl) {
    const picker = actionEl.closest('[data-tag-picker]');

    if (!picker) {
        return;
    }

    const { selectedTags } = getTagPickerState(picker);
    updateTagPicker(
        picker,
        selectedTags.filter((tag) => tag.toLowerCase() !== String(actionEl.dataset.tag ?? '').toLowerCase()),
        ''
    );
}

function addTagFromSuggestion(actionEl) {
    const picker = actionEl.closest('[data-tag-picker]');

    if (!picker) {
        return;
    }

    const { selectedTags } = getTagPickerState(picker);
    const input = picker.querySelector('.tag-picker-input');
    updateTagPicker(picker, [...selectedTags, actionEl.dataset.tag], '');

    if (input) {
        input.value = '';
        input.focus();
    }
}

function removeLastTagFromPicker(input) {
    const picker = input.closest('[data-tag-picker]');

    if (!picker) {
        return;
    }

    const { selectedTags } = getTagPickerState(picker);

    if (!selectedTags.length) {
        return;
    }

    updateTagPicker(picker, selectedTags.slice(0, -1), '');
}

async function saveLeadPayload(payload) {
    const existingLead = payload.id ? getAccessibleClientById(payload.id) : null;

    if (payload.id && !existingLead && !hasPermission(state.session, PERMISSIONS.VIEW_ALL_RECORDS)) {
        throw new Error('You can only update leads assigned to your session.');
    }

    if (!payload.id && !hasPermission(state.session, PERMISSIONS.CREATE_LEADS)) {
        throw new Error('This session cannot create leads.');
    }

    if (payload.id && existingLead && !canEnterLeadEditMode(state.session, existingLead)) {
        throw new Error('This session cannot edit that record.');
    }

    if (existingLead?.lifecycleType === 'member' && !isAdminSession(state.session)) {
        throw new Error('Only admin users can edit Members.');
    }

    const sanitizedPayload = sanitizeLeadPayloadForSession(payload, existingLead);
    const savedLead = await dataService.saveClient({
        ...sanitizedPayload,
        actor: state.session
    });
    const staysAccessible = hasPermission(state.session, PERMISSIONS.VIEW_ALL_RECORDS) || savedLead.assignedRepId === state.session?.id;
    state.lastWorkspaceView = savedLead.lifecycleType === 'member'
        ? 'members'
        : (normalizeWhitespace(savedLead.assignedRepId) && hasPermission(state.session, PERMISSIONS.ASSIGN_LEADS)
            ? 'assigned-leads'
            : 'clients');
    state.detailClientId = staysAccessible ? savedLead.id : null;
    state.currentView = staysAccessible ? 'lead-detail' : state.lastWorkspaceView;
    state.detailEditMode = false;
    state.detailEditSnapshot = null;
    await refreshWorkspaceAfterMutation();
    return savedLead;
}

function syncToSeniorRepFieldState(form) {
    const activeForm = form?.matches?.('#lead-detail-form') ? form : document.getElementById('lead-detail-form');

    if (!activeForm) {
        return;
    }

    const dispositionSelect = activeForm.querySelector('select[name="disposition"]');
    const toField = activeForm.querySelector('[data-to-senior-rep-field]');
    const toSelect = activeForm.querySelector('select[name="toSeniorRepId"]');

    if (!dispositionSelect || !toField || !toSelect) {
        return;
    }

    const shouldShow = isToDispositionValue(dispositionSelect.value);
    toField.classList.toggle('hidden', !shouldShow);
    toSelect.disabled = !shouldShow;

    if (!shouldShow) {
        toSelect.value = '';
    }
}

function cloneFilterPayload(filters) {
    return normalizeFilterState(JSON.parse(JSON.stringify(filters)));
}

function createSavedFilterPayload() {
    return {
        filters: cloneFilterPayload(state.filters),
        search: state.workspaceSearch,
        sort: { ...state.sort },
        pageSize: state.pageSize
    };
}

function applySavedFilter(savedFilter) {
    const payload = savedFilter.filterPayload || {};
    state.filters = normalizeFilterState(payload.filters || payload || createDefaultFilters());
    state.workspaceSearch = String(payload.search ?? '');
    state.lookupQuery = isWorkspaceSearchView() ? state.workspaceSearch : state.lookupQuery;
    state.sort = {
        field: typeof payload.sort?.field === 'string' ? payload.sort.field : 'updatedAt',
        direction: payload.sort?.direction === 'asc' ? 'asc' : 'desc'
    };
    state.pageSize = [25, 50, 100, 250].includes(Number(payload.pageSize)) ? Number(payload.pageSize) : 50;
    state.activeSavedFilterId = savedFilter.id;
    state.page = 1;
    openFilterAccordionForActiveGroups({ includeDefault: true });
    state.filterAccordionInitialized = true;
    resetToolbarSuggestions({ clearResults: true });
}

async function openLeadDetailPage(clientId, sourceView = 'clients') {
    try {
        const detailedLead = await dataService.getClientById(clientId);

        if (!detailedLead || !canAccessClient(detailedLead)) {
            flashNotice('That record is no longer available in your current CRM scope.', 'error');
            return;
        }

        mergeClientCache([detailedLead]);
        await loadLeadCalendarEvents(clientId, { force: true });
    } catch (error) {
        flashNotice(error.message || 'Unable to load the lead details.', 'error');
        return;
    }

    state.detailClientId = clientId;
    state.currentView = 'lead-detail';
    state.lastWorkspaceView = sourceView === 'members'
        ? 'members'
        : (sourceView === 'assigned-leads' ? 'assigned-leads' : 'clients');
    state.detailEditMode = false;
    state.detailEditSnapshot = null;
    state.editingNoteId = null;
    closeDrawer();
    if (state.modal) {
        closeModal();
    }
    render();
}

async function navigateLeadDetail(direction) {
    const scope = state.lastWorkspaceView === 'members' ? 'members' : 'leads';
    const visibleSet = getLeadNavigationSet(scope);
    const currentIndex = visibleSet.findIndex((item) => item.id === state.detailClientId);

    if (currentIndex < 0) {
        return;
    }

    const nextIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1;
    const nextLead = visibleSet[nextIndex];

    if (!nextLead) {
        return;
    }

    await openLeadDetailPage(nextLead.id, state.lastWorkspaceView);
}

async function handleImportFile(file) {
    state.importFlow = { step: 'loading' };
    renderModal();

    try {
        await loadFullClientDataset();
        const text = await file.text();
        const parsed = parseCsvText(text);

        if (!parsed.headers.length || !parsed.rows.length) {
            throw new Error('The selected CSV did not contain headers and rows that could be parsed.');
        }

        const { mapping } = buildAutoMapping(parsed.headers);
        const preview = await dataService.buildImportPreview({
            fileName: file.name,
            rawRows: parsed.rows,
            mapping,
            existingClients: state.clients
        });

        state.importFlow = {
            step: 'review',
            fileName: file.name,
            headers: parsed.headers,
            rawRows: parsed.rows,
            mapping,
            duplicateMode: 'skip',
            preview
        };
        renderModal();
    } catch (error) {
        state.importFlow = { step: 'select' };
        renderModal();
        flashNotice(error.message || 'Unable to parse the selected CSV.', 'error');
    }
}

async function syncImportPreviewFromForm() {
    if (!state.importFlow || state.importFlow.step !== 'review') {
        return;
    }

    const form = document.getElementById('import-mapping-form');

    if (!form) {
        return;
    }

    const formData = new FormData(form);
    const mapping = importFields.reduce((result, field) => {
        result[field.key] = String(formData.get(`map-${field.key}`) ?? '');
        return result;
    }, {});
    const duplicateMode = String(formData.get('duplicate-mode') ?? 'skip');

    state.importFlow.mapping = mapping;
    state.importFlow.duplicateMode = duplicateMode;
    state.importFlow.preview = await dataService.buildImportPreview({
        fileName: state.importFlow.fileName,
        rawRows: state.importFlow.rawRows,
        mapping,
        existingClients: state.clients
    });
    renderModal();
}

async function handleImportConfirm() {
    if (!state.importFlow || state.importFlow.step !== 'review') {
        return;
    }

    const previewIssues = state.importFlow.preview.mappingIssues.unresolvedRequiredFields;

    if (previewIssues.length) {
        flashNotice(previewIssues.join(' '), 'error');
        return;
    }

    state.importFlow.step = 'loading';
    renderModal();

    try {
        const result = await dataService.importClients({
            fileName: state.importFlow.fileName,
            rawRows: state.importFlow.rawRows,
            mapping: state.importFlow.mapping,
            duplicateMode: state.importFlow.duplicateMode,
            session: state.session,
            existingClients: state.clients
        });

        await refreshWorkspaceAfterMutation();

        state.importFlow = {
            ...state.importFlow,
            step: 'result',
            result
        };
        state.currentView = 'clients';
        render();
        flashNotice(`Import finished for ${state.importFlow.fileName}.`, 'success');
    } catch (error) {
        state.importFlow.step = 'review';
        renderModal();
        flashNotice(error.message || 'Import failed.', 'error');
    }
}
