/* ============================================================
   nav-component.js — Blue Chip Signals
   Injects the navigation bar into any page that contains:
     <div id="nav-placeholder" data-nav-type="public|loggedin|internal|minimal"></div>
   ============================================================ */
(function () {
    var placeholder = document.getElementById('nav-placeholder');
    if (!placeholder) return;

    var type = placeholder.getAttribute('data-nav-type') || 'public';
    var base = placeholder.getAttribute('data-base') || '';

    var nav = document.createElement('nav');
    nav.innerHTML = buildNav(type);
    placeholder.parentNode.replaceChild(nav, placeholder);

    /* ---------- Body scroll lock helpers (iOS fix) ---------- */
    function lockBodyScroll() {
        var scrollY = window.scrollY;
        document.body.style.position = 'fixed';
        document.body.style.top      = '-' + scrollY + 'px';
        document.body.style.width    = '100%';
        document.body.dataset.navScrollY = scrollY;
    }

    function unlockBodyScroll() {
        var savedY = parseInt(document.body.dataset.navScrollY || '0', 10);
        document.body.style.position = '';
        document.body.style.top      = '';
        document.body.style.width    = '';
        delete document.body.dataset.navScrollY;
        window.scrollTo(0, savedY);
    }

    function closeMenu() {
        if (navLinks.classList.contains('active')) {
            navLinks.classList.remove('active');
            hamburger.classList.remove('is-open');
            unlockBodyScroll();
        }
    }

    /* ---------- Hamburger toggle ---------- */
    var hamburger = nav.querySelector('.hamburger-menu');
    var navLinks   = nav.querySelector('.nav-links');

    if (hamburger && navLinks) {
        hamburger.addEventListener('click', function () {
            var isOpen = navLinks.classList.toggle('active');
            hamburger.classList.toggle('is-open', isOpen);
            if (isOpen) {
                lockBodyScroll();
            } else {
                unlockBodyScroll();
            }
        });

        /* Close mobile menu when a nav link is clicked */
        navLinks.addEventListener('click', function (e) {
            if (e.target.tagName === 'A' && window.innerWidth <= 768) {
                closeMenu();
            }
        });
    }

    /* ============================================================
       Nav HTML templates
       ============================================================ */

    function buildNav(navType) {
        switch (navType) {
            case 'loggedin':  return loggedinNav();
            case 'internal':  return internalNav();
            case 'minimal':   return minimalNav();
            default:          return publicNav();
        }
    }

    /* Standard public nav — auth scripts on each page update #authButton
       and show #dashboardLink once Firebase confirms the user is logged in. */
    function publicNav() {
        return '<div class="nav-container">' +
            '<div class="logo">' +
                '<a href="' + base + 'index.html"><img src="' + base + 'assets/images/logo.png" alt="Blue Chip Signals Logo"></a>' +
            '</div>' +
            '<button class="hamburger-menu" aria-label="Toggle menu">' +
                '<span class="bar"></span>' +
                '<span class="bar"></span>' +
                '<span class="bar"></span>' +
            '</button>' +
            '<ul class="nav-links">' +
                '<li id="dashboardLink" style="display:none;">' +
                    '<a href="' + base + 'dashboard.html" class="nav-dashboard-link">' +
                        '<i class="fas fa-tachometer-alt"></i> Dashboard' +
                    '</a>' +
                '</li>' +
                '<li><a href="' + base + 'contact.html">Contact</a></li>' +
                '<li><a href="' + base + 'faq.html">FAQ</a></li>' +
                '<li><a href="' + base + 'about.html">About Us</a></li>' +
                '<li><a href="' + base + 'login.html" class="login-btn" id="authButton">' +
                    '<i class="fas fa-sign-in-alt"></i> Login' +
                '</a></li>' +
            '</ul>' +
        '</div>';
    }

    /* Always-logged-in nav — used by dashboard.html.
       Dashboard link is always visible; button always shows Logout.
       Calls window.logout() which each protected page defines. */
    function loggedinNav() {
        return '<div class="nav-container">' +
            '<div class="logo">' +
                '<a href="' + base + 'index.html"><img src="' + base + 'assets/images/logo.png" alt="Blue Chip Signals Logo"></a>' +
            '</div>' +
            '<button class="hamburger-menu" aria-label="Toggle menu">' +
                '<span class="bar"></span>' +
                '<span class="bar"></span>' +
                '<span class="bar"></span>' +
            '</button>' +
            '<ul class="nav-links">' +
                '<li>' +
                    '<a href="' + base + 'dashboard.html" class="nav-dashboard-link">' +
                        '<i class="fas fa-tachometer-alt"></i> Dashboard' +
                    '</a>' +
                '</li>' +
                '<li><a href="' + base + 'contact.html">Contact</a></li>' +
                '<li><a href="' + base + 'faq.html">FAQ</a></li>' +
                '<li><a href="' + base + 'about.html">About Us</a></li>' +
                '<li>' +
                    '<a href="#" class="login-btn" id="authButton" ' +
                       'onclick="if(window.logout){logout();}return false;" ' +
                       'style="cursor:pointer;">' +
                        '<i class="fas fa-sign-out-alt"></i> Logout' +
                    '</a>' +
                '</li>' +
            '</ul>' +
        '</div>';
    }

    /* Internal nav — used by account.html.
       Simple links to Dashboard, Account, Journal + Logout. */
    function internalNav() {
        return '<div class="nav-container">' +
            '<div class="logo">' +
                '<a href="' + base + 'index.html"><img src="' + base + 'assets/images/logo.png" alt="Blue Chip Signals Logo"></a>' +
            '</div>' +
            '<button class="hamburger-menu" aria-label="Toggle menu">' +
                '<span class="bar"></span>' +
                '<span class="bar"></span>' +
                '<span class="bar"></span>' +
            '</button>' +
            '<ul class="nav-links">' +
                '<li><a href="' + base + 'dashboard.html"><i class="fas fa-tachometer-alt"></i> Dashboard</a></li>' +
                '<li><a href="' + base + 'account.html"><i class="fas fa-user-cog"></i> Account</a></li>' +
                '<li>' +
                    '<button class="logout-btn" onclick="logout()">' +
                        '<i class="fas fa-sign-out-alt"></i> Logout' +
                    '</button>' +
                '</li>' +
            '</ul>' +
        '</div>';
    }

    /* Minimal nav — just the logo bar, no links (e.g. welcome-setup.html). */
    function minimalNav() {
        return '<div class="nav-container">' +
            '<div class="logo">' +
                '<a href="' + base + 'index.html"><img src="' + base + 'assets/images/logo.png" alt="Blue Chip Signals Logo"></a>' +
            '</div>' +
        '</div>';
    }

})();
