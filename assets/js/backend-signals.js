(function () {
    const BACKEND_URL = 'https://bluechipsignals-production.up.railway.app';

    const STOCK_STYLES = {
        SPY:  { bg: 'rgba(179,161,125,0.15)', color: 'var(--primary-gold)' },
        TSLA: { bg: 'rgba(232,33,39,0.12)',   color: '#e82127' },
        META: { bg: 'rgba(91,158,255,0.12)',   color: '#5b9eff' },
        AAPL: { bg: 'rgba(200,200,200,0.12)',  color: '#c0c0c0' },
        NVDA: { bg: 'rgba(118,185,0,0.12)',    color: '#76b900' },
        AMZN: { bg: 'rgba(255,153,0,0.12)',    color: '#ff9900' },
    };

    function timeAgo(ts) {
        const diff = Math.floor((Date.now() - new Date(ts + 'Z').getTime()) / 1000);
        if (diff < 60)    return diff + 's ago';
        if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        return Math.floor(diff / 86400) + 'd ago';
    }

    async function fetchSignals() {
        try {
            const res = await fetch(BACKEND_URL + '/api/signals/latest?limit=10', { cache: 'no-store' });
            const data = await res.json();
            return data.signals || [];
        } catch (e) {
            console.warn('[BCS] Could not reach backend:', e);
            return null;
        }
    }

    function renderSignals(signals) {
        const container = document.getElementById('latest-signals-list');
        const badge     = document.getElementById('latest-signals-count');
        if (!container) return;

        if (signals === null) {
            container.innerHTML = '<p class="lsig-empty"><i class="fas fa-circle-exclamation"></i> Could not reach signals server. Retrying…</p>';
            return;
        }

        if (badge) badge.textContent = signals.length;

        if (signals.length === 0) {
            container.innerHTML = '<p class="lsig-empty"><i class="fas fa-satellite-dish"></i> No signals yet — they will appear here once the bot fires.</p>';
            return;
        }

        container.innerHTML = signals.map(function (s) {
            const style   = STOCK_STYLES[s.stock] || { bg: 'rgba(201,176,55,0.1)', color: 'var(--primary-gold)' };
            const isCall  = (s.contract.type || '').toLowerCase() === 'call';
            const dirCol  = isCall ? '#4ade80' : '#ef4444';
            const dirIcon = isCall ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down';
            const strike  = s.contract.strike  != null ? '$' + parseFloat(s.contract.strike).toFixed(2)  : '—';
            const premium = s.contract.premium != null ? '$' + parseFloat(s.contract.premium).toFixed(2) : '—';
            const expiry  = s.contract.expiration || '—';
            const price   = s.price != null ? '$' + parseFloat(s.price).toFixed(2) : '—';

            return '<div class="lsig-row">' +
                '<span class="lsig-badge" style="background:' + style.bg + ';color:' + style.color + ';">' + s.stock + '</span>' +
                '<span class="lsig-type" style="color:' + dirCol + ';"><i class="fas ' + dirIcon + '"></i> ' + s.contract.type + '</span>' +
                '<span class="lsig-chip">' + strike + ' strike</span>' +
                '<span class="lsig-chip">' + premium + ' prem</span>' +
                '<span class="lsig-chip">Exp ' + expiry + '</span>' +
                '<span class="lsig-entry">@ ' + price + '</span>' +
                '<span class="lsig-time">' + timeAgo(s.timestamp) + '</span>' +
            '</div>';
        }).join('');
    }

    async function init() {
        const signals = await fetchSignals();
        renderSignals(signals);
        /* Refresh every 5 minutes */
        setInterval(async function () {
            renderSignals(await fetchSignals());
        }, 5 * 60 * 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
