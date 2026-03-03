// Firebase Authentication Check — Blue Chip Signals
// Centralised auth utilities used by all protected pages.
import { auth, db, onAuthStateChanged, signOut, doc, getDoc } from './firebase-config.js';

/**
 * Protect a page: redirect unauthenticated users immediately.
 * Call once near the top of any page that requires login.
 * @param {string} redirectPath - Relative path to redirect to (e.g. '../../book-demo.html')
 */
export function requireAuth(redirectPath) {
    const _redirect = () => { window.location.href = redirectPath || 'book-demo.html'; };

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
 * @param {string} loginPath - Relative path to login.html (e.g. '../../login.html')
 */
export async function performFirebaseLogout(loginPath) {
    try {
        await signOut(auth);
        localStorage.removeItem('bluechip_logged_in');
        localStorage.removeItem('bluechip_user_email');
        sessionStorage.removeItem('bluechip_logged_in');
        sessionStorage.removeItem('bluechip_user_email');
        window.location.href = loginPath || 'login.html';
    } catch (error) {
        console.error('Logout error:', error);
    }
}

/**
 * Landing-page guard: redirect already-logged-in users away from public pages.
 * Call on index.html (and any other marketing page) so returning users go
 * straight to their dashboard without seeing the landing page again.
 * @param {string} destination - Where to send logged-in users (e.g. 'dashboard.html')
 */
export function redirectIfLoggedIn(destination) {
    const _redirect = () => { window.location.href = destination || 'dashboard.html'; };

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
 * planType  'bundle' — user must have plan === 'bundle'
 *           'ticker' — user must have plan === 'bundle'  OR
 *                      (plan === 'single' AND allowedTicker === ticker)
 *
 * @param {'bundle'|'ticker'} planType
 * @param {string|null}       ticker      - e.g. 'SPY', 'AAPL' (ignored when planType='bundle')
 * @param {string}            loginPath   - e.g. '../../login.html'
 * @param {string}            upgradePath - e.g. '../../upgrade.html'
 */
export function requirePlan(planType, ticker, loginPath, upgradePath) {
    const _login   = () => { window.location.href = loginPath   || '../../login.html'; };
    const _upgrade = () => { window.location.href = upgradePath || '../../upgrade.html'; };

    /* Derive the maintenance page path from the loginPath (same directory level) */
    const _maintenance = () => {
        const base = (loginPath || '../../login.html').replace(/[^/]+$/, '');
        window.location.href = base + 'maintenance.html';
    };

    const _check = async (user) => {
        if (!user) { _login(); return; }
        try {
            /* Fetch user profile and site settings in parallel */
            const [userSnap, siteSnap] = await Promise.all([
                getDoc(doc(db, 'users', user.uid)),
                getDoc(doc(db, 'settings', 'site'))
            ]);

            if (!userSnap.exists()) { _login(); return; }

            const { plan, allowedTicker, subscriptionStatus, role } = userSnap.data();
            const isAdmin = (role || '').toLowerCase() === 'admin';

            /* Maintenance mode — admins always bypass */
            if (!isAdmin && siteSnap.exists() && siteSnap.data().maintenanceMode) {
                _maintenance(); return;
            }

            /* Subscription status — 'Inactive' blocks access regardless of plan */
            if (!isAdmin && (subscriptionStatus || '').toLowerCase() === 'inactive') {
                _upgrade(); return;
            }

            /* Plan check */
            if (planType === 'bundle') {
                if (plan !== 'bundle') _upgrade();
            } else {
                const t       = (ticker        || '').toUpperCase();
                const allowed = (allowedTicker || '').toUpperCase();
                if (plan !== 'bundle' && !(plan === 'single' && allowed === t)) {
                    _upgrade();
                }
            }
        } catch (err) {
            console.error('requirePlan error:', err);
            _login();
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
 * @param {string} loginPath - Relative path to login.html (e.g. '../../login.html')
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
