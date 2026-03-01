/**
 * guide-nav.js
 * Auto-detects the ticker from the current guide page URL,
 * replaces the back-button with a guide-switcher pill that opens
 * an in-page modal listing all guides for that ticker.
 */
(function () {

    /* ── Guide data map ── */
    var GUIDES = {
        SPY: {
            label: 'SPY Guides',
            signalPage: '../signals/spy-signal.html',
            guides: [
                { icon: 'fas fa-chart-pie',     title: 'Economic Data Monitor',    desc: 'CPI, PPI, Fed decisions & GDP — get ahead of market-moving releases.',        path: '../guides/spy-economic-data.html' },
                { icon: 'fas fa-heartbeat',     title: 'Fear & Greed / VIX',       desc: 'Monitor the VIX and sentiment index to time your SPY entries.',               path: '../guides/spy-vix.html' },
                { icon: 'fas fa-calculator',    title: 'S/R Level Calculator',     desc: 'Key support and resistance zones using pivot points and Fibonacci.',           path: '../guides/spy-support-resistance.html' }
            ]
        },
        TSLA: {
            label: 'TSLA Guides',
            signalPage: '../signals/tsla-signal.html',
            guides: [
                { icon: 'fas fa-user-tie',      title: 'Elon Musk Tracker',        desc: 'Monitor Elon\'s communications for early price-moving announcements.',        path: '../guides/tsla-elon-communications.html' },
                { icon: 'fas fa-truck',         title: 'Delivery Report Calendar', desc: 'Tesla\'s quarterly delivery numbers — the biggest recurring catalyst.',        path: '../guides/tsla-delivery-production.html' },
                { icon: 'fas fa-chart-line',    title: 'Trend Analyzer',           desc: 'Identify TSLA\'s trend direction and manage volatility in winning trades.',    path: '../guides/tsla-trend-following.html' }
            ]
        },
        META: {
            label: 'META Guides',
            signalPage: '../signals/meta-signal.html',
            guides: [
                { icon: 'fas fa-ad',            title: 'Ad Revenue Tracker',       desc: 'Quarterly ad revenue trends and seasonal patterns that drive big moves.',      path: '../guides/meta-ad-revenue-growth.html' },
                { icon: 'fas fa-chart-area',    title: 'Earnings Trading Guide',   desc: 'Position before and after META earnings + the four critical gap levels.',     path: '../guides/meta-earnings-trading.html' },
                { icon: 'fas fa-gavel',         title: 'Regulatory News Monitor',  desc: 'EU privacy rulings, antitrust cases & FTC actions that move META.',            path: '../guides/meta-regulatory-news.html' }
            ]
        },
        AAPL: {
            label: 'AAPL Guides',
            signalPage: '../signals/aapl-signal.html',
            guides: [
                { icon: 'fas fa-industry',      title: 'Product Cycles & Suppliers', desc: 'iPhone cycle playbook and key supply-chain signals from TSMC & Foxconn.',   path: '../guides/aapl-product-cycles.html' },
                { icon: 'fas fa-chart-line',    title: 'Orderly Pullbacks Guide',    desc: 'Identify high-probability bounce entries within AAPL\'s structured trends.', path: '../guides/aapl-orderly-pullbacks.html' },
                { icon: 'fas fa-eye',           title: 'Options Volume Monitor',     desc: 'Track unusual options activity to spot institutional positioning early.',     path: '../guides/aapl-options-volume.html' }
            ]
        },
        NVDA: {
            label: 'NVDA Guides',
            signalPage: '../signals/nvda-signal.html',
            guides: [
                { icon: 'fas fa-robot',         title: 'AI & Sector Tracker',      desc: 'AI news, compute demand, NVIDIA partnerships & SMH sector correlation.',      path: '../guides/nvda-ai-sector-news.html' },
                { icon: 'fas fa-calendar-alt',  title: 'Earnings Calendar',        desc: 'NVDA earnings history and typical post-earnings move size.',                   path: '../guides/nvda-earnings-history.html' },
                { icon: 'fas fa-chart-area',    title: 'Parabolic Move Guide',     desc: 'Manage entries and exits during NVDA\'s characteristic parabolic phases.',    path: '../guides/nvda-parabolic-moves.html' }
            ]
        },
        AMZN: {
            label: 'AMZN Guides',
            signalPage: '../signals/amzn-signal.html',
            guides: [
                { icon: 'fas fa-cloud',         title: 'AWS News Tracker',          desc: 'Monitor AWS announcements and cloud revenue trends driving AMZN moves.',     path: '../guides/amzn-aws-news.html' },
                { icon: 'fas fa-shopping-cart', title: 'Prime Day Calendar',        desc: 'Annual Prime Day history and typical AMZN price behaviour around events.',   path: '../guides/amzn-prime-day.html' },
                { icon: 'fas fa-layer-group',   title: 'Support/Resistance Zones',  desc: 'Key structural zones where AMZN consistently finds buyers or sellers.',      path: '../guides/amzn-support-resistance.html' }
            ]
        }
    };

    /* ── Detect ticker from filename ── */
    function detectTicker() {
        var filename = window.location.pathname.split('/').pop().toLowerCase();
        var tickers = Object.keys(GUIDES);
        for (var i = 0; i < tickers.length; i++) {
            if (filename.indexOf(tickers[i].toLowerCase() + '-') === 0) {
                return tickers[i];
            }
        }
        return null;
    }

    /* ── Inject modal CSS ── */
    function injectStyles() {
        var style = document.createElement('style');
        style.textContent = [
            '.gn-switcher{display:inline-flex;align-items:center;gap:.5rem;color:var(--primary-gold);',
            'font-weight:600;font-size:.9rem;padding:.5rem 1.25rem;border:1px solid rgba(201,176,55,.3);',
            'border-radius:50px;background:rgba(201,176,55,.06);margin-bottom:2rem;cursor:pointer;',
            'transition:border-color .25s,background .25s,transform .25s;text-decoration:none;}',
            '.gn-switcher:hover{border-color:rgba(201,176,55,.55);background:rgba(201,176,55,.12);}',
            '.gn-switcher .gn-arrow{font-size:.7rem;opacity:.7;}',

            '.gn-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);',
            'backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);z-index:2000;',
            'align-items:center;justify-content:center;padding:1.5rem;}',
            '.gn-backdrop.open{display:flex;}',

            '.gn-modal{background:rgba(8,11,18,.97);border:1px solid rgba(201,176,55,.28);',
            'border-radius:18px;width:100%;max-width:460px;',
            'box-shadow:0 24px 64px rgba(0,0,0,.6);',
            'animation:gnIn .22s cubic-bezier(.22,1,.36,1) both;overflow:hidden;}',
            '@keyframes gnIn{from{opacity:0;transform:translateY(18px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}',

            '.gn-header{display:flex;align-items:center;justify-content:space-between;',
            'padding:1.25rem 1.5rem 1rem;border-bottom:1px solid rgba(201,176,55,.1);}',
            '.gn-header h3{font-size:1rem;font-weight:700;color:var(--light-text);margin:0;}',
            '.gn-close{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);',
            'border-radius:8px;color:var(--gray-text);width:30px;height:30px;display:flex;',
            'align-items:center;justify-content:center;cursor:pointer;font-size:.8rem;',
            'transition:background .2s,color .2s;}',
            '.gn-close:hover{background:rgba(255,255,255,.12);color:var(--light-text);}',

            '.gn-list{padding:.85rem;display:flex;flex-direction:column;gap:.5rem;}',

            '.gn-item{display:flex;align-items:center;gap:1rem;padding:.9rem 1rem;',
            'border:1px solid rgba(201,176,55,.1);border-radius:12px;',
            'background:rgba(26,31,46,.4);text-decoration:none;',
            'transition:border-color .2s,background .2s,transform .2s;}',
            '.gn-item:hover{border-color:rgba(201,176,55,.4);background:rgba(201,176,55,.07);transform:translateX(3px);}',
            '.gn-item.active{border-color:rgba(201,176,55,.5);background:rgba(201,176,55,.1);}',

            '.gn-icon{width:38px;height:38px;border-radius:10px;',
            'background:linear-gradient(135deg,rgba(201,176,55,.18),rgba(201,176,55,.06));',
            'border:1px solid rgba(201,176,55,.2);display:flex;align-items:center;',
            'justify-content:center;color:var(--primary-gold);font-size:.9rem;flex-shrink:0;}',

            '.gn-info{flex:1;min-width:0;}',
            '.gn-info strong{display:block;font-size:.88rem;font-weight:700;color:var(--light-text);margin-bottom:.2rem;}',
            '.gn-info span{display:block;font-size:.76rem;color:var(--gray-text);line-height:1.4;',
            'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',

            '.gn-chevron{color:rgba(201,176,55,.4);font-size:.75rem;',
            'transition:color .2s,transform .2s;flex-shrink:0;}',
            '.gn-item:hover .gn-chevron{color:var(--primary-gold);transform:translateX(3px);}',
            '.gn-item.active .gn-chevron{color:var(--primary-gold);}',

            '.gn-footer{padding:.75rem 1.5rem 1rem;text-align:center;',
            'border-top:1px solid rgba(201,176,55,.08);}',
            '.gn-footer a{font-size:.78rem;color:var(--gray-text);text-decoration:none;transition:color .2s;}',
            '.gn-footer a:hover{color:var(--primary-gold);}'
        ].join('');
        document.head.appendChild(style);
    }

    /* ── Build modal HTML ── */
    function buildModal(ticker, data, currentFile) {
        var rows = data.guides.map(function (g) {
            var isCurrent = currentFile && g.path.indexOf(currentFile) !== -1;
            return '<a class="gn-item' + (isCurrent ? ' active' : '') + '" href="' + g.path + '">' +
                '<div class="gn-icon"><i class="' + g.icon + '"></i></div>' +
                '<div class="gn-info"><strong>' + g.title + '</strong><span>' + g.desc + '</span></div>' +
                '<i class="fas fa-chevron-right gn-chevron"></i>' +
            '</a>';
        }).join('');

        var el = document.createElement('div');
        el.id = 'gnBackdrop';
        el.className = 'gn-backdrop';
        el.innerHTML =
            '<div class="gn-modal">' +
                '<div class="gn-header">' +
                    '<h3>' + data.label + '</h3>' +
                    '<button class="gn-close" id="gnClose"><i class="fas fa-times"></i></button>' +
                '</div>' +
                '<div class="gn-list">' + rows + '</div>' +
                '<div class="gn-footer"><a href="' + data.signalPage + '">View full signal page &rarr;</a></div>' +
            '</div>';
        return el;
    }

    /* ── Init ── */
    document.addEventListener('DOMContentLoaded', function () {
        var ticker = detectTicker();
        if (!ticker) return;

        var data = GUIDES[ticker];
        var currentFile = window.location.pathname.split('/').pop();

        injectStyles();

        /* Replace back-button */
        var btn = document.querySelector('.back-button');
        if (btn) {
            var switcher = document.createElement('button');
            switcher.className = 'gn-switcher';
            switcher.innerHTML =
                ticker + ' Guides' +
                '<i class="fas fa-chevron-down gn-arrow"></i>';
            switcher.setAttribute('aria-label', 'Switch guide');
            btn.parentNode.replaceChild(switcher, btn);

            switcher.addEventListener('click', openModal);
        }

        /* Inject modal */
        var backdrop = buildModal(ticker, data, currentFile);
        document.body.appendChild(backdrop);

        /* Event wiring */
        backdrop.addEventListener('click', function (e) {
            if (e.target === backdrop) closeModal();
        });
        document.getElementById('gnClose').addEventListener('click', closeModal);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeModal();
        });

        function openModal() {
            backdrop.classList.add('open');
            document.body.style.overflow = 'hidden';
        }

        function closeModal() {
            backdrop.classList.remove('open');
            document.body.style.overflow = '';
        }
    });

})();
