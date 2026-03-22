// Member-site auth helpers (Supabase)
// Root-absolute URLs so imports work from any page URL (trailing slashes, rewrites).
import { getSupabase } from '/src/lib/supabase-browser.js';
import {
    fetchMemberState,
    evaluateMemberStateAccess,
    isStaffUser
} from '/assets/js/supabase-member-access.js';

export const ACCOUNT_ISSUE_REASON = 'account_issue';

export function buildAuthStatusUrl(path, reason, extraParams = {}) {
    if (typeof window === 'undefined') {
        return path;
    }
    const url = new URL(path, window.location.href);
    if (reason) url.searchParams.set('reason', reason);
    Object.entries(extraParams).forEach(([key, value]) => {
        if (value != null && value !== '') url.searchParams.set(key, String(value));
    });
    return url.pathname + url.search + url.hash;
}

export function getPageId() {
    const path = (typeof window !== 'undefined' && window.location.pathname) || '';
    return path.replace(/^\//, '').replace(/\.html$/, '') || 'index';
}

export async function checkPageMaintenance(pageId, maintenancePath, isAdmin) {
    if (isAdmin) return false;
    try {
        const supabase = await getSupabase();
        const { data, error } = await supabase
            .from('bcs_site_documents')
            .select('data')
            .eq('id', 'site')
            .maybeSingle();
        if (error || !data?.data) return false;
        const doc = data.data;

        if (doc.maintenanceMode) {
            window.location.href = maintenancePath;
            return true;
        }

        const pages = doc.maintenancePages || {};
        const pageEntry = pages[pageId];
        if (pageEntry && pageEntry.enabled) {
            const sep = maintenancePath.indexOf('?') >= 0 ? '&' : '?';
            window.location.href = maintenancePath + sep + 'page=' + encodeURIComponent(pageId);
            return true;
        }
    } catch (e) {
        console.warn('checkPageMaintenance:', e?.message || e);
    }
    return false;
}

export function requireAuth(redirectPath) {
    const target = redirectPath || 'login.html';
    const run = async () => {
        const supabase = await getSupabase();
        const { data } = await supabase.auth.getSession();
        if (!data?.session) window.location.href = target;
    };
    run();
    window.addEventListener('pageshow', (e) => {
        if (e.persisted) run();
    });
}

export async function performSupabaseLogout(loginPath) {
    try {
        const supabase = await getSupabase();
        await supabase.auth.signOut();
    } catch (e) {
        console.error('Logout error:', e);
    }
    try {
        localStorage.removeItem('bluechip_logged_in');
        localStorage.removeItem('bluechip_user_email');
        localStorage.removeItem('bluechip_is_admin');
        sessionStorage.removeItem('bluechip_logged_in');
        sessionStorage.removeItem('bluechip_user_email');
    } catch (_) {}
    window.location.replace(loginPath || 'login.html');
}

export async function redirectToAccountIssue(loginPath) {
    await performSupabaseLogout(buildAuthStatusUrl(loginPath || 'login.html', ACCOUNT_ISSUE_REASON));
}

export function redirectIfLoggedIn(destination) {
    const dest = destination || 'dashboard.html';
    const run = async () => {
        const supabase = await getSupabase();
        const { data } = await supabase.auth.getSession();
        if (data?.session) window.location.href = dest;
    };
    run();
    window.addEventListener('pageshow', (e) => {
        if (e.persisted) run();
    });
}

/**
 * @param {'bundle'|'ticker'} planType
 * @param {string|null} ticker
 */
export function requirePlan(planType, ticker, loginPath, upgradePath, pageId) {
    const _login = () => {
        window.location.href = loginPath || '../../login.html';
    };
    const _upgrade = () => {
        window.location.href = upgradePath || '../../upgrade.html';
    };
    const _welcome = () => {
        const basePath = (loginPath || '../../login.html').replace(/[^/]+$/, '');
        window.location.href = basePath + 'welcome-setup.html';
    };

    const _pageId = pageId != null ? pageId : getPageId();
    const _maintenancePath = (loginPath || '../../login.html').replace(/[^/]+$/, '') + 'maintenance.html';

    const _check = async () => {
        const supabase = await getSupabase();
        const { data: sess } = await supabase.auth.getSession();
        if (!sess?.session) {
            _login();
            return;
        }

        let staff = false;
        try {
            staff = await isStaffUser(supabase);
        } catch (_) {}

        if (staff) {
            if (await checkPageMaintenance(_pageId, _maintenancePath, true)) return;
            return;
        }

        let state;
        try {
            const res = await fetchMemberState(supabase);
            state = res.state;
        } catch (err) {
            console.error('requirePlan fetch error:', err);
            _login();
            return;
        }

        const access = evaluateMemberStateAccess(state, {
            requireSetup: true,
            planType,
            ticker
        });

        if (access.status === 'missing_profile' || access.status === 'account_issue') {
            await redirectToAccountIssue(loginPath || '../../login.html');
            return;
        }
        if (access.status === 'setup_incomplete') {
            _welcome();
            return;
        }
        if (access.status === 'pending_channel_selection') {
            _welcome();
            return;
        }
        if (access.status === 'inactive' || access.status === 'plan_mismatch') {
            _upgrade();
            return;
        }

        if (await checkPageMaintenance(_pageId, _maintenancePath, false)) return;
    };

    _check();
    window.addEventListener('pageshow', (e) => {
        if (e.persisted) _check();
    });
}

export function updateAuthButton(loginPath) {
    const run = async () => {
        const supabase = await getSupabase();
        const { data } = await supabase.auth.getSession();
        const authButton = document.getElementById('authButton');
        if (data?.session && authButton) {
            authButton.removeAttribute('href');
            authButton.innerHTML = '<i class="fas fa-sign-out-alt"></i> Logout';
            authButton.style.cursor = 'pointer';
            authButton.onclick = function (e) {
                e.preventDefault();
                performSupabaseLogout(loginPath);
                return false;
            };
        }
    };
    run();
}

/** @deprecated Use fetchMemberState + evaluateMemberStateAccess */
export async function loadAndEvaluateUserProfileSupabase(uid, options) {
    void uid;
    const supabase = await getSupabase();
    const { state } = await fetchMemberState(supabase);
    return evaluateMemberStateAccess(state, options);
}

export { isStaffUser, fetchMemberState, evaluateMemberStateAccess } from '/assets/js/supabase-member-access.js';
