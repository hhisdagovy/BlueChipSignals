(function () {
    const BACKEND_URL = 'https://bluechipsignals-production.up.railway.app';

    const TICKERS = ['SPY', 'TSLA', 'META', 'AAPL', 'NVDA', 'AMZN'];

    const STOCK_STYLES = {
        SPY:  { bg: 'rgba(179,161,125,0.15)', color: '#c9b037', top: 'linear-gradient(90deg,#c9b037,#e2cfb5)' },
        TSLA: { bg: 'rgba(232,33,39,0.12)',   color: '#e82127', top: 'linear-gradient(90deg,#e82127,#ff6b6b)' },
        META: { bg: 'rgba(91,158,255,0.12)',   color: '#5b9eff', top: 'linear-gradient(90deg,#5b9eff,#93c5fd)' },
        AAPL: { bg: 'rgba(200,200,200,0.12)',  color: '#c0c0c0', top: 'linear-gradient(90deg,#9ca3af,#d1d5db)' },
        NVDA: { bg: 'rgba(118,185,0,0.12)',    color: '#76b900', top: 'linear-gradient(90deg,#76b900,#a3e635)' },
        AMZN: { bg: 'rgba(255,153,0,0.12)',    color: '#ff9900', top: 'linear-gradient(90deg,#ff9900,#fbbf24)' },
    };

    /* ── Module-level state ── */
    var _tickerFilter    = null;   // hard lock for single-channel users (null = bundle/all)
    var _limit           = 9;
    var _interval        = null;
    var _allSignals      = [];     // cached last fetch result
    var _activeTicker    = 'ALL';  // user-selected filter pill
    var _activeDirection = 'ALL';  // 'ALL' | 'CALL' | 'PUT'

    /* ── Helpers ── */
    function timeAgo(ts) {
        const diff = Math.floor((Date.now() - new Date(ts + 'Z').getTime()) / 1000);
        if (diff < 60)    return diff + 's ago';
        if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        return Math.floor(diff / 86400) + 'd ago';
    }

    function formatExp(exp) {
        if (!exp) return '—';
        try {
            const d = new Date(exp + 'T12:00:00');
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        } catch (_) { return exp; }
    }

    /* ── Fetch ── */
    async function fetchSignals() {
        try {
            const res = await fetch(BACKEND_URL + '/api/signals/latest?limit=' + _limit, { cache: 'no-store' });
            const data = await res.json();
            return data.signals || [];
        } catch (e) {
            console.warn('[BCS] Could not reach backend:', e);
            return null;
        }
    }

    /* ── Card builder ── */
    function buildCard(s) {
        const style    = STOCK_STYLES[s.stock] || { bg: 'rgba(201,176,55,0.1)', color: '#c9b037', top: 'linear-gradient(90deg,#c9b037,#e2cfb5)' };
        const isCall   = (s.contract.type || '').toLowerCase() === 'call';
        const dirClass = isCall ? 'call' : 'put';
        const dirIcon  = isCall ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down';
        const dirLabel = isCall ? 'CALL' : 'PUT';
        const strike   = s.contract.strike  != null ? '$' + parseFloat(s.contract.strike).toFixed(2)  : '—';
        const premium  = s.contract.premium != null ? '$' + parseFloat(s.contract.premium).toFixed(2) : '—';
        const price    = s.price  != null ? '$' + parseFloat(s.price).toFixed(2)  : '—';
        const vwap     = s.vwap   != null ? '$' + parseFloat(s.vwap).toFixed(2)   : '—';
        const mfi      = s.mfi    != null ? parseFloat(s.mfi).toFixed(1)           : '—';
        const expFmt   = formatExp(s.contract.expiration);

        return '<div class="sig-card" style="--sig-top:' + style.top + ';">' +

            '<div class="sig-card-top">' +
                '<div class="sig-card-left">' +
                    '<span class="sig-ticker-badge" style="background:' + style.bg + ';color:' + style.color + ';">' + s.stock + '</span>' +
                    '<span class="sig-contract-type ' + dirClass + '"><i class="fas ' + dirIcon + '"></i> ' + dirLabel + '</span>' +
                '</div>' +
                '<span class="sig-time">' + timeAgo(s.timestamp) + '</span>' +
            '</div>' +

            '<span class="sig-entry-label">Entry Price</span>' +
            '<div class="sig-entry-price">' + price + '</div>' +

            '<div class="sig-stats-row">' +
                '<div class="sig-stat"><label>VWAP</label><span>' + vwap + '</span></div>' +
                '<div class="sig-stat"><label>MFI</label><span>' + mfi + '</span></div>' +
            '</div>' +

            '<div class="sig-contract-footer">' +
                '<span class="sig-contract-chip">' + strike + ' strike</span>' +
                '<span class="sig-contract-chip">' + premium + ' prem</span>' +
                '<span class="sig-contract-chip">Exp ' + expFmt + '</span>' +
            '</div>' +

            '<div class="sig-log-row">' +
                '<button class="sig-log-btn" onclick="logDashboardSignalToJournal(this)" ' +
                    'data-signal=\'' + JSON.stringify(s).replace(/'/g, '&#39;') + '\'>' +
                    '<i class="fas fa-book-open"></i> Log Trade' +
                '</button>' +
            '</div>' +

        '</div>';
    }

    /* ── Render (applies active filter on top of _allSignals) ── */
    function renderSignals(signals) {
        const container = document.getElementById('latest-signals-list');
        const badge     = document.getElementById('latest-signals-count');
        if (!container) return;

        if (signals === null) {
            container.innerHTML = '<p class="sig-empty"><i class="fas fa-circle-exclamation"></i> Could not reach signals server. Retrying…</p>';
            return;
        }

        /* Hard ticker lock for single-channel users */
        if (_tickerFilter) {
            signals = signals.filter(function (s) { return s.stock === _tickerFilter; }).slice(0, 9);
        } else {
            /* Bundle: apply interactive filters */
            if (_activeTicker !== 'ALL') {
                signals = signals.filter(function (s) { return s.stock === _activeTicker; });
            }
            if (_activeDirection !== 'ALL') {
                signals = signals.filter(function (s) {
                    return (s.contract.type || '').toLowerCase() === _activeDirection.toLowerCase();
                });
            }
            signals = signals.slice(0, 9);
        }

        if (badge) badge.textContent = signals.length;

        if (signals.length === 0) {
            container.innerHTML = '<p class="sig-empty"><i class="fas fa-satellite-dish"></i> No signals match this filter.</p>';
            return;
        }

        container.innerHTML = signals.map(buildCard).join('');

        container.querySelectorAll('.sig-card').forEach(function (card, i) {
            const s     = signals[i];
            const style = STOCK_STYLES[s.stock] || STOCK_STYLES.SPY;
            card.style.setProperty('--sig-top', style.top);
        });
    }

    /* ── Log a dashboard signal to the trading journal ── */
    window.logDashboardSignalToJournal = function(btn) {
        var s = JSON.parse(btn.dataset.signal);
        var dateStr = '';
        if (s.timestamp) {
            var d = new Date(s.timestamp + 'Z');
            if (!isNaN(d)) {
                var pad = function(n) { return String(n).padStart(2, '0'); };
                dateStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
                          'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
            }
        }
        var contractType = s.contract.type || '';
        var optionType   = contractType.charAt(0).toUpperCase() + contractType.slice(1).toLowerCase();
        localStorage.setItem('bcs_pending_journal_trade', JSON.stringify({
            source:         'signal',
            ticker:         s.stock,
            tradeType:      'Option',
            direction:      'Long',
            optionType:     optionType,
            entryPrice:     s.contract.premium,
            strikePrice:    s.contract.strike,
            expirationDate: s.contract.expiration,
            contracts:      1,
            date:           dateStr,
            notes:          'Signal: ' + s.stock + ' ' + contractType.toUpperCase() +
                            ' $' + s.contract.strike + ' \u2014 Stock entry: $' + s.price
        }));
        window.location.href = 'trading-journal.html';
    };

    /* ── Filter bar (injected for bundle users only) ── */
    function injectFilterBar() {
        const header = document.querySelector('.signals-section-header');
        if (!header || document.getElementById('sig-filter-bar')) return;

        var tickerPills = '<button class="sig-filter-pill active" data-ticker="ALL">All</button>' +
            TICKERS.map(function (t) {
                return '<button class="sig-filter-pill" data-ticker="' + t + '">' + t + '</button>';
            }).join('');

        var bar = document.createElement('div');
        bar.id        = 'sig-filter-bar';
        bar.className = 'sig-filter-bar';
        bar.innerHTML =
            '<div class="sig-filter-group" id="sig-ticker-group">' + tickerPills + '</div>' +
            '<div class="sig-filter-divider"></div>' +
            '<div class="sig-filter-group">' +
                '<button class="sig-filter-pill active" data-dir="ALL">All</button>' +
                '<button class="sig-filter-pill call" data-dir="CALL">Calls</button>' +
                '<button class="sig-filter-pill put"  data-dir="PUT">Puts</button>' +
            '</div>';

        header.after(bar);

        /* Event delegation */
        bar.addEventListener('click', function (e) {
            var pill = e.target.closest('.sig-filter-pill');
            if (!pill) return;

            if (pill.dataset.ticker !== undefined) {
                bar.querySelectorAll('[data-ticker]').forEach(function (p) { p.classList.remove('active'); });
                pill.classList.add('active');
                _activeTicker = pill.dataset.ticker;
            } else if (pill.dataset.dir !== undefined) {
                bar.querySelectorAll('[data-dir]').forEach(function (p) { p.classList.remove('active'); });
                pill.classList.add('active');
                _activeDirection = pill.dataset.dir;
            }

            renderSignals(_allSignals);
        });
    }

    /* ── Run cycle ── */
    async function _run() {
        const raw = await fetchSignals();
        if (raw !== null) _allSignals = raw;
        renderSignals(_allSignals.length ? _allSignals : raw);

        if (_interval) clearInterval(_interval);
        _interval = setInterval(async function () {
            const fresh = await fetchSignals();
            if (fresh !== null) _allSignals = fresh;
            renderSignals(_allSignals);
        }, 5 * 60 * 1000);
    }

    /* ── Public API — called by dashboard.html after Firebase auth resolves ── */
    window.BCSSignals = {
        init: function (options) {
            _tickerFilter    = (options && options.tickerFilter) ? options.tickerFilter.toUpperCase() : null;
            _limit           = _tickerFilter ? 30 : 50;
            _activeTicker    = 'ALL';
            _activeDirection = 'ALL';

            /* Inject the interactive filter bar only for bundle/legacy users */
            if (!_tickerFilter) injectFilterBar();

            _run();
        },

        /* Re-filter the cached signals without a new fetch */
        filter: function (opts) {
            if (opts && opts.ticker)    _activeTicker    = opts.ticker.toUpperCase();
            if (opts && opts.direction) _activeDirection = opts.direction.toUpperCase();
            renderSignals(_allSignals);
        }
    };
})();
