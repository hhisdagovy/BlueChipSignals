// Firebase Authentication Check — Blue Chip Signals
// Centralised auth utilities used by all protected pages.
import { auth, onAuthStateChanged, signOut } from './firebase-config.js';

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
 * Wire the injected #authButton and #dashboardLink to the current auth state.
 * Call after nav-component.js has run so the elements exist in the DOM.
 * @param {string} loginPath - Relative path to login.html (e.g. '../../login.html')
 */
export function updateAuthButton(loginPath) {
    onAuthStateChanged(auth, (user) => {
        const authButton    = document.getElementById('authButton');
        const dashboardLink = document.getElementById('dashboardLink');

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

        if (user && dashboardLink) {
            dashboardLink.style.display = 'block';
        }
    });
}
