(function () {
    const BACKEND_URL = 'https://bluechipsignals-production.up.railway.app';

    const STOCK_STYLES = {
        SPY:  { bg: 'rgba(179,161,125,0.15)', color: '#c9b037', top: 'linear-gradient(90deg,#c9b037,#e2cfb5)' },
        TSLA: { bg: 'rgba(232,33,39,0.12)',   color: '#e82127', top: 'linear-gradient(90deg,#e82127,#ff6b6b)' },
        META: { bg: 'rgba(91,158,255,0.12)',   color: '#5b9eff', top: 'linear-gradient(90deg,#5b9eff,#93c5fd)' },
        AAPL: { bg: 'rgba(200,200,200,0.12)',  color: '#c0c0c0', top: 'linear-gradient(90deg,#9ca3af,#d1d5db)' },
        NVDA: { bg: 'rgba(118,185,0,0.12)',    color: '#76b900', top: 'linear-gradient(90deg,#76b900,#a3e635)' },
        AMZN: { bg: 'rgba(255,153,0,0.12)',    color: '#ff9900', top: 'linear-gradient(90deg,#ff9900,#fbbf24)' },
    };

    /* Module-level state set by init() */
    var _tickerFilter = null;
    var _limit        = 9;
    var _interval     = null;

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

    function buildCard(s) {
        const style     = STOCK_STYLES[s.stock] || { bg: 'rgba(201,176,55,0.1)', color: '#c9b037', top: 'linear-gradient(90deg,#c9b037,#e2cfb5)' };
        const isCall    = (s.contract.type || '').toLowerCase() === 'call';
        const dirClass  = isCall ? 'call' : 'put';
        const dirIcon   = isCall ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down';
        const dirLabel  = isCall ? 'CALL' : 'PUT';
        const strike    = s.contract.strike  != null ? '$' + parseFloat(s.contract.strike).toFixed(2)  : '—';
        const premium   = s.contract.premium != null ? '$' + parseFloat(s.contract.premium).toFixed(2) : '—';
        const price     = s.price  != null ? '$' + parseFloat(s.price).toFixed(2)  : '—';
        const vwap      = s.vwap   != null ? '$' + parseFloat(s.vwap).toFixed(2)   : '—';
        const mfi       = s.mfi    != null ? parseFloat(s.mfi).toFixed(1)           : '—';
        const expFmt    = formatExp(s.contract.expiration);

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
        '</div>';
    }

    function renderSignals(signals) {
        const container = document.getElementById('latest-signals-list');
        const badge     = document.getElementById('latest-signals-count');
        if (!container) return;

        if (signals === null) {
            container.innerHTML = '<p class="sig-empty"><i class="fas fa-circle-exclamation"></i> Could not reach signals server. Retrying…</p>';
            return;
        }

        /* Filter to the user's ticker when on a single-channel plan */
        if (_tickerFilter) {
            signals = signals.filter(function (s) { return s.stock === _tickerFilter; }).slice(0, 9);
        }

        if (badge) badge.textContent = signals.length;

        if (signals.length === 0) {
            container.innerHTML = '<p class="sig-empty"><i class="fas fa-satellite-dish"></i> No Signals Yet</p>';
            return;
        }

        container.innerHTML = signals.map(buildCard).join('');

        /* Apply the per-card top accent colour via inline style (CSS var workaround) */
        container.querySelectorAll('.sig-card').forEach(function (card, i) {
            const s     = signals[i];
            const style = STOCK_STYLES[s.stock] || STOCK_STYLES.SPY;
            card.style.setProperty('--sig-top', style.top);
            /* The ::before pseudo-element reads this var */
        });
    }

    async function _run() {
        renderSignals(await fetchSignals());

        /* Clear any previous interval before starting a new one */
        if (_interval) clearInterval(_interval);
        _interval = setInterval(async function () {
            renderSignals(await fetchSignals());
        }, 5 * 60 * 1000);
    }

    /* Exposed API — called by dashboard.html after Firebase auth resolves */
    window.BCSSignals = {
        init: function (options) {
            _tickerFilter = (options && options.tickerFilter) ? options.tickerFilter.toUpperCase() : null;
            _limit        = _tickerFilter ? 30 : 9;
            _run();
        }
    };
})();
