// Firebase Authentication Check for Protected Pages
import { auth, onAuthStateChanged, signOut } from './firebase-config.js';

// Check if user is authenticated
export function checkAuth(redirectIfNot = true) {
    return new Promise((resolve, reject) => {
        onAuthStateChanged(auth, (user) => {
            if (user) {
                // User is signed in
                resolve(user);
            } else {
                // User is not signed in
                if (redirectIfNot) {
                    window.location.href = '../../book-demo.html';
                }
                reject(new Error('Not authenticated'));
            }
        });
    });
}

// Logout function
export async function performFirebaseLogout() {
    try {
        await signOut(auth);
        // Clear local storage
        localStorage.removeItem('bluechip_logged_in');
        localStorage.removeItem('bluechip_user_email');
        sessionStorage.removeItem('bluechip_logged_in');
        sessionStorage.removeItem('bluechip_user_email');
        // Redirect to login
        window.location.href = 'login.html';
    } catch (error) {
        console.error('Logout error:', error);
        alert('Error logging out. Please try again.');
    }
}

// Update auth button in navigation
export function updateAuthButton() {
    onAuthStateChanged(auth, (user) => {
        const authButton = document.getElementById('authButton');
        const dashboardLink = document.getElementById('dashboardLink');
        
        if (user && authButton) {
            authButton.removeAttribute('href');
            authButton.innerHTML = '<i class="fas fa-sign-out-alt"></i> Logout';
            authButton.style.cursor = 'pointer';
            
            authButton.onclick = function(e) {
                e.preventDefault();
                performFirebaseLogout();
                return false;
            };
        }
        
        // Show Dashboard link for logged-in users
        if (user && dashboardLink) {
            dashboardLink.style.display = 'block';
        }
    });
}

// Initialize auth check on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateAuthButton);
} else {
    updateAuthButton();
}

