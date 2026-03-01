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

    function buildNav(navType) {
        switch (navType) {
            case 'loggedin':  return loggedinNav();
            case 'internal':  return internalNav();
            case 'minimal':   return minimalNav();
            default:          return publicNav();
        }
    }

    /* Standard public nav — logo click redirects logged-in users to dashboard
       via redirectIfLoggedIn() on each page. */
    function publicNav() {
        var stocks = [
            { sym: 'SPY',  name: 'S&amp;P 500 ETF',   path: 'pages/signals/spy-signal.html'  },
            { sym: 'META', name: 'Meta Platforms',     path: 'pages/signals/meta-signal.html' },
            { sym: 'AAPL', name: 'Apple Inc.',         path: 'pages/signals/aapl-signal.html' },
            { sym: 'TSLA', name: 'Tesla Inc.',         path: 'pages/signals/tsla-signal.html' },
            { sym: 'NVDA', name: 'NVIDIA Corp.',       path: 'pages/signals/nvda-signal.html' },
            { sym: 'AMZN', name: 'Amazon.com',         path: 'pages/signals/amzn-signal.html' }
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
                '<a href="' + base + 'index.html"><img src="' + base + 'assets/images/logo.png" alt="Blue Chip Signals Logo"></a>' +
            '</div>' +
            '<button class="hamburger-menu" aria-label="Toggle menu">' +
                '<span class="bar"></span>' +
                '<span class="bar"></span>' +
                '<span class="bar"></span>' +
            '</button>' +
            '<ul class="nav-links">' +
                '<li class="nav-stocks-item">' +
                    '<a href="#" class="nav-stocks-trigger">SUPPORTED STOCKS <span class="stocks-caret">&#9660;</span></a>' +
                    '<ul class="nav-stocks-dropdown">' + desktopDropdownItems + '</ul>' +
                '</li>' +
                '<li class="nav-stocks-mobile-li"><button class="nav-stocks-mobile-btn">SUPPORTED STOCKS <span>&#8250;</span></button></li>' +
                '<li><a href="' + base + 'contact.html">CONTACT</a></li>' +
                '<li><a href="' + base + 'faq.html">FAQ</a></li>' +
                '<li><a href="' + base + 'about.html">ABOUT US</a></li>' +
                '<li><a href="' + base + 'login.html" class="login-btn" id="authButton">' +
                    '<i class="fas fa-sign-in-alt"></i> Login' +
                '</a></li>' +
            '</ul>' +
            '<div class="nav-sub-panel">' +
                '<button class="sub-panel-back">&#8592; Back</button>' +
                '<ul class="sub-panel-list">' + mobileSubPanelItems + '</ul>' +
            '</div>' +
        '</div>';
    }

    /* Always-logged-in nav — used by dashboard.html.
       Logo click redirects to index.html which bounces back to dashboard.
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
                '<li><a href="' + base + 'trading-journal.html">JOURNAL</a></li>' +
                '<li><a href="' + base + 'trade-planner.html">PLANNER</a></li>' +
                '<li><a href="' + base + 'contact.html">CONTACT</a></li>' +
                '<li><a href="' + base + 'faq.html">FAQ</a></li>' +
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
       Simple links to Dashboard, Journal, Planner, Account + Logout. */
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
                '<li><a href="' + base + 'dashboard.html">DASHBOARD</a></li>' +
                '<li><a href="' + base + 'trading-journal.html">JOURNAL</a></li>' +
                '<li><a href="' + base + 'trade-planner.html">PLANNER</a></li>' +
                '<li><a href="' + base + 'account.html">ACCOUNT</a></li>' +
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
