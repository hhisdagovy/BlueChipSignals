// Firebase Authentication Check -  Blue Chip Signals
// Centralised auth utilities used by all protected pages.
import { auth, db, onAuthStateChanged, signOut, doc, getDoc } from './firebase-config.js';

/**
 * Derive a stable page ID from the current pathname.
 * e.g. "/dashboard.html" → "dashboard", "/pages/guides/tsla-delivery-production.html" → "pages/guides/tsla-delivery-production"
 * @returns {string}
 */
export function getPageId() {
    const path = (typeof window !== 'undefined' && window.location.pathname) || '';
    return path.replace(/^\//, '').replace(/\.html$/, '') || 'index';
}

/**
 * Check if the current page (or given pageId) is in maintenance.
 * Redirects to maintenance page if so. Admins bypass.
 * @param {string} pageId - Page identifier (e.g. 'dashboard', 'pages/guides/tsla-delivery-production')
 * @param {string} maintenancePath - Relative path to maintenance.html (e.g. 'maintenance.html', '../../maintenance.html')
 * @param {boolean} isAdmin - If true, skip check and return without redirecting
 * @returns {Promise<boolean>} - True if redirect was triggered, false otherwise
 */
export async function checkPageMaintenance(pageId, maintenancePath, isAdmin) {
    if (isAdmin) return false;
    try {
        const siteSnap = await getDoc(doc(db, 'settings', 'site'));
        if (!siteSnap.exists()) return false;
        const data = siteSnap.data();

        /* Site-wide maintenance */
        if (data.maintenanceMode) {
            window.location.href = maintenancePath;
            return true;
        }

        /* Per-page maintenance */
        const pages = data.maintenancePages || {};
        const pageEntry = pages[pageId];
        if (pageEntry && pageEntry.enabled) {
            const sep = maintenancePath.indexOf('?') >= 0 ? '&' : '?';
            window.location.href = maintenancePath + sep + 'page=' + encodeURIComponent(pageId);
            return true;
        }
    } catch (e) {
        console.warn('checkPageMaintenance: could not read settings/site - ', e?.code || e);
    }
    return false;
}

/**
 * Protect a page: redirect unauthenticated users immediately.
 * Call once near the top of any page that requires login.
 * @param {string} redirectPath - Relative path to redirect to (e.g. '../../book-demo')
 */
export function requireAuth(redirectPath) {
    const _redirect = () => { window.location.href = redirectPath || 'book-demo'; };

    onAuthStateChanged(auth, (user) => {
        if (!user) _redirect();
    });

    /* When the browser restores this page from the bfcache (Back/Forward navigation),
       JavaScript does not re-execute. The pageshow event always fires on restoration,
       and auth.currentUser is synchronously available after the first onAuthStateChanged
       call, so we can redirect immediately without waiting for another async check. */
    window.addEventListener('pageshow', (e) => {
        if (e.persisted && !auth.currentUser) {
            _redirect();
        }
    });
}

/**
 * Sign the current user out and redirect to the login page.
 * @param {string} loginPath - Relative path to login.html (e.g. '../../login')
 */
export async function performFirebaseLogout(loginPath) {
    try {
        await signOut(auth);
        localStorage.removeItem('bluechip_logged_in');
        localStorage.removeItem('bluechip_user_email');
        sessionStorage.removeItem('bluechip_logged_in');
        sessionStorage.removeItem('bluechip_user_email');
        /* replace() removes current page from history -  prevents Back from restoring logged-in view */
        window.location.replace(loginPath || 'login');
    } catch (error) {
        console.error('Logout error:', error);
    }
}

/**
 * Landing-page guard: redirect already-logged-in users away from public pages.
 * Call on index.html (and any other marketing page) so returning users go
 * straight to their dashboard without seeing the landing page again.
 * @param {string} destination - Where to send logged-in users (e.g. 'dashboard')
 */
export function redirectIfLoggedIn(destination) {
    const _redirect = () => { window.location.href = destination || 'dashboard'; };

    onAuthStateChanged(auth, (user) => {
        if (user) _redirect();
    });

    // Handle bfcache restoration (e.g. Back button after logout)
    window.addEventListener('pageshow', (e) => {
        if (e.persisted && auth.currentUser) {
            _redirect();
        }
    });
}

/**
 * Plan-gated page guard.
 * Checks Firebase auth AND the user's Firestore subscription plan before allowing access.
 *
 * planType  'bundle' -  user must have plan === 'bundle'
 *           'ticker' -  user must have plan === 'bundle'  OR
 *                      (plan === 'single' AND allowedTicker === ticker)
 *
 * @param {'bundle'|'ticker'} planType
 * @param {string|null}       ticker      - e.g. 'SPY', 'AAPL' (ignored when planType='bundle')
 * @param {string}            loginPath   - e.g. '../../login'
 * @param {string}            upgradePath - e.g. '../../upgrade'
 * @param {string}            [pageId]   - Optional page ID for per-page maintenance (default: derived from pathname)
 */
export function requirePlan(planType, ticker, loginPath, upgradePath, pageId) {
    const _login   = () => { window.location.href = loginPath   || '../../login'; };
    const _upgrade = () => { window.location.href = upgradePath || '../../upgrade'; };

    const _pageId = pageId != null ? pageId : getPageId();
    const _maintenancePath = (loginPath || '../../login').replace(/[^/]+$/, '') + 'maintenance.html';

    const _check = async (user) => {
        if (!user) { _login(); return; }

        /* ── 1. Load user profile (critical -  failure redirects to login) ── */
        let userData;
        try {
            const userSnap = await getDoc(doc(db, 'users', user.uid));
            if (!userSnap.exists()) { _login(); return; }
            userData = userSnap.data();
        } catch (err) {
            console.error('requirePlan user fetch error:', err);
            _login(); return;
        }

        const { plan, allowedTicker, subscriptionStatus, role } = userData;
        const isAdmin = (role || '').toLowerCase() === 'admin';

        /* ── 2. Site-wide and per-page maintenance (non-critical -  failure is silently skipped) ── */
        if (await checkPageMaintenance(_pageId, _maintenancePath, isAdmin)) return;

        /* ── 3. Subscription status ── */
        if (!isAdmin && (subscriptionStatus || '').toLowerCase() === 'inactive') {
            _upgrade(); return;
        }

        /* ── 4. Plan check ── */
        if (planType === 'bundle') {
            if (plan !== 'bundle') _upgrade();
        } else {
            const t       = (ticker        || '').toUpperCase();
            const allowed = (allowedTicker || '').toUpperCase();
            if (plan !== 'bundle' && !(plan === 'single' && allowed === t)) {
                _upgrade();
            }
        }
    };

    onAuthStateChanged(auth, (user) => { _check(user); });

    window.addEventListener('pageshow', (e) => {
        if (e.persisted) _check(auth.currentUser);
    });
}

/**
 * Wire the injected #authButton and #dashboardLink to the current auth state.
 * Call after nav-component.js has run so the elements exist in the DOM.
 * @param {string} loginPath - Relative path to login.html (e.g. '../../login')
 */
export function updateAuthButton(loginPath) {
    onAuthStateChanged(auth, (user) => {
        const authButton = document.getElementById('authButton');

        if (user && authButton) {
            authButton.removeAttribute('href');
            authButton.innerHTML = '<i class="fas fa-sign-out-alt"></i> Logout';
            authButton.style.cursor = 'pointer';
            authButton.onclick = function (e) {
                e.preventDefault();
                performFirebaseLogout(loginPath);
                return false;
            };
        }
    });
}
