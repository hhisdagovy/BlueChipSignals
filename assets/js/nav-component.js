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

    /* ---------- Hamburger toggle ---------- */
    var hamburger   = nav.querySelector('.hamburger-menu');
    var navLinks    = nav.querySelector('.nav-links');
    var subPanelEl  = nav.querySelector('.nav-sub-panel');

    function closeMenu() {
        if (navLinks && navLinks.classList.contains('active')) {
            navLinks.classList.remove('active');
            navLinks.classList.remove('stocks-open');
            hamburger.classList.remove('is-open');
            nav.classList.remove('menu-open');
            if (subPanelEl) subPanelEl.classList.remove('active');
            unlockBodyScroll();
        }
    }

    if (hamburger && navLinks) {
        hamburger.addEventListener('click', function () {
            var isOpen = navLinks.classList.toggle('active');
            hamburger.classList.toggle('is-open', isOpen);
            nav.classList.toggle('menu-open', isOpen);
            if (isOpen) {
                lockBodyScroll();
            } else {
                if (subPanelEl) subPanelEl.classList.remove('active');
                navLinks.classList.remove('stocks-open');
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

    /* ---------- Mobile stocks sub-panel ---------- */
    var mobileStocksBtn = nav.querySelector('.nav-stocks-mobile-btn');
    var subPanelBack    = nav.querySelector('.sub-panel-back');

    if (mobileStocksBtn && subPanelEl) {
        mobileStocksBtn.addEventListener('click', function () {
            subPanelEl.classList.add('active');
            navLinks.classList.add('stocks-open');
        });
    }

    if (subPanelBack && subPanelEl) {
        subPanelBack.addEventListener('click', function () {
            subPanelEl.classList.remove('active');
            navLinks.classList.remove('stocks-open');
        });
    }

    /* ============================================================
       Nav HTML templates
       ============================================================ */

    /* Check the lightweight auth flag set by login.html / cleared on logout. */
    function isUserLoggedIn() {
        try {
            return !!(localStorage.getItem('bluechip_logged_in') ||
                      sessionStorage.getItem('bluechip_logged_in'));
        } catch (e) { return false; }
    }

    function buildNav(navType) {
        switch (navType) {
            case 'internal':  return internalNav();
            case 'minimal':   return minimalNav();
            /* 'loggedin' is a legacy alias -  falls through to the same logic */
            case 'loggedin':
            default:
                /* Public pages: show internal nav to authenticated users */
                return (isUserLoggedIn() ? internalNav() : publicNav());
        }
    }

    /* Define a fallback logout for public pages (contact, faq, roadmap, etc.)
       that don't import Firebase directly.  Protected pages override this with
       their own window.logout that calls Firebase signOut() before clearing. */
    if (typeof window.logout === 'undefined') {
        window.logout = function () {
            localStorage.removeItem('bluechip_logged_in');
            localStorage.removeItem('bluechip_user_email');
            localStorage.removeItem('bluechip_is_admin');
            sessionStorage.removeItem('bluechip_logged_in');
            sessionStorage.removeItem('bluechip_user_email');
            window.location.replace(base + 'login');
        };
    }

    /* Standard public nav -  logo click redirects logged-in users to dashboard
       via redirectIfLoggedIn() on each page. */
    function publicNav() {
        var stocks = [
            { sym: 'SPY',  name: 'S&amp;P 500 ETF',   path: 'pages/signals/spy-signal'  },
            { sym: 'META', name: 'Meta Platforms',     path: 'pages/signals/meta-signal' },
            { sym: 'AAPL', name: 'Apple Inc.',         path: 'pages/signals/aapl-signal' },
            { sym: 'TSLA', name: 'Tesla Inc.',         path: 'pages/signals/tsla-signal' },
            { sym: 'NVDA', name: 'NVIDIA Corp.',       path: 'pages/signals/nvda-signal' },
            { sym: 'AMZN', name: 'Amazon.com',         path: 'pages/signals/amzn-signal' }
        ];

        var desktopDropdownItems = stocks.map(function(s) {
            return '<li><a href="' + base + s.path + '">' +
                '<span class="sd-ticker">' + s.sym + '</span>' +
                '<span class="sd-name">'   + s.name + '</span>' +
            '</a></li>';
        }).join('');

        var mobileSubPanelItems = stocks.map(function(s) {
            return '<li><a href="' + base + s.path + '">' +
                '<span class="sd-ticker">' + s.sym + '</span>' +
                '<span class="sd-name">'   + s.name + '</span>' +
            '</a></li>';
        }).join('');

        return '<div class="nav-container">' +
            '<div class="logo">' +
                '<a href="' + base + 'index"><img src="' + base + 'assets/images/Crest logo.png" alt="Blue Chip Signals Logo"></a>' +
            '</div>' +
            '<button class="hamburger-menu" aria-label="Toggle menu">' +
                '<span class="bar"></span>' +
                '<span class="bar"></span>' +
                '<span class="bar"></span>' +
            '</button>' +
            '<ul class="nav-links">' +
                '<li class="nav-stocks-item">' +
                    '<a href="#" class="nav-stocks-trigger">SUPPORTED EQUITIES <span class="stocks-caret">&#9660;</span></a>' +
                    '<ul class="nav-stocks-dropdown">' + desktopDropdownItems + '</ul>' +
                '</li>' +
                '<li class="nav-stocks-mobile-li"><button class="nav-stocks-mobile-btn">SUPPORTED EQUITIES <span>&#8250;</span></button></li>' +
                '<li><a href="' + base + 'roadmap">ROADMAP</a></li>' +
                '<li><a href="' + base + 'contact">CONTACT</a></li>' +
                '<li><a href="' + base + 'faq">FAQ</a></li>' +
                '<li><a href="' + base + 'about">ABOUT US</a></li>' +
                '<li><a href="' + base + 'login" class="login-btn" id="authButton">' +
                    '<i class="fas fa-sign-in-alt"></i> Login' +
                '</a></li>' +
            '</ul>' +
            '<div class="nav-sub-panel">' +
                '<button class="sub-panel-back">&#8592; Back</button>' +
                '<ul class="sub-panel-list">' + mobileSubPanelItems + '</ul>' +
            '</div>' +
        '</div>';
    }

    /* Alias -  forwards to internalNav() so any page still using data-nav-type="loggedin"
       receives the same consistent logged-in nav. */
    function loggedinNav() {
        return internalNav();
    }

    /* Internal nav -  used by account.html, trading-journal.html, trade-planner.html.
       Logo click returns to dashboard. Links: Journal, Planner, Contact, FAQ + Logout.
       Admin link shown only when bluechip_is_admin flag is set in localStorage. */
    function internalNav() {
        var isAdmin = false;
        try { isAdmin = localStorage.getItem('bluechip_is_admin') === '1'; } catch (e) {}

        var navPlan = '';
        try { navPlan = String(sessionStorage.getItem('bcs_nav_plan') || '').toLowerCase(); } catch (e) {}
        /* Full bundle (and staff) get History; single-channel plans use dashboard live feed only */
        var historyLi = navPlan === 'single'
            ? ''
            : '<li><a href="' + base + 'signal-history">HISTORY</a></li>';

        var adminLink = isAdmin
            ? '<li><a href="' + base + 'admin" class="admin-nav-link" style="color:var(--primary-gold);font-weight:700;">' +
              '<i class="fas fa-shield-halved" style="font-size:0.8em;margin-right:0.3em;"></i>ADMIN</a></li>'
            : '';

        return '<div class="nav-container">' +
            '<div class="logo">' +
                '<a href="' + base + 'dashboard"><img src="' + base + 'assets/images/Crest logo.png" alt="Blue Chip Signals Logo"></a>' +
            '</div>' +
            '<button class="hamburger-menu" aria-label="Toggle menu">' +
                '<span class="bar"></span>' +
                '<span class="bar"></span>' +
                '<span class="bar"></span>' +
            '</button>' +
            '<ul class="nav-links">' +
                historyLi +
                '<li><a href="' + base + 'trading-journal">JOURNAL</a></li>' +
                '<li><a href="' + base + 'trade-planner">PLANNER</a></li>' +
                '<li><a href="' + base + 'roadmap">ROADMAP</a></li>' +
                '<li><a href="' + base + 'contact">CONTACT</a></li>' +
                '<li><a href="' + base + 'faq">FAQ</a></li>' +
                adminLink +
                '<li>' +
                    '<button class="logout-btn" onclick="logout()">' +
                        '<i class="fas fa-sign-out-alt"></i> Logout' +
                    '</button>' +
                '</li>' +
            '</ul>' +
        '</div>';
    }

    /* Minimal nav -  just the logo bar, no links (e.g. welcome-setup.html). */
    function minimalNav() {
        return '<div class="nav-container" style="justify-content:center;">' +
            '<div class="logo">' +
                '<a href="' + base + 'index"><img src="' + base + 'assets/images/Crest logo.png" alt="Blue Chip Signals Logo"></a>' +
            '</div>' +
        '</div>';
    }

    /* ── Admin link injection ──────────────────────────────────────────────
       Fired by dashboard.html after onAuthStateChanged confirms admin role.
       Injects the ADMIN link into the live nav without requiring a refresh.
       Guards against double-injection so it's safe to fire multiple times. */
    window.addEventListener('adminConfirmed', function () {
        var navLinks = nav.querySelector('.nav-links');
        if (!navLinks) return;
        if (navLinks.querySelector('.admin-nav-link')) return; /* already present */

        var logoutLi = navLinks.querySelector('li:last-child');
        var adminLi  = document.createElement('li');
        adminLi.innerHTML =
            '<a href="' + base + 'admin" class="admin-nav-link" ' +
            'style="color:var(--primary-gold);font-weight:700;">' +
            '<i class="fas fa-shield-halved" style="font-size:0.8em;margin-right:0.3em;"></i>ADMIN</a>';

        navLinks.insertBefore(adminLi, logoutLi);
    });

    /* Supabase staff check → ADMIN link on every internal (and logged-in public) page */
    if (type === 'internal' || (type === 'public' && isUserLoggedIn())) {
        setTimeout(function () {
            try {
                var href = new URL(base + 'assets/js/staff-nav-bootstrap.mjs', window.location.href).href;
                import(href).then(function (m) {
                    if (typeof m.syncStaffAdminNav === 'function') return m.syncStaffAdminNav();
                }).catch(function (e) {
                    console.warn('Staff nav bootstrap failed', e);
                });
            } catch (e) {
                console.warn('Staff nav bootstrap failed', e);
            }
        }, 0);
    }

})();
