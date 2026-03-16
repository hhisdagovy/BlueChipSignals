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
    downloadTextFile,
    escapeHtml,
    extractAreaCode,
    formatDate,
    formatDateTime,
    isToday,
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

const refs = {
    authGate: document.getElementById('auth-gate'),
    shell: document.getElementById('crm-shell'),
    sidebar: document.getElementById('crm-sidebar'),
    topbar: document.getElementById('crm-topbar'),
    overviewPanel: document.getElementById('crm-overview-panel'),
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
        placeholder: 'Premium, Trial, Enterprise',
        hint: 'Exact match, case insensitive.',
        parser: parseMultiValueList
    },
    {
        key: 'timeZones',
        label: 'Time zone',
        placeholder: 'Eastern, Mountain, America/New_York',
        hint: 'Exact match, case insensitive.',
        parser: parseMultiValueList
    }
];

const MULTI_FILTER_LOOKUP = Object.fromEntries(MULTI_FILTER_CONFIG.map((config) => [config.key, config]));
const WORKSPACE_UI_STATE_STORAGE_KEY = 'crm:workspace-ui-state';
const WORKSPACE_PAGE_CACHE_TTL_MS = 2 * 60 * 1000;
const WORKSPACE_PAGE_CACHE_MAX_ENTRIES = 24;
const SEARCH_SUGGESTION_DEBOUNCE_MS = 180;
const WORKSPACE_VIEWS = new Set(['overview', 'clients', 'assigned-leads', 'members', 'admin', 'lead-detail', 'imports', 'settings']);
const WORKSPACE_PAGE_SIZES = [25, 50, 100, 250];
const ADMIN_TABS = Object.freeze([
    { id: 'team', icon: 'fa-users', label: 'Reps' },
    { id: 'tags', icon: 'fa-tags', label: 'Tags' },
    { id: 'dispositions', icon: 'fa-list-check', label: 'Dispositions' },
    { id: 'activity', icon: 'fa-chart-column', label: 'Activity' },
    { id: 'imports', icon: 'fa-file-arrow-up', label: 'Imports' }
]);
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
    clients: [],
    allowedTags: [],
    tagDefinitions: [],
    dispositionDefinitions: [],
    users: [],
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
    mobileSearchOpen: false,
    filtersPanelOpen: false,
    selectedLeadIds: [],
    bulkAssignRepId: '',
    drawerMode: null,
    drawerClientId: null,
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
let workspaceRefreshTimer = null;
let refreshDataPromise = null;
let searchSuggestionsTimer = null;
let searchSuggestionsRequestId = 0;

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
        authUserId: String(authUser?.id ?? ''),
        profileId: String(profile?.id ?? ''),
        profileRole: String(profile?.role ?? ''),
        profileActive: profile?.isActive !== false
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

            if (state.currentView === 'admin') {
                applyFullClientDataSnapshot(await dataService.initialize());
            } else {
                applyWorkspaceMetadataSnapshot(await dataService.initializeWorkspace());
            }
            [state.users, state.savedFilters] = await Promise.all([usersPromise, savedFiltersPromise]);

            if (supportsServerWorkspacePaging() && state.currentView !== 'admin') {
                const workspaceScope = state.lastWorkspaceView === 'members' ? 'members' : 'leads';
                await refreshWorkspacePage(workspaceScope, { renderWhileLoading: false });
            }

            if (state.detailClientId) {
                const detailedLead = await dataService.getClientById(state.detailClientId);

                if (detailedLead && canAccessClient(detailedLead)) {
                    mergeClientCache([detailedLead]);
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
    workspaceSummary = createEmptyWorkspaceSummary()
} = {}) {
    state.allowedTags = allowedTags;
    state.tagDefinitions = tagDefinitions;
    state.dispositionDefinitions = dispositionDefinitions;
    state.importHistory = importHistory;
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
    dispositionDefinitions = []
} = {}) {
    state.clients = clients;
    state.allowedTags = allowedTags;
    state.tagDefinitions = tagDefinitions;
    state.dispositionDefinitions = dispositionDefinitions;
    state.importHistory = importHistory;
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

function syncShellState() {
    document.body.classList.toggle('crm-nav-open', state.sidebarOpen);

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
    return typeof dataService.listClientsPage === 'function';
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
    if (!supportsServerWorkspacePaging() || !state.session) {
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
        renderTopbar();
        renderSidebar();
        renderPanels();

        if (activeFilterGroup) {
            focusFilterInput(activeFilterGroup);
        }
        if (activeSearchSurface) {
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
        renderTopbar();
        renderSidebar();
        renderPanels();

        if (activeFilterGroup) {
            focusFilterInput(activeFilterGroup);
        }
        if (activeSearchSurface) {
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

    if (state.currentView === 'imports') {
        return 'admin';
    }

    if (state.currentView === 'settings') {
        return 'settings';
    }

    return state.currentView;
}

function getLeadDetailNavigationContext() {
    const detailScope = state.lastWorkspaceView === 'members' ? 'members' : 'leads';
    const visibleSet = getLeadNavigationSet(detailScope);
    const currentIndex = visibleSet.findIndex((item) => item.id === state.detailClientId);
    const backLabel = state.lastWorkspaceView === 'members'
        ? 'Members'
        : (state.lastWorkspaceView === 'assigned-leads' ? 'Assigned Leads' : 'Unassigned Leads');

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

        if (typeof input.setSelectionRange === 'function') {
            const caret = typeof caretPosition === 'number' ? caretPosition : input.value.length;
            input.setSelectionRange(caret, caret);
        }
    });
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
        renderTopbar();
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
            renderTopbar();
            focusToolbarSearchInput(surface, state.activeSearchCaret);
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
    return `
        <div class="crm-search-preview-field ${fullWidth ? 'is-full' : ''}">
            <span class="crm-search-preview-field-label">${escapeHtml(label)}</span>
            <div class="crm-search-preview-field-value">${escapeHtml(value || '—')}</div>
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

                <div class="crm-primary-nav" role="navigation" aria-label="CRM navigation">
                    ${items.map((item) => `
                        <button
                            class="crm-primary-link ${activeView === item.view ? 'active' : ''}"
                            data-action="set-view"
                            data-view="${item.view}"
                        >
                            <span>${item.label}</span>
                        </button>
                    `).join('')}
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

    const panelStates = new Map([
        [refs.overviewPanel, state.currentView === 'overview'],
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
                    <p class="ov-hero-desc">Monitor lead flow, member growth, and recent activity from one workspace.</p>
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
                        <div class="ov-stat-tile-sub">Across the active pipeline</div>
                    </article>
                    <article class="ov-stat-tile" id="ov-stat-members">
                        <div class="ov-stat-tile-label">Members</div>
                        <div class="ov-stat-tile-value">${metrics.totalMembers.toLocaleString()}</div>
                        <div class="ov-stat-tile-sub">Moved into the members workspace</div>
                    </article>
                    <article class="ov-stat-tile" id="ov-stat-status">
                        <div class="ov-stat-tile-label">Top Status</div>
                        <div class="ov-stat-tile-value">${metrics.topStatus.count.toLocaleString()}</div>
                        <div class="ov-stat-tile-sub">${escapeHtml(metrics.topStatus.label)}</div>
                    </article>
                    <article class="ov-stat-tile" id="ov-stat-tag">
                        <div class="ov-stat-tile-label">Top Tag</div>
                        <div class="ov-stat-tile-value">${metrics.topTag.count.toLocaleString()}</div>
                        <div class="ov-stat-tile-sub">${escapeHtml(metrics.topTag.label)}</div>
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
                                            <span class="ov-activity-meta">${escapeHtml(client.email || client.phone || 'No contact info')}</span>
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
                            `).join('') || '<span class="ov-card-empty">No tags available yet.</span>'}
                        </div>
                    </section>
                </div>
            </div>
        </div>
    `;
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
    const heroIcon = isMembers ? 'fa-users-viewfinder' : 'fa-address-book';
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
                    <h1><i class="fa-solid ${heroIcon}"></i> ${workspaceLabel}</h1>
                    <p>${searchSummary}</p>
                </div>
                <span class="lead-history-hero-badge">${heroBadge}</span>
            </section>

            <section class="lead-history-filters">
                <div class="lead-history-filter-group">
                    <span class="lead-history-filter-label">Status</span>
                    <button class="lead-history-pill ${state.filters.status === 'all' ? 'active' : ''}" data-action="set-status-filter" data-status="all">All</button>
                    ${statusOptions.map((status) => `
                        <button
                            class="lead-history-pill status-${escapeHtml(status)} ${state.filters.status === status ? 'active' : ''}"
                            data-action="set-status-filter"
                            data-status="${status}"
                        >
                            ${escapeHtml(titleCase(status))}
                        </button>
                    `).join('')}
                </div>

                <div class="lead-history-filter-divider"></div>

                <div class="lead-history-filter-group">
                    <span class="lead-history-filter-label">Tag</span>
                    <select id="tag-filter" class="lead-history-select">
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

                <button class="lead-history-clear-btn" data-action="open-filters">
                    <i class="fa-solid fa-sliders"></i> ${state.filtersPanelOpen ? 'Hide Advanced' : 'Advanced'}${activeFilterCount ? ` (${activeFilterCount})` : ''}
                </button>

                ${createAction}
                ${assignmentViewAction}

                <button class="lead-history-clear-btn" data-action="clear-client-filters">
                    <i class="fa-solid fa-xmark"></i> Clear
                </button>
            </section>

            ${state.filtersPanelOpen ? renderLeadHistoryAdvancedFilters(savedFilters, activeSavedFilter, scope) : ''}

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
            <td>${escapeHtml(client.email || '—')}</td>
            <td>${escapeHtml(client.phone || '—')}</td>
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

function renderLeadHistoryAdvancedFilters(savedFilters, activeSavedFilter, scope = 'leads') {
    const isMembers = scope === 'members';
    const singularLabel = isMembers ? 'member' : 'lead';
    const savedViewPlaceholder = isMembers ? 'Active member renewals' : 'Morning follow-up list';

    return `
        <section class="lead-history-advanced">
            <div class="lead-history-advanced-grid">
                <section class="lead-history-advanced-card">
                    <div class="lead-history-section-head">
                        <div>
                            <span class="lead-history-section-title">Advanced Filters</span>
                            <p class="lead-history-section-copy">Stack first name, last name, area code, subscription, and time zone filters without leaving the page.</p>
                        </div>
                        <button class="lead-history-clear-btn" data-action="clear-client-filters">
                            <i class="fa-solid fa-rotate-left"></i> Reset All
                        </button>
                    </div>

                    <div class="crm-filter-panel lead-history-filter-panel">
                        ${MULTI_FILTER_CONFIG.map((config) => renderMultiValueFilterGroup(config)).join('')}
                    </div>
                </section>

                <section class="lead-history-advanced-card">
                    <div class="lead-history-section-head">
                        <div>
                            <span class="lead-history-section-title">Saved Views</span>
                            <p class="lead-history-section-copy">Save the current ${singularLabel} view for yourself or share it with the floor.</p>
                        </div>
                    </div>

                    <form id="saved-filter-form" class="lead-history-save-form">
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
                        <div class="modal-actions" style="margin-top: 1rem;">
                            <button class="crm-button" type="submit"><i class="fa-solid fa-bookmark"></i> ${state.activeSavedFilterId ? 'Update' : 'Save'}</button>
                            ${state.activeSavedFilterId ? '<button class="crm-button-ghost" type="button" data-action="clear-active-saved-filter">New</button>' : ''}
                        </div>
                    </form>

                    <div class="history-list compact-history lead-history-saved-list">
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
            </div>
        </section>
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

function renderMultiValueFilterGroup(config) {
    const values = state.filters.multi[config.key];

    return `
        <section class="multi-filter-group">
            <div class="multi-filter-head">
                <div>
                    <div class="mapping-label">${escapeHtml(config.label)}</div>
                    <div class="mapping-hint">${escapeHtml(config.hint)}</div>
                </div>
                <div class="row-actions">
                    <span class="summary-chip">${values.length} active</span>
                    ${values.length ? `
                        <button class="crm-button-ghost filter-clear-button" data-action="clear-filter-group" data-group="${config.key}">
                            Clear
                        </button>
                    ` : ''}
                </div>
            </div>

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
                    placeholder="${escapeHtml(config.placeholder)}"
                    aria-label="${escapeHtml(config.label)} filter values"
                >
            </div>
        </section>
    `;
}

function renderLeadDetailPage() {
    const lead = getAccessibleClientById(state.detailClientId);

    if (!lead) {
        return renderEmptyState({
            title: 'Lead not found',
            copy: hasPermission(state.session, PERMISSIONS.VIEW_ADMIN)
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
    const noteHistory = Array.isArray(lead.noteHistory)
        ? [...lead.noteHistory].sort((left, right) => Date.parse(right.createdAt ?? 0) - Date.parse(left.createdAt ?? 0))
        : [];
    const dispositionOptions = getLeadDetailDispositionOptions(lead);
    const showToSeniorRepField = isToDispositionValue(lead.disposition);
    const selectedToSeniorRepId = showToSeniorRepField && seniorRepOptions.some((user) => user.id === lead.assignedRepId)
        ? lead.assignedRepId
        : '';
    const entityLabel = isMember ? 'Member' : 'Lead';
    const detailName = lead.fullName || `Unnamed ${entityLabel.toLowerCase()}`;
    const heroSummary = buildLeadDetailSummary(lead);
    const formIntroCopy = isEditing
        ? `Edit ${entityLabel.toLowerCase()} contact information, assignment, and workflow details from one focused form.`
        : `Review ${entityLabel.toLowerCase()} contact information, ownership, and workflow details. Use Edit when you need to make changes.`;

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
                            <h2>${escapeHtml(entityLabel)} record</h2>
                            <p>${escapeHtml(formIntroCopy)}</p>
                        </div>
                        <div class="lead-detail-card-head-actions">
                            ${canOpenEditMode ? `
                                <button class="crm-button-ghost" data-action="${isEditing ? 'cancel-lead-edit' : 'toggle-lead-edit'}">
                                    <i class="fa-solid ${isEditing ? 'fa-xmark' : 'fa-pen'}"></i> ${isEditing ? 'Cancel Edit' : 'Edit'}
                                </button>
                            ` : ''}
                            <button class="crm-button-ghost" data-action="toggle-lead-history">
                                <i class="fa-solid fa-timeline"></i> Lead History
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
                            ${renderLeadField('Email', 'email', lead.email, isEditing && canEditLeadField(state.session, 'email', lead), 'email')}
                            ${renderLeadField('Phone', 'phone', lead.phone, isEditing && canEditLeadField(state.session, 'phone', lead), 'text')}
                            ${renderLeadSelectField('Status', 'status', statusOptions, lead.status, canEditLeadWorkflowField(lead, 'status') || (isEditing && canEditLeadField(state.session, 'status', lead)))}
                            ${renderLeadSelectField('Disposition', 'disposition', dispositionOptions, lead.disposition || '', canEditLeadWorkflowField(lead, 'disposition') || (isEditing && canEditLeadField(state.session, 'disposition', lead)), null, { emptyLabel: 'No disposition' })}
                            ${renderLeadField('Subscription type', 'subscriptionType', lead.subscriptionType, isEditing && canAdminEdit)}
                            <label class="form-field">
                                <span class="form-label">Time zone override</span>
                                <select class="crm-select" name="timeZone" ${(isEditing && (canAdminEdit || canEditLeadField(state.session, 'timeZone', lead))) ? '' : 'disabled'}>
                                    <option value="">Auto detect (${escapeHtml(lead.autoTimeZone || 'Unknown')})</option>
                                    ${CRM_TIME_ZONE_OPTIONS.map((timeZone) => `
                                        <option value="${escapeHtml(timeZone)}" ${lead.timezoneOverridden && lead.timeZone === timeZone ? 'selected' : ''}>${escapeHtml(timeZone)}</option>
                                    `).join('')}
                                </select>
                                <span class="panel-subtitle">Current value: ${escapeHtml(lead.timeZone || 'Unknown')} ${lead.timezoneOverridden ? '· manual override' : '· auto detected'}</span>
                            </label>
                            ${renderLeadField('Follow up at', 'followUpAt', lead.followUpAt, canEditLeadWorkflowField(lead, 'followUpAt') || (isEditing && canEditLeadField(state.session, 'followUpAt', lead)), 'datetime-local')}
                            ${renderLeadField('Follow up action', 'followUpAction', lead.followUpAction, canEditLeadWorkflowField(lead, 'followUpAction') || (isEditing && canEditLeadField(state.session, 'followUpAction', lead)))}
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
                                <button class="crm-button" type="submit">
                                    <i class="fa-solid fa-floppy-disk"></i> ${isEditing ? 'Save Lead Changes' : 'Save Workflow Updates'}
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
                    <section class="crm-card lead-detail-side-card lead-detail-notes-card">
                        <div class="panel-head">
                            <div>
                                <span class="lead-detail-card-label">Conversation</span>
                                <h2 class="section-title">Notes</h2>
                                <p class="panel-copy">Capture the latest call summary, objections, and follow-up context without leaving the record.</p>
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
                                    <button class="crm-button-secondary" type="submit"><i class="fa-solid fa-note-sticky"></i> Save Notes</button>
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
                            <div class="history-title">${escapeHtml(entry.fieldName || entry.fieldLabel || 'Unknown field')}</div>
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

function renderLeadField(label, name, value, editable, type = 'text') {
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
    return getAssignableUsers({ includeAdmin: false, salesFloorOnly: true, includeInactive: true });
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
                        <p class="crm-admin-hero-sub">Manage reps, pipeline rules, and workspace activity from one focused control center.</p>
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
                        <div class="crm-admin-stat-label">Total Reps</div>
                    </div>
                </article>
                <article class="crm-admin-stat-card">
                    <div class="crm-admin-stat-icon"><i class="fa-solid fa-user-check"></i></div>
                    <div>
                        <div class="crm-admin-stat-value">${adminMetrics.activeReps.toLocaleString()}</div>
                        <div class="crm-admin-stat-label">Active Reps</div>
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
                                ['sales', 'Sales']
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
                            <div>No reps match the current search.</div>
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

function renderSettingsPanel() {
    const leadCount = getWorkspaceDisplayCount('leads', { ignoreSearch: true, ignoreFilters: true });
    const memberCount = getWorkspaceDisplayCount('members', { ignoreSearch: true, ignoreFilters: true });
    const canManageSettings = hasPermission(state.session, PERMISSIONS.MANAGE_SETTINGS);
    const canExport = hasPermission(state.session, PERMISSIONS.EXPORT_LEADS);
    const totalRecords = leadCount + memberCount;

    return `
        <div class="settings-grid crm-settings-page">
            <section class="crm-settings-hero">
                <div class="crm-settings-hero-inner">
                    <span class="crm-settings-hero-label"><i class="fa-solid fa-gears"></i> Workspace settings</span>
                    <h1>Account and <em>workspace controls</em></h1>
                    <p class="crm-settings-hero-desc">
                        Manage session access, exports, and workspace maintenance from one polished control page.
                    </p>
                    <div class="crm-settings-hero-chips">
                        <span class="crm-settings-chip"><i class="fa-solid fa-user"></i> ${escapeHtml(state.session.name)}</span>
                        <span class="crm-settings-chip"><i class="fa-solid fa-shield-halved"></i> ${escapeHtml(getRoleLabel(state.session.role))} access</span>
                        <span class="crm-settings-chip"><i class="fa-solid fa-database"></i> ${totalRecords.toLocaleString()} workspace records</span>
                        <span class="crm-settings-chip ${canManageSettings ? 'is-active' : ''}">
                            <i class="fa-solid ${canManageSettings ? 'fa-check-circle' : 'fa-lock'}"></i>
                            ${canManageSettings ? 'Admin maintenance enabled' : 'Sales workspace session'}
                        </span>
                    </div>
                </div>
            </section>

            <div class="crm-settings-main">
                <section class="crm-settings-card crm-settings-card-wide">
                    <div class="crm-settings-card-head">
                        <div class="crm-settings-card-title">
                            <span class="crm-settings-card-icon"><i class="fa-solid fa-user-shield"></i></span>
                            <div>
                                <h2>Session & access</h2>
                                <p>Review the signed-in CRM account and end the session when needed.</p>
                            </div>
                        </div>
                    </div>

                    <div class="crm-settings-field-grid">
                        <label class="crm-settings-field">
                            <span class="form-label">Signed in as</span>
                            <div class="crm-settings-field-value">${escapeHtml(state.session.name)}</div>
                        </label>
                        <label class="crm-settings-field">
                            <span class="form-label">Email</span>
                            <div class="crm-settings-field-value">${escapeHtml(state.session.email || 'Not available')}</div>
                        </label>
                        <label class="crm-settings-field">
                            <span class="form-label">Access level</span>
                            <div class="crm-settings-field-value">${escapeHtml(getRoleLabel(state.session.role))}</div>
                        </label>
                        <label class="crm-settings-field">
                            <span class="form-label">Workspace inventory</span>
                            <div class="crm-settings-field-value">${leadCount.toLocaleString()} leads and ${memberCount.toLocaleString()} members</div>
                        </label>
                    </div>

                    <div class="settings-actions crm-settings-action-row">
                        <button class="crm-button" data-action="logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</button>
                    </div>
                </section>

                <section class="crm-settings-card">
                    <div class="crm-settings-card-head">
                        <div class="crm-settings-card-title">
                            <span class="crm-settings-card-icon"><i class="fa-solid fa-file-export"></i></span>
                            <div>
                                <h2>Exports</h2>
                                <p>Download the CRM workspace in a clean CSV format whenever export access is available.</p>
                            </div>
                        </div>
                    </div>

                    <div class="crm-settings-quick-stats">
                        <div class="crm-settings-quick-stat">
                            <span>Lead inventory</span>
                            <strong>${leadCount.toLocaleString()}</strong>
                        </div>
                        <div class="crm-settings-quick-stat">
                            <span>Member inventory</span>
                            <strong>${memberCount.toLocaleString()}</strong>
                        </div>
                    </div>

                    <div class="settings-actions crm-settings-action-row">
                        ${canExport ? '<button class="crm-button-secondary" data-action="export-clients"><i class="fa-solid fa-file-export"></i> Export CSV</button>' : ''}
                    </div>
                    <div class="crm-settings-support-note">${canExport ? 'Exports mirror the current CRM workspace so your team can work from the latest snapshot.' : 'Export access is reserved for admin sessions.'}</div>
                </section>

                <section class="crm-settings-card crm-settings-card-danger crm-settings-card-full">
                    <div class="crm-settings-card-head">
                        <div class="crm-settings-card-title">
                            <span class="crm-settings-card-icon"><i class="fa-solid fa-triangle-exclamation"></i></span>
                            <div>
                                <h2>Danger zone</h2>
                                <p>Clear CRM records and import history from this workspace.</p>
                            </div>
                        </div>
                    </div>

                    <div class="settings-actions crm-settings-action-row">
                        ${canManageSettings ? `
                            <button class="crm-button-danger" data-action="open-clear-confirm">
                                <i class="fa-solid fa-trash"></i> Clear all data
                            </button>
                        ` : ''}
                    </div>
                    <div class="crm-settings-support-note">${canManageSettings ? 'You will need to type CLEAR in the confirmation step before the reset can proceed.' : 'Only admin users can reset the workspace.'}</div>
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
                            ${renderPreviewField('Phone', client.phone || '—')}
                            ${renderPreviewField('Email', client.email || '—', { fullWidth: true })}
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
                        <span class="crm-kicker"><i class="fa-solid fa-timeline"></i> Lead history</span>
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
                    <span class="crm-kicker"><i class="fa-solid fa-timeline"></i> ${escapeHtml(entityLabel)} history</span>
                    <h2 id="crm-history-modal-title" class="modal-title">${escapeHtml(detailName)}</h2>
                    <p class="panel-subtitle">Review the full change log for this record without leaving the page.</p>
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
                        <li><span class="mini-list-title">Email</span><span class="mini-list-meta">${escapeHtml(duplicateLead.email || '—')}</span></li>
                        <li><span class="mini-list-title">Phone</span><span class="mini-list-meta">${escapeHtml(duplicateLead.phone || '—')}</span></li>
                        <li><span class="mini-list-title">Assigned rep</span><span class="mini-list-meta">${escapeHtml(duplicateLead.assignedTo || 'Unassigned')}</span></li>
                    </ul>
                </section>
                <section class="crm-card">
                    <h3 class="section-title">Incoming lead</h3>
                    <ul class="mini-list">
                        <li><span class="mini-list-title">Name</span><span class="mini-list-meta">${escapeHtml(`${incomingPayload.firstName || ''} ${incomingPayload.lastName || ''}`.trim() || 'Unnamed lead')}</span></li>
                        <li><span class="mini-list-title">Email</span><span class="mini-list-meta">${escapeHtml(incomingPayload.email || '—')}</span></li>
                        <li><span class="mini-list-title">Phone</span><span class="mini-list-meta">${escapeHtml(incomingPayload.phone || '—')}</span></li>
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
                        <span class="crm-kicker"><i class="fa-solid fa-user-shield"></i> CRM rep account</span>
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
                    <span class="crm-kicker"><i class="fa-solid fa-user-shield"></i> CRM rep account</span>
                    <h2 class="modal-title">Edit rep account</h2>
                    <p class="panel-subtitle">Update the CRM profile for this rep. Email and password changes should be managed from account administration.</p>
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
                            <option value="sales" ${user?.role !== 'senior' ? 'selected' : ''}>Sales rep</option>
                            <option value="senior" ${user?.role === 'senior' ? 'selected' : ''}>Senior rep</option>
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
                    <button class="crm-button" type="submit"><i class="fa-solid fa-floppy-disk"></i> Save rep</button>
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
                                <td>${escapeHtml(client.email || '—')}</td>
                                <td>${escapeHtml(client.phone || '—')}</td>
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
            topTag: { label: 'No tags', count: 0 },
            topStatus: { label: 'No status', count: 0 }
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
        topTag: tagCounts[0] ? { label: tagCounts[0][0], count: tagCounts[0][1] } : { label: 'No tags', count: 0 },
        topStatus: statusCounts[0] ? { label: titleCase(statusCounts[0][0]), count: statusCounts[0][1] } : { label: 'No status', count: 0 }
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

    if (hasPermission(state.session, PERMISSIONS.VIEW_ADMIN)) {
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

function getActiveFilterGroupCount() {
    return Object.values(state.filters.multi).filter((values) => values.length).length
        + (state.filters.status !== 'all' ? 1 : 0)
        + (state.filters.tag !== 'all' ? 1 : 0);
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
    return ['create', 'create-member', 'lookup-preview'].includes(state.drawerMode);
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
    nextPayload.followUpAction = normalizeWhitespace(nextPayload.followUpAction || '');
    nextPayload.followUpAt = normalizeWhitespace(nextPayload.followUpAt || '');
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

    return nextPayload;
}

function getRoleLabel(role) {
    if (role === 'admin') {
        return 'Admin';
    }

    if (role === 'senior') {
        return 'Senior Rep';
    }

    return 'Sales';
}

function isToDispositionValue(value) {
    return normalizeWhitespace(value).toLowerCase() === 'to';
}

function getAssignableUsers({ includeAdmin = true, salesFloorOnly = false, seniorOnly = false, includeInactive = false } = {}) {
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
        followUpAction: lead.followUpAction || '',
        followUpAt: toDateTimeInputValue(lead.followUpAt),
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
        followUpAction: normalizeWhitespace(formData.get('followUpAction')),
        followUpAt: normalizeWhitespace(formData.get('followUpAt')),
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

function getLeadHistoryActorLabel(entry) {
    return entry?.changedByName || entry?.changedByUserId || entry?.createdByName || entry?.createdByUserId || 'System';
}

function getLeadDetailDispositionOptions(lead) {
    const currentValue = normalizeWhitespace(lead?.disposition || '');
    const options = getDispositionOptions(currentValue);
    return currentValue && !options.includes(currentValue) ? [currentValue, ...options] : options;
}

function getAdminMetrics() {
    const leads = getScopedClients('leads', { ignoreSearch: true, ignoreFilters: true });
    const members = getScopedClients('members', { ignoreSearch: true, ignoreFilters: true });
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
        activityEntries.filter((entry) => entry.type === 'follow-up').map((entry) => entry.createdByName || entry.createdByUserId || 'Local user')
    );
    const followUpsDue = leads.filter((lead) => {
        if (!lead.followUpAt) {
            return false;
        }

        return new Date(lead.followUpAt) <= new Date();
    }).length;

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

function openDrawer(mode) {
    state.drawerMode = mode;
    state.drawerClientId = null;
    renderDrawer();
    syncShellState();
}

function closeDrawer() {
    state.drawerMode = null;
    state.drawerClientId = null;
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
        renderDrawer();
        syncShellState();
    } catch (error) {
        flashNotice(error.message || 'Unable to load the lead preview.', 'error');
    }
}

function resetAuthenticatedCrmState() {
    workspacePageCache.clear();
    clearVisibleClientsCache();
    state.clients = [];
    state.allowedTags = [];
    state.tagDefinitions = [];
    state.dispositionDefinitions = [];
    state.users = [];
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

function refreshWorkspaceChrome() {
    renderSidebar();
    renderPanels();
    syncToolbarFilterButton();

    if (isWorkspaceListView(state.currentView)) {
        queueWorkspaceRefresh(getDefaultScopeForView());
    }
}

async function refreshWorkspaceAfterMutation() {
    invalidateWorkspacePageCache();
    await refreshData();
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
    const actionEl = event.target.closest('[data-action]');

    if (!actionEl) {
        if (shouldShowSearchSuggestions() && !event.target.closest('.search-shell')) {
            resetToolbarSuggestions();
            renderTopbar();
        }
        return;
    }

    const { action } = actionEl.dataset;

    if (state.searchSuggestionsOpen && action !== 'select-search-suggestion' && !actionEl.closest('.search-shell')) {
        resetToolbarSuggestions();
        renderTopbar();
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
        state.mobileSearchOpen = false;
        resetToolbarSuggestions();
        setSidebarOpen(nextIsOpen);
        renderTopbar();
        return;
    }

    if (action === 'toggle-mobile-search') {
        if (state.sidebarOpen) {
            setSidebarOpen(false);
        }

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

        if (targetView === 'admin' && actionEl.dataset.adminTab) {
            state.adminTab = getValidAdminTab(actionEl.dataset.adminTab);
        }

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
        render();
        return;
    }

    if (action === 'clear-active-saved-filter') {
        state.activeSavedFilterId = null;
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
            flashNotice('CRM rep account saved.', 'success');
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
            if (input && typeof input.setSelectionRange === 'function') {
                input.setSelectionRange(caretPosition, caretPosition);
            }
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

        renderTopbar();

        if (inWorkspaceSearchView) {
            renderSidebar();
            renderPanels();
            queueWorkspaceRefresh(getDefaultScopeForView());
        }

        focusToolbarSearchInput(searchSurface, caretPosition);

        if (normalizeWhitespace(nextValue)) {
            queueToolbarSuggestions({ surface: searchSurface });
        }
    }
});

window.addEventListener('resize', () => {
    if (!state.session || isMobileNavViewport()) {
        return;
    }

    let shouldRefreshChrome = false;

    if (state.sidebarOpen) {
        setSidebarOpen(false);
        shouldRefreshChrome = true;
    }

    if (state.mobileSearchOpen) {
        state.mobileSearchOpen = false;
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
    if (event.target.id === 'bulk-assignee') {
        state.bulkAssignRepId = event.target.value;
        renderPanels();
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
                renderTopbar();
                focusToolbarSearchInput(searchSurface, state.activeSearchCaret);

                if (!state.searchSuggestions.length && !state.searchSuggestionsLoading) {
                    state.searchSuggestionsLoading = true;
                    renderTopbar();
                    focusToolbarSearchInput(searchSurface, state.activeSearchCaret);
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
            renderTopbar();
            focusToolbarSearchInput(searchSurface, state.activeSearchCaret);
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
            renderTopbar();
            focusToolbarSearchInput(searchSurface, state.activeSearchCaret);
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
        }

        return;
    }

    if (event.key !== 'Escape') {
        return;
    }

    if (state.modal) {
        closeModal();
        return;
    }

    if (isDrawerOpen()) {
        closeDrawer();
    }
});

document.addEventListener('focusout', (event) => {
    if (event.target.matches('.crm-search')) {
        window.setTimeout(() => {
            if (!document.activeElement?.closest('.search-shell')) {
                resetToolbarSuggestions();
                setSearchShellExpanded(false);
                renderTopbar();
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
    if (event.target.matches('.crm-search')) {
        const searchSurface = getSearchSurfaceFromElement(event.target);
        const visibleQuery = normalizeWhitespace(getToolbarSearchValue());

        state.activeSearchSurface = searchSurface;
        state.activeSearchCaret = event.target.selectionStart ?? event.target.value.length;
        if (!state.searchShellExpanded) {
            setSearchShellExpanded(true);
            renderTopbar();
            focusToolbarSearchInput(searchSurface, state.activeSearchCaret);
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
            renderTopbar();
            focusToolbarSearchInput(searchSurface, state.activeSearchCaret);
            return;
        }

        state.searchSuggestionsLoading = true;
        state.searchSuggestionsQuery = visibleQuery;
        renderTopbar();
        focusToolbarSearchInput(searchSurface, state.activeSearchCaret);
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
        { key: 'followUpAction', label: 'Follow up action', existing: existingLead.followUpAction || '', incoming: incomingPayload.followUpAction || '', choices: ['existing', 'incoming'] },
        { key: 'followUpAt', label: 'Follow up at', existing: existingLead.followUpAt || '', incoming: incomingPayload.followUpAt || '', choices: ['existing', 'incoming'] },
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
        'disposition',
        'followUpAction',
        'followUpAt'
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

    if (payload.id && !existingLead && !hasPermission(state.session, PERMISSIONS.VIEW_ADMIN)) {
        throw new Error('You can only update leads assigned to your session.');
    }

    if (existingLead?.lifecycleType === 'member' && !isAdminSession(state.session)) {
        throw new Error('Only admin users can edit Members.');
    }

    const sanitizedPayload = sanitizeLeadPayloadForSession(payload, existingLead);
    const savedLead = await dataService.saveClient({
        ...sanitizedPayload,
        actor: state.session
    });
    const staysAccessible = hasPermission(state.session, PERMISSIONS.VIEW_ADMIN) || savedLead.assignedRepId === state.session?.id;
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
    resetToolbarSuggestions({ clearResults: true });
}

async function openLeadDetailPage(clientId, sourceView = 'clients') {
    try {
        const detailedLead = await dataService.getClientById(clientId);

        if (!detailedLead || !canAccessClient(detailedLead)) {
            flashNotice('That lead is not assigned to your session.', 'error');
            return;
        }

        mergeClientCache([detailedLead]);
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
