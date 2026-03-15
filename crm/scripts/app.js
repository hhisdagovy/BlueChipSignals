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
const visibleClientsCache = {
    clientsRef: null,
    filtersKey: '',
    sortKey: '',
    result: []
};

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
        requestId: 0
    };
}

const state = {
    session: authService.getSession(),
    authUser: authService.getAuthUser(),
    profile: authService.getProfile(),
    authResolved: false,
    authSubmitting: false,
    clients: [],
    allowedTags: [],
    tagDefinitions: [],
    dispositionDefinitions: [],
    users: [],
    savedFilters: [],
    importHistory: [],
    currentView: 'overview',
    lastWorkspaceView: 'clients',
    search: '',
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
    filtersPanelOpen: false,
    selectedLeadIds: [],
    bulkAssignRepId: '',
    drawerMode: null,
    detailClientId: null,
    detailEditMode: false,
    detailEditSnapshot: null,
    leadHistoryOpen: false,
    editingNoteId: null,
    editingTagDefinitionId: null,
    editingDispositionDefinitionId: null,
    modal: null,
    importFlow: null,
    activeSavedFilterId: null,
    notice: null,
    clientCacheMode: 'light',
    isLoading: false
};

let noticeTimer = null;
let workspaceRefreshTimer = null;

bootstrap();

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
        flashNotice(error.message || 'Unable to initialize Supabase auth for the CRM.', 'error');
    } finally {
        state.authResolved = true;
    }

    render();

    if (state.session) {
        await refreshData();
    }
}

async function refreshData() {
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

        const {
            clients,
            importHistory,
            allowedTags,
            tagDefinitions,
            dispositionDefinitions
        } = supportsServerWorkspacePaging() && typeof dataService.initializeWorkspace === 'function' && state.currentView !== 'admin'
            ? await dataService.initializeWorkspace()
            : await dataService.initialize();

        applyClientDataSnapshot({
            clients,
            importHistory,
            allowedTags,
            tagDefinitions,
            dispositionDefinitions
        }, state.currentView === 'admin' ? 'full' : 'light');
        state.users = await authService.listUsers();
        state.session = refreshedSession || state.session;
        state.savedFilters = await savedFilterService.listVisible(state.session);

        if (supportsServerWorkspacePaging() && ['clients', 'members', 'lead-detail'].includes(state.currentView)) {
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
            state.leadHistoryOpen = false;
            state.editingNoteId = null;
            if (state.currentView === 'lead-detail') {
                state.currentView = state.lastWorkspaceView || 'clients';
            }
        }
    } catch (error) {
        flashNotice(error.message || 'Unable to load the CRM prototype.', 'error');
    } finally {
        state.isLoading = false;
        render();
    }
}

function applyClientDataSnapshot({
    clients = [],
    importHistory = [],
    allowedTags = [],
    tagDefinitions = [],
    dispositionDefinitions = []
} = {}, cacheMode = 'light') {
    state.clients = clients;
    state.allowedTags = allowedTags;
    state.tagDefinitions = tagDefinitions;
    state.dispositionDefinitions = dispositionDefinitions;
    state.importHistory = importHistory;
    state.clientCacheMode = cacheMode;
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
        applyClientDataSnapshot(await dataService.initialize(), 'full');
    } catch (error) {
        flashNotice(error.message || 'Unable to load the full CRM dataset.', 'error');
    } finally {
        state.isLoading = false;
        render();
    }
}

function syncShellState() {
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
    if (!state.authResolved) {
        refs.authGate.classList.remove('hidden');
        refs.shell.classList.add('hidden');
        refs.authGate.innerHTML = renderAuthGate();
        refs.drawer.classList.add('hidden');
        refs.modalLayer.classList.add('hidden');
        refs.shell.classList.remove('drawer-open', 'sidebar-open');
        return;
    }

    if (!state.session) {
        refs.authGate.classList.remove('hidden');
        refs.shell.classList.add('hidden');
        refs.authGate.innerHTML = renderAuthGate();
        refs.drawer.classList.add('hidden');
        refs.modalLayer.classList.add('hidden');
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
    const users = authService.getTestUsers();
    const hasTestUsers = users.length > 0;
    const isCheckingSession = !state.authResolved;
    const isAuthenticating = state.authSubmitting;

    return `
        <div class="auth-grid">
            <section class="auth-hero">
                <span class="crm-kicker"><i class="fa-solid fa-lock"></i> Internal CRM Access</span>
                <h1 class="auth-title">Blue Chip CRM, built as a safe local sandbox.</h1>
                <p class="auth-copy">
                    This prototype is isolated from the public website and now boots against Supabase auth and data
                    while staying shaped around the future <span class="inline-code">/crm</span> route.
                </p>

                <div class="auth-feature-list">
                    <div class="auth-feature-item">
                        <i class="fa-solid fa-database"></i>
                        <div>
                            <strong>Supabase-backed workspace</strong>
                            <div class="panel-subtitle">Auth, leads, notes, tags, dispositions, and saved filters now resolve through Supabase for this CRM slice.</div>
                        </div>
                    </div>
                    <div class="auth-feature-item">
                        <i class="fa-solid fa-file-arrow-up"></i>
                        <div>
                            <strong>CSV import workflow</strong>
                            <div class="panel-subtitle">Map columns, review duplicates, and test large lead lists safely.</div>
                        </div>
                    </div>
                    <div class="auth-feature-item">
                        <i class="fa-solid fa-plug-circle-bolt"></i>
                        <div>
                            <strong>Backend-ready architecture</strong>
                            <div class="panel-subtitle">The UI talks to a service layer, not IndexedDB directly.</div>
                        </div>
                    </div>
                </div>
            </section>

            <section class="auth-panel">
                <span class="crm-kicker"><i class="fa-solid fa-user-shield"></i> CRM Sign In</span>
                <h2 class="section-title">${hasTestUsers ? 'Choose a local test user.' : 'Sign in to the CRM.'}</h2>
                <p class="panel-subtitle">${isCheckingSession ? 'Checking for an existing Supabase session in the background. You can still sign in now.' : (hasTestUsers ? 'Local test users are available in this browser.' : 'Use your Supabase CRM credentials to continue.')}</p>

                ${state.notice ? `
                    <div class="crm-alert crm-alert-${state.notice.kind}" style="margin-top: 1rem;">
                        <div>${escapeHtml(state.notice.message)}</div>
                        <button class="crm-button-ghost" data-action="dismiss-notice">Dismiss</button>
                    </div>
                ` : ''}

                ${hasTestUsers ? `
                    <div class="auth-user-grid">
                        ${users.map((user) => `
                            <article class="auth-user-card">
                                <div class="auth-user-head">
                                    <div>
                                        <div class="auth-user-name">${escapeHtml(user.name)}</div>
                                        <div class="panel-subtitle">${escapeHtml(user.title)}</div>
                                    </div>
                                    <span class="auth-user-role"><i class="fa-solid fa-badge-check"></i> ${escapeHtml(getRoleLabel(user.role))}${user.isActive === false ? ' · inactive' : ''}</span>
                                </div>
                                <div class="auth-user-meta">
                                    <div><strong>Email:</strong> ${escapeHtml(user.email)}</div>
                                    <div><strong>Password:</strong> ${escapeHtml(user.password)}</div>
                                </div>
                                <div class="auth-actions" style="margin-top: 1rem;">
                                    <button class="crm-button" data-action="quick-login" data-user-id="${escapeHtml(user.id)}" ${user.isActive === false ? 'disabled' : ''}>
                                        <i class="fa-solid fa-arrow-right-to-bracket"></i> Login as ${escapeHtml(getRoleLabel(user.role))}
                                    </button>
                                </div>
                            </article>
                        `).join('')}
                    </div>
                ` : ''}

                <form id="login-form">
                    <div class="form-grid">
                        <label class="form-field">
                            <span class="form-label">Email</span>
                            <input class="crm-input" type="email" name="email" placeholder="rep@example.com" required ${isAuthenticating ? 'disabled' : ''}>
                        </label>
                        <label class="form-field">
                            <span class="form-label">Password</span>
                            <input class="crm-input" type="password" name="password" placeholder="Enter your CRM password" required ${isAuthenticating ? 'disabled' : ''}>
                        </label>
                    </div>

                    <div class="auth-actions" style="margin-top: 1rem;">
                        <button class="crm-button-secondary" type="submit" ${isAuthenticating ? 'disabled' : ''}>
                            <i class="fa-solid ${isAuthenticating ? 'fa-spinner fa-spin' : 'fa-key'}"></i> ${state.authSubmitting ? 'Signing in...' : 'Login with credentials'}
                        </button>
                    </div>
                </form>
            </section>
        </div>
    `;
}

async function handleAuthStateChange({ event, session, authUser, profile, error }) {
    if (error) {
        state.session = null;
        state.authUser = null;
        state.profile = null;
        resetAuthenticatedCrmState();
        state.authResolved = true;
        flashNotice(error.message || 'Unable to resolve the CRM session.', 'error');
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

    if (!workspace.loaded && !workspace.isLoading) {
        return getPaginatedClients(getVisibleClients(scope));
    }

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

    return getScopedClients(scope, options).length;
}

async function refreshWorkspacePage(scope = getDefaultScopeForView(), { renderWhileLoading = true } = {}) {
    if (!supportsServerWorkspacePaging() || !state.session) {
        return;
    }

    const normalizedScope = scope === 'members' ? 'members' : 'leads';
    const workspace = getWorkspaceResult(normalizedScope);
    const activeFilterGroup = document.activeElement?.matches?.('.filter-token-input')
        ? document.activeElement.dataset.filterGroup
        : '';
    const requestId = workspace.requestId + 1;

    workspace.requestId = requestId;
    workspace.isLoading = true;

    if (renderWhileLoading) {
        renderPanels();
    }

    try {
        if (state.clients.length && (state.clientCacheMode === 'light' || state.clientCacheMode === 'full')) {
            const visibleClients = getVisibleClients(normalizedScope);
            const totalPages = Math.max(1, Math.ceil(visibleClients.length / state.pageSize));

            if (visibleClients.length > 0 && state.page > totalPages) {
                state.page = totalPages;
            }

            const paginatedClients = getPaginatedClients(visibleClients);
            const notesByLeadId = typeof dataService.listLatestNotesByLeadIds === 'function' && paginatedClients.length
                ? await dataService.listLatestNotesByLeadIds(paginatedClients.map((client) => client.id))
                : new Map();

            if (workspace.requestId !== requestId) {
                return;
            }

            const hydratedRows = paginatedClients.map((client) => {
                const noteHistory = notesByLeadId.get(client.id) || client.noteHistory || [];

                return {
                    ...client,
                    notes: noteHistory[0]?.content || client.notes || '',
                    noteHistory
                };
            });

            workspace.rows = hydratedRows;
            workspace.totalCount = visibleClients.length;
            workspace.loaded = true;
            mergeClientCache(hydratedRows);
            return;
        }

        const result = await dataService.listClientsPage({
            scope: normalizedScope,
            page: state.page,
            pageSize: state.pageSize,
            search: state.search,
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
        renderSidebar();
        renderPanels();

        if (activeFilterGroup) {
            focusFilterInput(activeFilterGroup);
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

function renderSidebar() {
    const totalLeads = getWorkspaceDisplayCount('leads', { ignoreSearch: true, ignoreFilters: true });
    const totalMembers = getWorkspaceDisplayCount('members', { ignoreSearch: true, ignoreFilters: true });
    const totalImports = state.importHistory.length;
    const items = [
        { view: 'overview', icon: 'fa-chart-line', label: 'Overview', meta: `${totalLeads} leads / ${totalMembers} members` },
        { view: 'clients', icon: 'fa-address-book', label: 'Leads', meta: `${getWorkspaceDisplayCount('leads').toLocaleString()} visible leads` },
        { view: 'members', icon: 'fa-users-viewfinder', label: 'Members', meta: `${getWorkspaceDisplayCount('members').toLocaleString()} visible members` },
        hasActiveAdminProfile()
            ? { view: 'admin', icon: 'fa-shield-halved', label: 'Admin', meta: 'Assignments, reps, and control tools' }
            : null,
        hasPermission(state.session, PERMISSIONS.IMPORT_LEADS)
            ? { view: 'imports', icon: 'fa-file-arrow-up', label: 'Import', meta: `${totalImports} import events` }
            : null,
        { view: 'settings', icon: 'fa-sliders', label: 'Settings', meta: 'Workspace preferences and local tools' }
    ].filter(Boolean);

    refs.sidebar.innerHTML = `
        <div class="crm-brand">
            <div class="crm-brand-row">
                <img src="../assets/images/Crest logo.png" alt="Blue Chip Signals logo">
                <div>
                    <div class="crm-brand-title">Blue Chip CRM</div>
                    <div class="panel-subtitle">Lead workspace prototype</div>
                </div>
            </div>
            <div class="crm-brand-copy">
                Separate from the public site, styled with Blue Chip Signals tokens, and now shaped around Leads, Members, and sales workflows.
            </div>
        </div>

        <div class="crm-nav" role="navigation" aria-label="CRM navigation">
            ${items.map((item) => `
                <button
                    class="crm-nav-button ${state.currentView === item.view ? 'active' : ''}"
                    data-action="set-view"
                    data-view="${item.view}"
                >
                    <span class="crm-nav-copy">
                        <span class="crm-nav-label"><i class="fa-solid ${item.icon}"></i> ${item.label}</span>
                        <span class="crm-nav-meta">${escapeHtml(item.meta)}</span>
                    </span>
                    <i class="fa-solid fa-chevron-right"></i>
                </button>
            `).join('')}
        </div>

        <div class="crm-sidebar-footer">
            <div><strong>Session:</strong> ${escapeHtml(state.session.name)}</div>
            <div><strong>Role:</strong> ${escapeHtml(getRoleLabel(state.session.role))}</div>
            <div class="panel-subtitle" style="margin-top: 0.5rem;">${hasActiveAdminProfile() ? 'Admin controls and exports are enabled in this Supabase-backed session.' : 'Sales permissions are limited to practical lead workflow updates.'}</div>
        </div>
    `;
}

function renderTopbar() {
    const activeFilterCount = getActiveFilterCount();

    refs.topbar.innerHTML = `
        <div class="crm-toolbar">
            <button class="crm-mobile-toggle" data-action="toggle-sidebar" aria-label="Toggle CRM navigation">
                <i class="fa-solid fa-bars"></i>
            </button>

            <label class="search-shell">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input
                    id="global-search"
                    class="crm-search"
                    type="search"
                    placeholder="Search by first name, last name, full name, email, or phone"
                    value="${escapeHtml(state.search)}"
                >
            </label>

            <div class="toolbar-actions">
                ${hasPermission(state.session, PERMISSIONS.IMPORT_LEADS) ? `
                    <button class="crm-button-secondary" data-action="open-import">
                        <i class="fa-solid fa-file-arrow-up"></i> Upload Leads
                    </button>
                ` : ''}
                <button class="crm-button-ghost" data-action="open-filters">
                    <i class="fa-solid fa-filter"></i> Filters${activeFilterCount ? ` (${activeFilterCount})` : ''}
                </button>
                <button class="crm-button-ghost" data-action="new-client">
                    <i class="fa-solid fa-user-plus"></i> New Lead
                </button>
                ${hasPermission(state.session, PERMISSIONS.EXPORT_LEADS) ? `
                    <button class="crm-button-ghost" data-action="export-clients">
                        <i class="fa-solid fa-file-export"></i> Export Leads
                    </button>
                ` : ''}
                <span class="role-badge"><i class="fa-solid fa-user-gear"></i> ${escapeHtml(getRoleLabel(state.session.role))}</span>
                <button class="crm-button-ghost" data-action="logout">
                    <i class="fa-solid fa-right-from-bracket"></i> Logout
                </button>
            </div>
        </div>

        ${state.notice ? `
            <div class="crm-alert crm-alert-${state.notice.kind}">
                <div>${escapeHtml(state.notice.message)}</div>
                <button class="crm-button-ghost" data-action="dismiss-notice">Dismiss</button>
            </div>
        ` : ''}
    `;
}

function renderPanels() {
    const panels = {
        overview: refs.overviewPanel,
        clients: refs.clientsPanel,
        members: refs.membersPanel,
        admin: refs.adminPanel,
        'lead-detail': refs.leadDetailPanel,
        imports: refs.importsPanel,
        settings: refs.settingsPanel
    };

    Object.entries(panels).forEach(([view, panel]) => {
        panel.classList.toggle('hidden', view !== state.currentView);
    });

    if (state.currentView === 'overview') {
        refs.overviewPanel.innerHTML = renderOverviewPanel();
    }

    if (state.currentView === 'clients') {
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
        return renderLoadingState('Loading CRM dashboard...');
    }

    if (!state.clients.length) {
        return renderEmptyState({
            title: 'No lead data yet',
            copy: 'Import a CSV, create a lead manually, or restore the sample dataset to explore the CRM workflow.',
            actions: `
                ${hasPermission(state.session, PERMISSIONS.IMPORT_LEADS) ? '<button class="crm-button-secondary" data-action="open-import"><i class="fa-solid fa-file-arrow-up"></i> Upload Leads</button>' : ''}
                ${hasPermission(state.session, PERMISSIONS.MANAGE_SETTINGS) ? '<button class="crm-button-ghost" data-action="restore-sample-data"><i class="fa-solid fa-sparkles"></i> Restore sample data</button>' : ''}
            `
        });
    }

    const metrics = getDashboardMetrics();

    return `
        <div class="overview-grid">
            <div class="panel-grid">
                <section class="crm-card">
                    <div class="panel-head">
                        <div>
                            <span class="crm-kicker"><i class="fa-solid fa-bolt"></i> Dashboard</span>
                            <h1 class="section-title">Sales operations, connected.</h1>
                            <p class="panel-copy">
                                This prototype keeps the CRM visually distinct from the marketing site while reusing Blue Chip Signals design tokens and typography.
                            </p>
                        </div>
                        <div class="row-actions">
                            <span class="summary-chip"><i class="fa-solid fa-database"></i> Supabase</span>
                            <span class="summary-chip"><i class="fa-solid fa-route"></i> Future route: /crm</span>
                            <span class="summary-chip"><i class="fa-solid fa-id-badge"></i> Leads + Members</span>
                        </div>
                    </div>
                </section>

                <div class="summary-grid">
                    <article class="crm-summary-card">
                        <div class="crm-summary-label">Total leads</div>
                        <div class="crm-summary-value">${metrics.totalLeads.toLocaleString()}</div>
                        <div class="crm-summary-meta">Across the active lead workspace.</div>
                    </article>
                    <article class="crm-summary-card">
                        <div class="crm-summary-label">Members</div>
                        <div class="crm-summary-value">${metrics.totalMembers.toLocaleString()}</div>
                        <div class="crm-summary-meta">Leads moved into the Members section.</div>
                    </article>
                    <article class="crm-summary-card">
                        <div class="crm-summary-label">Top status</div>
                        <div class="crm-summary-value">${escapeHtml(metrics.topStatus.label)}</div>
                        <div class="crm-summary-meta">${metrics.topStatus.count.toLocaleString()} leads in the leading stage.</div>
                    </article>
                    <article class="crm-summary-card">
                        <div class="crm-summary-label">Top tag</div>
                        <div class="crm-summary-value">${escapeHtml(metrics.topTag.label)}</div>
                        <div class="crm-summary-meta">${metrics.topTag.count.toLocaleString()} leads grouped under the strongest tag.</div>
                    </article>
                </div>

                <section class="crm-card">
                    <div class="panel-head">
                        <div>
                            <h2 class="section-title">Leads by tag</h2>
                            <p class="panel-copy">Quick view of the tags shaping the current lead list.</p>
                        </div>
                    </div>
                    <div class="tag-cloud">
                        ${metrics.tagCounts.slice(0, 10).map(([tag, count]) => `
                            <span class="tag-chip"><strong>${escapeHtml(tag)}</strong> ${count.toLocaleString()}</span>
                        `).join('') || '<span class="panel-subtitle">No tags available yet.</span>'}
                    </div>
                </section>
            </div>

            <div class="panel-grid">
                <section class="crm-card">
                    <div class="panel-head">
                        <div>
                            <h2 class="section-title">Leads by status</h2>
                            <p class="panel-copy">Where the current pipeline sits inside the prototype.</p>
                        </div>
                    </div>
                    <ul class="metric-list">
                        ${metrics.statusCounts.map(([status, count]) => `
                            <li>
                                <span class="status-pill ${escapeHtml(status)}">${escapeHtml(status)}</span>
                                <strong>${count.toLocaleString()}</strong>
                            </li>
                        `).join('')}
                    </ul>
                </section>

                <section class="crm-card">
                    <div class="panel-head">
                        <div>
                            <h2 class="section-title">Recently updated</h2>
                            <p class="panel-copy">The latest leads touched in this browser.</p>
                        </div>
                    </div>
                    <ul class="mini-list">
                        ${metrics.recentlyUpdated.map((client) => `
                            <li>
                                <div class="mini-list-main">
                                    <span class="mini-list-title">${escapeHtml(client.fullName || 'Unnamed lead')}</span>
                                    <span class="mini-list-meta">${escapeHtml(client.email || client.phone || 'No contact info')}</span>
                                </div>
                                <span class="summary-chip">${escapeHtml(formatDateTime(client.updatedAt))}</span>
                            </li>
                        `).join('')}
                    </ul>
                </section>
            </div>
        </div>
    `;
}

function renderClientsPanel(scope = 'leads') {
    const workspace = getWorkspaceResult(scope);
    const usingServerPaging = supportsServerWorkspacePaging();

    if (state.isLoading || (usingServerPaging && workspace.isLoading && !workspace.loaded)) {
        return renderLoadingState(`Loading ${scope === 'members' ? 'members' : 'leads'}...`);
    }

    const visibleClients = usingServerPaging ? workspace.rows : getVisibleClients(scope);
    const paginatedClients = usingServerPaging ? workspace.rows : getPaginatedClients(visibleClients);
    const totalVisibleCount = usingServerPaging ? workspace.totalCount : visibleClients.length;
    const totalPages = Math.max(1, Math.ceil(totalVisibleCount / state.pageSize));
    const pageStart = totalVisibleCount && paginatedClients.length ? ((state.page - 1) * state.pageSize) + 1 : 0;
    const pageEnd = totalVisibleCount && paginatedClients.length ? Math.min((state.page - 1) * state.pageSize + paginatedClients.length, totalVisibleCount) : 0;
    const activeFilterCount = getActiveFilterCount();
    const savedFilters = getVisibleSavedFilters();
    const workspaceLabel = scope === 'members' ? 'Members' : 'Leads';
    const singularLabel = scope === 'members' ? 'member' : 'lead';
    const activeSavedFilter = state.savedFilters.find((filter) => filter.id === state.activeSavedFilterId) || null;
    const canBulkAssign = scope === 'leads' && hasPermission(state.session, PERMISSIONS.ASSIGN_LEADS);
    const selectedLeadIds = new Set(state.selectedLeadIds);
    const allPageSelected = canBulkAssign
        && Boolean(paginatedClients.length)
        && paginatedClients.every((client) => selectedLeadIds.has(client.id));
    const selectedCount = state.selectedLeadIds.length;

    return `
        <div class="workspace-layout ${state.filtersPanelOpen ? 'filters-visible' : ''}">
            ${state.filtersPanelOpen ? renderInlineFiltersPanel(workspaceLabel, savedFilters, activeSavedFilter) : ''}

            <div class="panel-grid">
                <section class="crm-card">
                    <div class="panel-head">
                        <div>
                            <span class="crm-kicker"><i class="fa-solid fa-address-book"></i> ${workspaceLabel} workspace</span>
                            <h1 class="section-title">${workspaceLabel} table with compact filters.</h1>
                            <p class="panel-copy">
                                ${totalVisibleCount.toLocaleString()} matching ${workspaceLabel.toLowerCase()}${state.search ? ` while search is set to “${escapeHtml(state.search)}”` : ''}.
                                ${activeFilterCount ? ` ${activeFilterCount} active filters are applied.` : ' Filters stay tucked away until you need them.'}
                            </p>
                        </div>
                        <div class="row-actions">
                            <label class="page-size-shell">
                                <span class="panel-subtitle">Page size</span>
                                <select id="page-size" class="crm-select">
                                    ${[25, 50, 100, 250].map((size) => `
                                        <option value="${size}" ${state.pageSize === size ? 'selected' : ''}>${size}</option>
                                    `).join('')}
                                </select>
                            </label>
                            ${activeSavedFilter ? `<span class="metric-chip"><i class="fa-solid fa-bookmark"></i> ${escapeHtml(activeSavedFilter.name)}</span>` : ''}
                            <button class="crm-button-ghost" data-action="open-filters">
                                <i class="fa-solid fa-filter"></i> ${state.filtersPanelOpen ? 'Hide filters' : 'Show filters'}${activeFilterCount ? ` (${activeFilterCount})` : ''}
                            </button>
                            <button class="crm-button-secondary" data-action="new-client"><i class="fa-solid fa-user-plus"></i> New Lead</button>
                        </div>
                    </div>

                    <div class="saved-filter-row">
                        <div class="saved-filter-strip">
                            ${savedFilters.length ? savedFilters.slice(0, 6).map((filter) => `
                                <button
                                    class="saved-filter-chip ${state.activeSavedFilterId === filter.id ? 'active' : ''}"
                                    data-action="load-saved-filter"
                                    data-filter-id="${filter.id}"
                                >
                                    <i class="fa-solid ${filter.visibility === 'shared' ? 'fa-users' : 'fa-lock'}"></i>
                                    ${escapeHtml(filter.name)}
                                </button>
                            `).join('') : '<span class="panel-subtitle">No saved filters yet.</span>'}
                        </div>
                    </div>
                </section>

                <section class="crm-table-card">
                    <div class="table-head">
                        <div>
                            <span class="crm-kicker"><i class="fa-solid fa-table"></i> ${workspaceLabel} table</span>
                            <h2 class="section-title">Sort, search, filter, and work the list.</h2>
                            <p class="table-copy">
                                Showing ${pageStart ? `${pageStart}-${pageEnd}` : '0'} of ${totalVisibleCount.toLocaleString()} filtered ${workspaceLabel.toLowerCase()}.
                            </p>
                        </div>
                        ${canBulkAssign ? `
                            <div class="row-actions bulk-toolbar">
                                <span class="metric-chip"><i class="fa-solid fa-check-double"></i> ${selectedCount} selected</span>
                                <button class="crm-button-ghost" data-action="select-visible-leads" ${paginatedClients.length ? '' : 'disabled'}>
                                    <i class="fa-solid fa-layer-group"></i> Select visible
                                </button>
                                <button class="crm-button-ghost" data-action="clear-lead-selection" ${selectedCount ? '' : 'disabled'}>
                                    <i class="fa-solid fa-xmark"></i> Clear selection
                                </button>
                                <select id="bulk-assignee" class="crm-select">
                                    <option value="">Choose sales rep</option>
                                    ${getSalesUsers().map((user) => `
                                        <option value="${escapeHtml(user.id)}" ${state.bulkAssignRepId === user.id ? 'selected' : ''}>${escapeHtml(user.name)}</option>
                                    `).join('')}
                                </select>
                                <button class="crm-button-secondary" data-action="bulk-assign-selected" ${selectedCount && state.bulkAssignRepId ? '' : 'disabled'}>
                                    <i class="fa-solid fa-user-check"></i> Assign
                                </button>
                                <button class="crm-button-ghost" data-action="bulk-unassign-selected" ${selectedCount ? '' : 'disabled'}>
                                    <i class="fa-solid fa-user-slash"></i> Unassign
                                </button>
                            </div>
                        ` : ''}
                    </div>

                    ${visibleClients.length ? `
                        <div class="table-shell">
                            <table class="crm-table">
                                <thead>
                                    <tr>
                                        ${renderTableHeaders({ canBulkAssign, allPageSelected })}
                                    </tr>
                                </thead>
                                <tbody>
                                    ${paginatedClients.map((client) => `
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
                                            <td>
                                                <button class="lead-link-button" data-action="open-lead-page" data-client-id="${client.id}">
                                                    ${escapeHtml(client.fullName || `Unnamed ${singularLabel}`)}
                                                </button><br>
                                                <span class="panel-subtitle">${escapeHtml(buildClientMetaLine(client))}</span>
                                            </td>
                                            <td>${escapeHtml(client.email || '—')}</td>
                                            <td>${escapeHtml(client.phone || '—')}</td>
                                            <td>${client.tags.length ? client.tags.slice(0, 3).map((tag) => `<span class="tag-chip"><strong>${escapeHtml(tag)}</strong></span>`).join(' ') : '—'}</td>
                                            <td><div class="notes-preview">${escapeHtml(truncate(client.notes || 'No notes yet.', 96))}</div></td>
                                            <td><span class="status-pill ${escapeHtml(client.status)}">${escapeHtml(client.status)}</span></td>
                                            <td>${escapeHtml(formatDateTime(client.updatedAt))}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>

                        <div class="pagination-row">
                            <div>
                                Showing ${pageStart ? `${pageStart}-${pageEnd}` : '0'} of ${totalVisibleCount.toLocaleString()} visible ${workspaceLabel.toLowerCase()}.
                            </div>
                            <div class="row-actions">
                                <button class="crm-button-ghost" data-action="prev-page" ${state.page === 1 ? 'disabled' : ''}>
                                    <i class="fa-solid fa-arrow-left"></i> Previous
                                </button>
                                <span class="summary-chip">Page ${state.page} of ${totalPages}</span>
                                <button
                                    class="crm-button-ghost"
                                    data-action="next-page"
                                    ${state.page >= totalPages ? 'disabled' : ''}
                                >
                                    Next <i class="fa-solid fa-arrow-right"></i>
                                </button>
                            </div>
                        </div>
                    ` : renderEmptyState({
                        title: `No ${workspaceLabel.toLowerCase()} match the current filters`,
                        copy: `Clear one or more filter groups, change the search term, or add a new ${singularLabel} manually.`,
                        actions: `
                            <button class="crm-button-ghost" data-action="clear-client-filters"><i class="fa-solid fa-rotate-left"></i> Clear all filters</button>
                            <button class="crm-button-secondary" data-action="new-client"><i class="fa-solid fa-user-plus"></i> Add lead</button>
                        `
                    })}
                </section>
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
                ? 'The selected lead is no longer available in the current local dataset.'
                : 'That lead is not assigned to your session or is no longer available.',
            actions: '<button class="crm-button-ghost" data-action="back-to-list"><i class="fa-solid fa-arrow-left"></i> Back to list</button>'
        });
    }

    const detailScope = state.lastWorkspaceView === 'members' ? 'members' : 'leads';
    const visibleSet = getVisibleClients(detailScope);
    const currentIndex = visibleSet.findIndex((item) => item.id === lead.id);
    const previousLead = currentIndex > 0 ? visibleSet[currentIndex - 1] : null;
    const nextLead = currentIndex >= 0 && currentIndex < visibleSet.length - 1 ? visibleSet[currentIndex + 1] : null;
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
    const leadHistoryEntries = getLeadHistoryEntries(lead);
    const dispositionOptions = getLeadDetailDispositionOptions(lead);
    const showToSeniorRepField = isToDispositionValue(lead.disposition);
    const selectedToSeniorRepId = showToSeniorRepField && seniorRepOptions.some((user) => user.id === lead.assignedRepId)
        ? lead.assignedRepId
        : '';

    return `
        <div class="panel-grid lead-detail-shell">
            <section class="crm-card lead-summary-card">
                <div class="panel-head">
                    <div>
                        <span class="crm-kicker"><i class="fa-solid fa-user-large"></i> Lead detail</span>
                        <h1 class="section-title">${escapeHtml(lead.fullName || 'Unnamed lead')}</h1>
                        <p class="panel-copy">${escapeHtml(buildLeadDetailSummary(lead))}</p>
                        <div class="row-actions" style="margin-top: 0.75rem;">
                            <span class="summary-chip"><i class="fa-solid fa-user-check"></i> ${escapeHtml(lead.assignedTo || 'Unassigned')}</span>
                            <span class="summary-chip"><i class="fa-solid fa-layer-group"></i> ${escapeHtml(titleCase(lead.lifecycleType || 'lead'))}</span>
                            <span class="summary-chip"><i class="fa-solid fa-signal"></i> ${escapeHtml(lead.subscriptionType || 'No subscription')}</span>
                            <span class="summary-chip"><i class="fa-solid fa-clock"></i> ${escapeHtml(lead.timeZone || 'Unknown')}</span>
                            ${lead.timezoneOverridden ? '<span class="summary-chip"><i class="fa-solid fa-wand-magic-sparkles"></i> Manual override</span>' : ''}
                        </div>
                    </div>
                    <div class="row-actions">
                        <button class="crm-button-ghost" data-action="back-to-list"><i class="fa-solid fa-arrow-left"></i> Back to ${state.lastWorkspaceView === 'members' ? 'Members' : 'Leads'}</button>
                        ${canOpenEditMode ? `
                            <button class="crm-button-ghost" data-action="${isEditing ? 'cancel-lead-edit' : 'toggle-lead-edit'}">
                                <i class="fa-solid ${isEditing ? 'fa-xmark' : 'fa-pen'}"></i> ${isEditing ? 'Cancel Edit' : 'Edit'}
                            </button>
                        ` : ''}
                        <button class="crm-button-ghost" data-action="toggle-lead-history">
                            <i class="fa-solid fa-timeline"></i> ${state.leadHistoryOpen ? 'Hide Lead History' : 'Lead History'}
                        </button>
                        <button class="crm-button-ghost" data-action="navigate-lead" data-direction="prev" ${previousLead ? '' : 'disabled'}><i class="fa-solid fa-chevron-left"></i> Previous</button>
                        <button class="crm-button-ghost" data-action="navigate-lead" data-direction="next" ${nextLead ? '' : 'disabled'}>Next <i class="fa-solid fa-chevron-right"></i></button>
                    </div>
                </div>
            </section>

            <div class="lead-detail-layout ${state.leadHistoryOpen ? 'history-visible' : ''}">
                <div class="panel-grid">
                    <section class="crm-card">
                    <form id="lead-detail-form">
                        <input type="hidden" name="id" value="${escapeHtml(lead.id)}">
                        ${isEditing && canAdminEdit ? '' : `<input type="hidden" name="assignedRepId" value="${escapeHtml(lead.assignedRepId || '')}">`}
                        <input type="hidden" name="assignedTo" value="${escapeHtml(lead.assignedTo || '')}">
                        <input type="hidden" name="lifecycleType" value="${escapeHtml(lead.lifecycleType || 'lead')}">

                        <div class="form-grid">
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

                        <div class="drawer-actions" style="margin-top: 1rem;">
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

                    <section class="crm-card">
                        <div class="panel-head">
                            <div>
                                <h2 class="section-title">Notes</h2>
                                <p class="panel-copy">Use Save Notes to add or update timestamped conversation history without leaving the page.</p>
                            </div>
                        </div>

                        ${canSaveNotes ? `
                            <form id="lead-note-form" style="margin-top: 1rem;">
                                <input type="hidden" name="leadId" value="${escapeHtml(lead.id)}">
                                <input type="hidden" name="noteId" value="${escapeHtml(editableNote?.id || '')}">
                                <label class="form-field form-field-full">
                                    <span class="form-label">${editableNote ? 'Edit note' : 'New note'}</span>
                                    <textarea class="crm-textarea" name="noteEntry" placeholder="Add the latest call summary, objection, or follow-up context...">${escapeHtml(editableNote?.content || '')}</textarea>
                                </label>
                                <div class="drawer-actions" style="margin-top: 1rem;">
                                    <button class="crm-button-secondary" type="submit"><i class="fa-solid fa-note-sticky"></i> Save Notes</button>
                                    ${editableNote ? `
                                        <button class="crm-button-ghost" type="button" data-action="cancel-note-edit">
                                            <i class="fa-solid fa-xmark"></i> Cancel note edit
                                        </button>
                                    ` : ''}
                                </div>
                            </form>
                        ` : '<div class="panel-subtitle" style="margin-top: 1rem;">This session can view note history but cannot add new entries.</div>'}

                        ${noteHistory.length ? `
                            <div class="history-list">
                                ${noteHistory.map((entry) => `
                                    <article class="history-card">
                                        <div class="history-head">
                                            <div>
                                                <div class="history-title">${escapeHtml(entry.createdByName || entry.createdByUserId || 'Local user')}</div>
                                                <div class="panel-subtitle">${escapeHtml(formatDateTime(entry.createdAt))}</div>
                                            </div>
                                            ${canEditNoteEntry(state.session, lead, entry) ? `
                                                <button class="crm-button-ghost" type="button" data-action="edit-note-entry" data-note-id="${entry.id}">
                                                    <i class="fa-solid fa-pen"></i> Edit
                                                </button>
                                            ` : ''}
                                        </div>
                                        <div class="note-history-copy">${escapeHtml(entry.content)}</div>
                                        ${entry.updatedAt ? `<div class="panel-subtitle" style="margin-top: 0.75rem;">Last edited ${escapeHtml(formatDateTime(entry.updatedAt))} by ${escapeHtml(entry.updatedByName || entry.updatedByUserId || 'Local user')}</div>` : ''}
                                        ${entry.versions?.length ? `
                                            <div class="history-sublist">
                                                <div class="panel-subtitle">Prior versions</div>
                                                ${entry.versions.map((version) => `
                                                    <div class="history-version">
                                                        <div class="history-version-meta">${escapeHtml(formatDateTime(version.changedAt))} · ${escapeHtml(version.changedByName || version.changedByUserId || 'Local user')}</div>
                                                        <div class="note-history-copy">${escapeHtml(version.content)}</div>
                                                    </div>
                                                `).join('')}
                                            </div>
                                        ` : ''}
                                    </article>
                                `).join('')}
                            </div>
                        ` : '<div class="panel-subtitle" style="margin-top: 1rem;">No saved note history yet for this lead.</div>'}
                    </section>

                    <section class="crm-card">
                        <div class="panel-head">
                            <div>
                                <h2 class="section-title">Lead profile</h2>
                                <p class="panel-copy">Key calling and ownership context without duplicating the main edit form.</p>
                            </div>
                        </div>
                        <ul class="mini-list">
                            <li><span class="mini-list-title">Email</span><span class="mini-list-meta">${escapeHtml(lead.email || '—')}</span></li>
                            <li><span class="mini-list-title">Phone</span><span class="mini-list-meta">${escapeHtml(lead.phone || '—')}</span></li>
                            <li><span class="mini-list-title">Subscription</span><span class="mini-list-meta">${escapeHtml(lead.subscriptionType || '—')}</span></li>
                            <li><span class="mini-list-title">Time zone</span><span class="mini-list-meta">${escapeHtml(lead.timeZone || '—')}</span></li>
                            <li><span class="mini-list-title">Assigned rep</span><span class="mini-list-meta">${escapeHtml(lead.assignedTo || 'Unassigned')}</span></li>
                            <li><span class="mini-list-title">Disposition</span><span class="mini-list-meta">${escapeHtml(lead.disposition || '—')}</span></li>
                            <li><span class="mini-list-title">Follow up</span><span class="mini-list-meta">${escapeHtml(lead.followUpAction || lead.followUpAt || '—')}</span></li>
                            <li><span class="mini-list-title">Status</span><span class="mini-list-meta">${escapeHtml(titleCase(lead.status || 'new'))}</span></li>
                            <li><span class="mini-list-title">Created</span><span class="mini-list-meta">${escapeHtml(formatDateTime(lead.createdAt))}</span></li>
                            <li><span class="mini-list-title">Updated</span><span class="mini-list-meta">${escapeHtml(formatDateTime(lead.updatedAt))}</span></li>
                        </ul>
                    </section>
                </div>

                ${state.leadHistoryOpen ? `
                    <aside class="crm-card lead-history-panel">
                        <div class="panel-head">
                            <div>
                                <h2 class="section-title">Lead History</h2>
                                <p class="panel-copy">Read-only audit trail from Supabase, newest first.</p>
                            </div>
                        </div>
                        ${leadHistoryEntries.length ? `
                            <div class="history-list">
                                ${leadHistoryEntries.map((entry) => `
                                    <article class="history-card">
                                        <div class="history-head">
                                            <div>
                                                <div class="history-title">${escapeHtml(entry.fieldName || entry.fieldLabel || 'unknown')}</div>
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
                        ` : '<div class="panel-subtitle">No lead history exists for this lead yet.</div>'}
                    </aside>
                ` : ''}
            </div>
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

function renderAdminPanel() {
    if (!hasActiveAdminProfile()) {
        return renderEmptyState({
            title: 'Admin access required',
            copy: 'This control area is available only to active admin profiles from Supabase.',
            actions: '<button class="crm-button-ghost" data-action="set-view" data-view="clients"><i class="fa-solid fa-arrow-left"></i> Back to Leads</button>'
        });
    }

    const adminMetrics = getAdminMetrics();
    const salesUsers = getSalesUsers();
    const editingTagDefinition = state.tagDefinitions.find((definition) => definition.id === state.editingTagDefinitionId) || null;
    const editingDispositionDefinition = state.dispositionDefinitions.find((definition) => definition.id === state.editingDispositionDefinitionId) || null;

    return `
        <div class="panel-grid">
            <section class="crm-card">
                <div class="panel-head">
                    <div>
                        <span class="crm-kicker"><i class="fa-solid fa-shield-halved"></i> Admin workspace</span>
                        <h1 class="section-title">Control the CRM prototype.</h1>
                        <p class="panel-copy">Manage reps, assignments, lead distribution, members, and workspace activity without leaving the current CRM shell.</p>
                    </div>
                </div>
            </section>

            <div class="summary-grid">
                <article class="crm-summary-card"><div class="crm-summary-label">Total leads</div><div class="crm-summary-value">${adminMetrics.totalLeads}</div><div class="crm-summary-meta">Default lead workspace count.</div></article>
                <article class="crm-summary-card"><div class="crm-summary-label">Total members</div><div class="crm-summary-value">${adminMetrics.totalMembers}</div><div class="crm-summary-meta">Leads moved into Members.</div></article>
                <article class="crm-summary-card"><div class="crm-summary-label">Assigned vs unassigned</div><div class="crm-summary-value">${adminMetrics.assignedLeads}/${adminMetrics.unassignedLeads}</div><div class="crm-summary-meta">Assigned leads versus unassigned leads.</div></article>
                <article class="crm-summary-card"><div class="crm-summary-label">Follow-ups due</div><div class="crm-summary-value">${adminMetrics.followUpsDue}</div><div class="crm-summary-meta">Calling stats placeholder based on scheduled follow-up dates.</div></article>
            </div>

            <div class="overview-grid">
                <div class="panel-grid">
                    <section class="crm-card">
                        <div class="panel-head">
                            <div>
                                <h2 class="section-title">Leads by rep</h2>
                                <p class="panel-copy">Distribution across the current sales floor.</p>
                            </div>
                        </div>
                        <ul class="metric-list">
                            ${adminMetrics.leadsByRep.map(([repName, count]) => `
                                <li>
                                    <span class="mini-list-title">${escapeHtml(repName)}</span>
                                    <strong>${count}</strong>
                                </li>
                            `).join('')}
                        </ul>
                    </section>

                    <section class="crm-card">
                        <div class="panel-head">
                            <div>
                                <h2 class="section-title">Leads by status</h2>
                                <p class="panel-copy">Current pipeline shape for the lead workspace.</p>
                            </div>
                        </div>
                        <ul class="metric-list">
                            ${adminMetrics.leadsByStatus.map(([status, count]) => `
                                <li>
                                    <span class="status-pill ${escapeHtml(status)}">${escapeHtml(status)}</span>
                                    <strong>${count}</strong>
                                </li>
                            `).join('')}
                        </ul>
                    </section>
                </div>

                <div class="panel-grid">
                    <section class="crm-card">
                        <div class="panel-head">
                            <div>
                                <h2 class="section-title">Recent assignments</h2>
                                <p class="panel-copy">Latest assignment activity pulled from the lead activity logs.</p>
                            </div>
                        </div>
                        ${adminMetrics.recentAssignments.length ? `
                            <div class="history-list">
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
                        ` : '<div class="panel-subtitle">No assignment activity yet.</div>'}
                    </section>

                    <section class="crm-card">
                        <div class="panel-head">
                            <div>
                                <h2 class="section-title">Recent activity</h2>
                                <p class="panel-copy">Latest lead updates across the workspace.</p>
                            </div>
                        </div>
                        ${adminMetrics.recentActivity.length ? `
                            <div class="history-list">
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
                        ` : '<div class="panel-subtitle">No recent activity yet.</div>'}
                    </section>
                </div>
            </div>

            <section class="crm-card">
                <div class="panel-head">
                    <div>
                        <h2 class="section-title">Rep management</h2>
                        <p class="panel-copy">Edit or remove sales reps and senior reps stored in Supabase profiles.</p>
                    </div>
                </div>
                <div class="credentials-grid">
                    ${salesUsers.map((user) => `
                        <article class="auth-user-card" style="min-width: 260px;">
                            <div class="auth-user-head">
                                <div>
                                    <div class="auth-user-name">${escapeHtml(user.name)}</div>
                                    <div class="panel-subtitle">${escapeHtml(user.title || getRoleLabel(user.role))}</div>
                                </div>
                                <span class="status-pill ${user.isActive === false ? 'inactive' : 'qualified'}">${user.isActive === false ? 'inactive' : getRoleLabel(user.role)}</span>
                            </div>
                            <div class="auth-user-meta">
                                <div><strong>Email:</strong> ${escapeHtml(user.email)}</div>
                                <div><strong>Assigned leads:</strong> ${adminMetrics.leadsByRepMap.get(user.name) || 0}</div>
                                <div><strong>Role:</strong> ${escapeHtml(getRoleLabel(user.role))}</div>
                            </div>
                            <div class="row-actions" style="margin-top: 1rem;">
                                <button class="crm-button-ghost" data-action="open-user-form" data-user-id="${user.id}"><i class="fa-solid fa-pen"></i> Edit</button>
                                <button class="crm-button-danger" data-action="delete-user-account" data-user-id="${user.id}">
                                    <i class="fa-solid fa-trash"></i> Delete account
                                </button>
                            </div>
                        </article>
                    `).join('')}
                </div>
            </section>

            <div class="overview-grid">
                <section class="crm-card">
                    <div class="panel-head">
                        <div>
                            <h2 class="section-title">Tag catalog</h2>
                            <p class="panel-copy">Sales reps can only select active tags from this admin-managed list.</p>
                        </div>
                    </div>

                    <form id="tag-definition-form" style="margin-top: 1rem;">
                        <input type="hidden" name="id" value="${escapeHtml(editingTagDefinition?.id || '')}">
                        <div class="form-grid">
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
                        <div class="modal-actions" style="margin-top: 1rem;">
                            <button class="crm-button" type="submit"><i class="fa-solid fa-tags"></i> ${editingTagDefinition ? 'Update tag' : 'Add tag'}</button>
                            ${editingTagDefinition ? '<button class="crm-button-ghost" type="button" data-action="clear-tag-definition-edit">New tag</button>' : ''}
                        </div>
                    </form>

                    <div class="history-list">
                        ${state.tagDefinitions.length ? state.tagDefinitions.map((definition) => `
                            <article class="history-card">
                                <div class="history-head">
                                    <div>
                                        <div class="history-title">${escapeHtml(definition.label)}</div>
                                        <div class="panel-subtitle">${definition.isArchived ? 'Archived' : 'Active'}</div>
                                    </div>
                                    <span class="summary-chip">${state.clients.filter((client) => client.tags.includes(definition.label)).length} records</span>
                                </div>
                                <div class="row-actions" style="margin-top: 0.85rem;">
                                    <button class="crm-button-ghost" data-action="edit-tag-definition" data-definition-id="${definition.id}">
                                        <i class="fa-solid fa-pen"></i> Edit
                                    </button>
                                    <button class="crm-button-secondary" data-action="toggle-tag-archive" data-definition-id="${definition.id}">
                                        <i class="fa-solid fa-box-archive"></i> ${definition.isArchived ? 'Restore' : 'Archive'}
                                    </button>
                                    <button class="crm-button-danger" data-action="delete-tag-definition" data-definition-id="${definition.id}">
                                        <i class="fa-solid fa-trash"></i> Delete
                                    </button>
                                </div>
                            </article>
                        `).join('') : '<div class="panel-subtitle">No tags configured yet.</div>'}
                    </div>
                </section>

                <section class="crm-card">
                    <div class="panel-head">
                        <div>
                            <h2 class="section-title">Disposition catalog</h2>
                            <p class="panel-copy">Approved dispositions used in the lead workflow dropdown.</p>
                        </div>
                    </div>

                    <form id="disposition-definition-form" style="margin-top: 1rem;">
                        <input type="hidden" name="id" value="${escapeHtml(editingDispositionDefinition?.id || '')}">
                        <div class="form-grid">
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
                        <div class="modal-actions" style="margin-top: 1rem;">
                            <button class="crm-button" type="submit"><i class="fa-solid fa-list-check"></i> ${editingDispositionDefinition ? 'Update disposition' : 'Add disposition'}</button>
                            ${editingDispositionDefinition ? '<button class="crm-button-ghost" type="button" data-action="clear-disposition-definition-edit">New disposition</button>' : ''}
                        </div>
                    </form>

                    <div class="history-list">
                        ${state.dispositionDefinitions.length ? state.dispositionDefinitions.map((definition) => `
                            <article class="history-card">
                                <div class="history-head">
                                    <div>
                                        <div class="history-title">${escapeHtml(definition.label)}</div>
                                        <div class="panel-subtitle">${definition.isArchived ? 'Archived' : 'Active'}</div>
                                    </div>
                                </div>
                                <div class="row-actions" style="margin-top: 0.85rem;">
                                    <button class="crm-button-ghost" data-action="edit-disposition-definition" data-definition-id="${definition.id}">
                                        <i class="fa-solid fa-pen"></i> Edit
                                    </button>
                                    <button class="crm-button-secondary" data-action="toggle-disposition-archive" data-definition-id="${definition.id}">
                                        <i class="fa-solid fa-box-archive"></i> ${definition.isArchived ? 'Restore' : 'Archive'}
                                    </button>
                                    <button class="crm-button-danger" data-action="delete-disposition-definition" data-definition-id="${definition.id}">
                                        <i class="fa-solid fa-trash"></i> Delete
                                    </button>
                                </div>
                            </article>
                        `).join('') : '<div class="panel-subtitle">No dispositions configured yet.</div>'}
                    </div>
                </section>
            </div>

            <section class="crm-card">
                <div class="panel-head">
                    <div>
                        <h2 class="section-title">Calling stats placeholders</h2>
                        <p class="panel-copy">Lightweight operational counts powered by the current local audit data.</p>
                    </div>
                </div>
                <div class="overview-grid">
                    <div class="history-list compact-history">
                        <article class="history-card">
                            <div class="history-title">Note entries per rep</div>
                            <ul class="mini-list">
                                ${adminMetrics.noteEntriesByRep.slice(0, 5).map(([name, count]) => `
                                    <li><span class="mini-list-title">${escapeHtml(name)}</span><span class="mini-list-meta">${count}</span></li>
                                `).join('') || '<li><span class="mini-list-title">No note data yet</span><span class="mini-list-meta">0</span></li>'}
                            </ul>
                        </article>
                        <article class="history-card">
                            <div class="history-title">Leads touched per rep</div>
                            <ul class="mini-list">
                                ${adminMetrics.leadsTouchedByRep.slice(0, 5).map(([name, count]) => `
                                    <li><span class="mini-list-title">${escapeHtml(name)}</span><span class="mini-list-meta">${count}</span></li>
                                `).join('') || '<li><span class="mini-list-title">No activity yet</span><span class="mini-list-meta">0</span></li>'}
                            </ul>
                        </article>
                    </div>
                    <div class="history-list compact-history">
                        <article class="history-card">
                            <div class="history-title">Disposition changes per rep</div>
                            <ul class="mini-list">
                                ${adminMetrics.dispositionChangesByRep.slice(0, 5).map(([name, count]) => `
                                    <li><span class="mini-list-title">${escapeHtml(name)}</span><span class="mini-list-meta">${count}</span></li>
                                `).join('') || '<li><span class="mini-list-title">No disposition changes yet</span><span class="mini-list-meta">0</span></li>'}
                            </ul>
                        </article>
                        <article class="history-card">
                            <div class="history-title">Follow ups set per rep</div>
                            <ul class="mini-list">
                                ${adminMetrics.followUpsByRep.slice(0, 5).map(([name, count]) => `
                                    <li><span class="mini-list-title">${escapeHtml(name)}</span><span class="mini-list-meta">${count}</span></li>
                                `).join('') || '<li><span class="mini-list-title">No follow ups yet</span><span class="mini-list-meta">0</span></li>'}
                            </ul>
                        </article>
                    </div>
                </div>
            </section>
        </div>
    `;
}

function renderImportsPanel() {
    if (!hasPermission(state.session, PERMISSIONS.IMPORT_LEADS)) {
        return renderEmptyState({
            title: 'Admin access required',
            copy: 'Lead import tools are available only to admin users in the CRM prototype.',
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
                            Upload CSV files in the browser, map columns, review duplicates by email and phone, then import into IndexedDB.
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
                            <div class="empty-copy">Import history will appear here once you upload a CSV or use the sample data seed.</div>
                        </div>
                    </div>
                `}
            </section>

            <section class="crm-card">
                <div class="panel-head">
                    <div>
                        <h2 class="section-title">Import history</h2>
                        <p class="panel-copy">A local log of CSV imports and seeded demo data.</p>
                    </div>
                </div>

                ${state.importHistory.length ? `
                    <div class="history-list">
                        ${state.importHistory.map((entry) => `
                            <article class="history-card">
                                <div class="history-head">
                                    <div>
                                        <div class="history-title">${escapeHtml(entry.sourceFileName)}</div>
                                        <div class="panel-subtitle">${escapeHtml(entry.type === 'seed' ? 'System seed data' : 'CSV import')}</div>
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
                    copy: 'When you upload a CSV, the CRM will record a local summary here.',
                    actions: '<button class="crm-button-secondary" data-action="open-import"><i class="fa-solid fa-upload"></i> Upload CSV</button>'
                })}
            </section>
        </div>
    `;
}

function renderSettingsPanel() {
    const users = authService.getTestUsers();
    const leadCount = getScopedClients('leads', { ignoreSearch: true, ignoreFilters: true }).length;
    const memberCount = getScopedClients('members', { ignoreSearch: true, ignoreFilters: true }).length;
    const canManageSettings = hasPermission(state.session, PERMISSIONS.MANAGE_SETTINGS);

    return `
        <div class="settings-grid">
            <section class="crm-card">
                <div class="panel-head">
                    <div>
                        <span class="crm-kicker"><i class="fa-solid fa-gears"></i> Storage and controls</span>
                        <h1 class="section-title">Local-only tools for the prototype.</h1>
                        <p class="panel-copy">
                            Browser storage keeps this isolated from production infrastructure while preserving a clean swap path to a real API later.
                        </p>
                    </div>
                </div>

                <div class="meta-grid two-up" style="margin-top: 1rem;">
                    <div class="meta-list-item">
                        <i class="fa-solid fa-database"></i>
                        <div>
                            <strong>IndexedDB persistence</strong>
                            <div class="panel-subtitle">${leadCount.toLocaleString()} leads and ${memberCount.toLocaleString()} members are currently saved in this browser.</div>
                        </div>
                    </div>
                    <div class="meta-list-item">
                        <i class="fa-solid fa-layer-group"></i>
                        <div>
                            <strong>Repository abstraction</strong>
                            <div class="panel-subtitle">The UI talks to <span class="inline-code">CrmDataService</span>, not the browser database directly.</div>
                        </div>
                    </div>
                </div>

                <div class="settings-actions" style="margin-top: 1.2rem;">
                    ${hasPermission(state.session, PERMISSIONS.EXPORT_LEADS) ? '<button class="crm-button-secondary" data-action="export-clients"><i class="fa-solid fa-file-export"></i> Export CSV</button>' : ''}
                    ${canManageSettings ? '<button class="crm-button-ghost" data-action="restore-sample-data"><i class="fa-solid fa-sparkles"></i> Restore sample data</button>' : ''}
                </div>
                ${canManageSettings ? '' : '<div class="panel-subtitle" style="margin-top: 1rem;">Admin-only storage controls stay hidden for sales sessions.</div>'}
            </section>

            <section class="crm-card">
                <div class="panel-head">
                    <div>
                        <h2 class="section-title">Local test credentials</h2>
                        <p class="panel-copy">These are hardcoded only for local interface testing. No production auth is connected.</p>
                    </div>
                </div>

                <div class="credentials-grid">
                    ${users.map((user) => `
                        <div class="auth-user-card" style="min-width: 260px;">
                            <div class="auth-user-name">${escapeHtml(user.name)}</div>
                            <div class="panel-subtitle">${escapeHtml(user.title)}</div>
                            <div class="auth-user-meta">
                                <div><strong>Role:</strong> ${escapeHtml(getRoleLabel(user.role))}</div>
                                <div><strong>Email:</strong> ${escapeHtml(user.email)}</div>
                                <div><strong>Password:</strong> ${escapeHtml(user.password)}</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </section>

            <section class="crm-card">
                <div class="panel-head">
                    <div>
                        <h2 class="section-title">Future migration path</h2>
                        <p class="panel-copy">What changes when the prototype graduates to a real backend.</p>
                    </div>
                </div>

                <ul class="mini-list">
                    <li>
                        <div class="mini-list-main">
                            <span class="mini-list-title">Swap repositories</span>
                            <span class="mini-list-meta">Replace the IndexedDB repositories with API-backed classes that keep the same async methods.</span>
                        </div>
                    </li>
                    <li>
                        <div class="mini-list-main">
                            <span class="mini-list-title">Add real auth</span>
                            <span class="mini-list-meta">Replace the local auth service with the production auth provider and role checks.</span>
                        </div>
                    </li>
                    <li>
                        <div class="mini-list-main">
                            <span class="mini-list-title">Mount at /crm</span>
                            <span class="mini-list-meta">This module is already route-shaped so it can be moved into the main site cleanly later.</span>
                        </div>
                    </li>
                </ul>
            </section>

            <section class="crm-card">
                <div class="danger-box">
                    <div class="panel-head">
                        <div>
                            <h2 class="section-title">Danger zone</h2>
                            <p class="panel-copy">Clear all local CRM data from this browser. This also removes import history.</p>
                        </div>
                        ${canManageSettings ? `
                            <button class="crm-button-danger" data-action="open-clear-confirm">
                                <i class="fa-solid fa-trash"></i> Clear all data
                            </button>
                        ` : ''}
                    </div>
                    ${canManageSettings ? '' : '<div class="panel-subtitle">Only admin users can reset the local workspace dataset.</div>'}
                </div>
            </section>
        </div>
    `;
}

function renderDrawer() {
    if (!isDrawerOpen()) {
        refs.drawer.classList.add('hidden');
        refs.drawer.innerHTML = '';
        return;
    }

    const client = createBlankClient();

    refs.drawer.classList.remove('hidden');

    if (!client) {
        refs.drawer.innerHTML = '';
        return;
    }

    const canAdminEdit = hasPermission(state.session, PERMISSIONS.EDIT_ADMIN_FIELDS);
    const assigneeOptions = getAssignableUsers({ includeAdmin: true });
    const title = 'Create lead';
    const subtitle = 'Add a new lead manually. Duplicate checks run before saving, and successful creates open directly in the lead detail workflow.';

    refs.drawer.innerHTML = `
        <div class="drawer-surface">
            <div class="drawer-head">
                <div>
                    <span class="crm-kicker"><i class="fa-solid fa-user-pen"></i> New lead</span>
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
                    <button class="crm-button" type="submit"><i class="fa-solid fa-floppy-disk"></i> Save lead</button>
                    <button class="crm-button-ghost" type="button" data-action="close-drawer">Cancel</button>
                </div>
            </form>
        </div>
    `;
}

function renderModal() {
    if (!state.modal) {
        refs.modalLayer.classList.add('hidden');
        refs.modalLayer.innerHTML = '';
        return;
    }

    refs.modalLayer.classList.remove('hidden');

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
                        <p class="panel-subtitle">This removes the lead from the local IndexedDB dataset in this browser.</p>
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
                        <h2 class="modal-title">Clear all local CRM data?</h2>
                        <p class="panel-subtitle">Type <span class="inline-code">CLEAR</span> to remove all local leads, members, and import history from this browser.</p>
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
    }
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
                        <h2 class="modal-title">Supabase user required</h2>
                        <p class="panel-subtitle">Create the auth user in Supabase Auth first, then return here to edit their CRM profile.</p>
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
                    <p class="panel-subtitle">This updates the user row in <span class="inline-code">public.profiles</span>. Email and password changes should be managed in Supabase Auth.</p>
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
                        <span class="panel-subtitle">Managed in Supabase Auth.</span>
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
                        <p class="panel-subtitle">CSV parsing happens in the browser. Nothing is sent to a backend in this prototype.</p>
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
                        <p class="panel-subtitle">The CRM data has been updated in IndexedDB and the summary was logged to local import history.</p>
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
                    <button class="crm-button-ghost" data-action="jump-to-view" data-view="imports"><i class="fa-solid fa-clock-rotate-left"></i> View history</button>
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
                            ${renderStatTile('Storage', 'IndexedDB')}
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
            <button class="sort-button" data-action="sort-table" data-field="${header.key}">
                ${header.label}
                <i class="fa-solid ${getSortIcon(header.key)}"></i>
            </button>
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
    const leads = getScopedClients('leads', { ignoreSearch: true, ignoreFilters: true });
    const members = getScopedClients('members', { ignoreSearch: true, ignoreFilters: true });
    const tagCounts = aggregateCounts(leads.flatMap((client) => client.tags));
    const statusCounts = aggregateCounts(leads.map((client) => client.status || 'new'));
    const recentlyUpdated = [...leads]
        .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))
        .slice(0, 5);

    return {
        totalLeads: leads.length,
        totalMembers: members.length,
        tagCounts,
        statusCounts,
        recentlyUpdated,
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
    return getScopedClients(scope);
}

function getScopedClients(scope = 'leads', options = {}) {
    const ignoreSearch = options.ignoreSearch === true;
    const ignoreFilters = options.ignoreFilters === true;
    const filtersKey = JSON.stringify({
        scope,
        ignoreSearch,
        ignoreFilters,
        search: normalizeWhitespace(state.search).toLowerCase(),
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

    const searchTerm = normalizeWhitespace(state.search).toLowerCase();
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
    return state.drawerMode === 'create';
}

function createBlankClient() {
    return {
        id: '',
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        tags: [],
        notes: '',
        status: 'new',
        subscriptionType: '',
        timeZone: 'Unknown',
        timezoneOverridden: false,
        assignedRepId: state.session?.id || '',
        assignedTo: state.session?.name || '',
        lifecycleType: 'lead',
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
    const assignedLeads = leads.filter((lead) => lead.assignedRepId).length;
    const unassignedLeads = leads.length - assignedLeads;
    const leadsByRepMap = leads.reduce((map, lead) => {
        const name = lead.assignedTo || 'Unassigned';
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
        totalLeads: leads.length,
        totalMembers: members.length,
        assignedLeads,
        unassignedLeads,
        leadsByRep,
        leadsByRepMap,
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
    renderDrawer();
    refs.shell.classList.add('drawer-open');
}

function closeDrawer() {
    state.drawerMode = null;
    refs.shell.classList.remove('drawer-open');
    renderDrawer();
}

function resetAuthenticatedCrmState() {
    state.clients = [];
    state.allowedTags = [];
    state.tagDefinitions = [];
    state.dispositionDefinitions = [];
    state.users = [];
    state.savedFilters = [];
    state.importHistory = [];
    state.clientCacheMode = 'light';
    state.workspaceResults = {
        leads: createEmptyWorkspaceResult(),
        members: createEmptyWorkspaceResult()
    };
    state.selectedLeadIds = [];
    state.bulkAssignRepId = '';
    state.detailClientId = null;
    state.detailEditMode = false;
    state.detailEditSnapshot = null;
    state.leadHistoryOpen = false;
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

    if (['clients', 'members'].includes(state.currentView)) {
        queueWorkspaceRefresh(getDefaultScopeForView());
    }
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
        return;
    }

    const { action } = actionEl.dataset;

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

    if (action === 'dismiss-notice') {
        state.notice = null;
        render();
        return;
    }

    if (action === 'toggle-sidebar') {
        setSidebarOpen(!state.sidebarOpen);
        return;
    }

    if (action === 'set-view' || action === 'jump-to-view') {
        const targetView = actionEl.dataset.view;

        if (targetView === 'admin' && !hasActiveAdminProfile()) {
            flashNotice('Admin access is required for that section.', 'error');
            return;
        }

        if (targetView === 'imports' && !hasPermission(state.session, PERMISSIONS.IMPORT_LEADS)) {
            flashNotice('Only admin users can import leads.', 'error');
            return;
        }

        state.currentView = targetView;
        setSidebarOpen(false);
        state.detailEditMode = false;
        state.detailEditSnapshot = null;
        state.leadHistoryOpen = false;
        state.editingNoteId = null;
        if (action === 'jump-to-view') {
            closeModal();
        }
        if (targetView === 'clients' || targetView === 'members') {
            state.lastWorkspaceView = targetView;
            await refreshWorkspacePage(targetView === 'members' ? 'members' : 'leads');
            return;
        }
        if (targetView === 'admin') {
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

    if (action === 'open-filters') {
        if (!['clients', 'members'].includes(state.currentView)) {
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

    if (action === 'load-saved-filter') {
        const filter = state.savedFilters.find((item) => item.id === actionEl.dataset.filterId);

        if (!filter) {
            flashNotice('That saved filter is not available in this session.', 'error');
            return;
        }

        applySavedFilter(filter);
        if (!['clients', 'members', 'lead-detail'].includes(state.currentView)) {
            state.currentView = state.lastWorkspaceView || 'clients';
        }
        flashNotice(`Loaded saved filter "${filter.name}".`, 'success');
        renderTopbar();
        await refreshWorkspacePage(state.currentView === 'members' || state.lastWorkspaceView === 'members' ? 'members' : 'leads');
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
        await openLeadDetailPage(actionEl.dataset.clientId, state.currentView === 'members' ? 'members' : 'clients');
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
        state.leadHistoryOpen = !state.leadHistoryOpen;
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
        state.leadHistoryOpen = false;
        state.editingNoteId = null;
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
        flashNotice('Lead deleted from the local CRM.', 'success');
        await refreshData();
        return;
    }

    if (action === 'open-clear-confirm') {
        if (!hasPermission(state.session, PERMISSIONS.MANAGE_SETTINGS)) {
            flashNotice('Only admin users can clear local CRM data.', 'error');
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
            flashNotice('Only admin users can restore the sample dataset.', 'error');
            return;
        }
        await dataService.restoreSampleData();
        flashNotice('Sample CRM dataset restored when no local records were present.', 'success');
        await refreshData();
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
            flashNotice('Create the auth user in Supabase first, then edit their CRM profile here.', 'error');
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

        if (!window.confirm(`Delete ${user.name}'s CRM profile? This removes their profile row from Supabase and reassigns their leads to you.`)) {
            return;
        }

        if (user.isActive !== false) {
            await dataService.reassignClientsFromUser(user.id, state.session.id, state.session.name);
        }

        await authService.deleteUser(user.id);
        flashNotice(`${user.name}'s CRM profile was deleted.`, 'success');
        await refreshData();
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

        state.editingTagDefinitionId = actionEl.dataset.definitionId;
        renderPanels();
        return;
    }

    if (action === 'clear-tag-definition-edit') {
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
        await refreshData();
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
        await refreshData();
        return;
    }

    if (action === 'edit-disposition-definition') {
        if (!hasActiveAdminProfile()) {
            flashNotice('Only active admin users can manage dispositions.', 'error');
            return;
        }

        state.editingDispositionDefinitionId = actionEl.dataset.definitionId;
        renderPanels();
        return;
    }

    if (action === 'clear-disposition-definition-edit') {
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
        await refreshData();
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
        await refreshData();
    }
});

document.addEventListener('submit', async (event) => {
    const formId = typeof event.target?.getAttribute === 'function'
        ? event.target.getAttribute('id')
        : event.target?.id;

    if (formId === 'login-form') {
        event.preventDefault();
        const formData = new FormData(event.target);
        state.authSubmitting = true;
        state.authResolved = true;
        render();

        try {
            state.session = await authService.login({
                email: formData.get('email'),
                password: formData.get('password')
            });
            state.authUser = authService.getAuthUser();
            state.profile = authService.getProfile();
            flashNotice(`Logged in as ${state.session.name}.`, 'success');
            await refreshData();
        } catch (error) {
            flashNotice(error.message, 'error');
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
            await refreshData();
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
                await refreshData();
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
            await refreshData();
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
        await refreshData();
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
        await refreshData();
        return;
    }

    if (formId === 'clear-data-form') {
        event.preventDefault();
        const formData = new FormData(event.target);

        if (!hasPermission(state.session, PERMISSIONS.MANAGE_SETTINGS)) {
            flashNotice('Only admin users can clear local CRM data.', 'error');
            return;
        }

        if (String(formData.get('confirmation') ?? '').trim() !== 'CLEAR') {
            flashNotice('Type CLEAR to confirm the destructive action.', 'error');
            return;
        }

        await dataService.clearAllData();
        closeModal();
        closeDrawer();
        flashNotice('Local CRM data cleared from this browser.', 'success');
        await refreshData();
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

    if (event.target.id === 'global-search') {
        state.search = event.target.value;
        state.activeSavedFilterId = null;
        state.page = 1;

        if (normalizeWhitespace(state.search) && !['clients', 'members'].includes(state.currentView)) {
            state.currentView = 'clients';
            state.lastWorkspaceView = 'clients';
        }

        renderSidebar();
        renderPanels();
        queueWorkspaceRefresh(getDefaultScopeForView());
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

    const selectedIds = new Set(state.selectedLeadIds);

    if (selectedIds.has(clientId)) {
        selectedIds.delete(clientId);
    } else {
        selectedIds.add(clientId);
    }

    state.selectedLeadIds = [...selectedIds];
}

function togglePageLeadSelection() {
    const currentPageIds = getWorkspacePageRows('leads').map((client) => client.id);
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
    state.selectedLeadIds = getWorkspacePageRows('leads').map((client) => client.id);
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
        await refreshData();
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

function findDuplicateLeadCandidate(payload) {
    const email = normalizeWhitespace(payload.email).toLowerCase();
    const phoneDigits = String(payload.phone ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

    const match = state.clients.find((client) => {
        if (payload.id && client.id === payload.id) {
            return false;
        }

        return (email && client.email?.toLowerCase() === email)
            || (phoneDigits && client.phoneKey === phoneDigits);
    }) || null;

    if (!match) {
        return null;
    }

    if (!canAccessClient(match) && !isAdminSession(state.session)) {
        return {
            id: match.id,
            restricted: true
        };
    }

    return match;
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
    const duplicateLead = findDuplicateLeadCandidate(clientPayload);

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
    state.lastWorkspaceView = savedLead.lifecycleType === 'member' ? 'members' : 'clients';
    state.detailClientId = staysAccessible ? savedLead.id : null;
    state.currentView = staysAccessible ? 'lead-detail' : state.lastWorkspaceView;
    state.detailEditMode = false;
    state.detailEditSnapshot = null;
    await refreshData();
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
        search: state.search,
        sort: { ...state.sort },
        pageSize: state.pageSize
    };
}

function applySavedFilter(savedFilter) {
    const payload = savedFilter.filterPayload || {};
    state.filters = normalizeFilterState(payload.filters || payload || createDefaultFilters());
    state.search = String(payload.search ?? '');
    state.sort = {
        field: typeof payload.sort?.field === 'string' ? payload.sort.field : 'updatedAt',
        direction: payload.sort?.direction === 'asc' ? 'asc' : 'desc'
    };
    state.pageSize = [25, 50, 100, 250].includes(Number(payload.pageSize)) ? Number(payload.pageSize) : 50;
    state.activeSavedFilterId = savedFilter.id;
    state.page = 1;
}

async function openLeadDetailPage(clientId, sourceView = 'clients') {
    const cachedLead = getAccessibleClientById(clientId);

    if (!cachedLead) {
        flashNotice('That lead is not assigned to your session.', 'error');
        return;
    }

    try {
        const detailedLead = await dataService.getClientById(clientId);

        if (detailedLead && canAccessClient(detailedLead)) {
            mergeClientCache([detailedLead]);
        }
    } catch (error) {
        flashNotice(error.message || 'Unable to load the lead details.', 'error');
        return;
    }

    state.detailClientId = clientId;
    state.currentView = 'lead-detail';
    state.lastWorkspaceView = sourceView === 'members' ? 'members' : 'clients';
    state.detailEditMode = false;
    state.detailEditSnapshot = null;
    state.leadHistoryOpen = false;
    state.editingNoteId = null;
    closeDrawer();
    if (state.modal) {
        closeModal();
    }
    render();
}

async function navigateLeadDetail(direction) {
    const scope = state.lastWorkspaceView === 'members' ? 'members' : 'leads';
    const visibleSet = getVisibleClients(scope);
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

        await refreshData();

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
