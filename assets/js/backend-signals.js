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
    var _supabaseClient  = null;   // set via BCSSignals.init({ supabase })
    /** @type {Record<string, boolean>|null|undefined} null/undefined = all channels on */
    var _channelEnabled  = null;

    /* ── Carousel state ── */
    var _carouselIndex   = 0;
    var _carouselSignals = [];     // current filtered set rendered in carousel
    var _autoplayTimer   = null;   // auto-rotate interval

    /* ── Helpers ── */
    function timeAgo(ts) {
        const diff = Math.floor((Date.now() - new Date(ts + 'Z').getTime()) / 1000);
        if (diff < 60)    return diff + 's ago';
        if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        return Math.floor(diff / 86400) + 'd ago';
    }

    function formatExp(exp) {
        if (!exp) return '-';
        try {
            const d = new Date(exp + 'T12:00:00');
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        } catch (_) { return exp; }
    }

    /* ── Fetch (REST fallback only) ── */
    async function fetchSignalsREST() {
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
        const strike   = s.contract.strike  != null ? '$' + parseFloat(s.contract.strike).toFixed(2)  : '-';
        const premium  = s.contract.premium != null ? '$' + parseFloat(s.contract.premium).toFixed(2) : '-';
        const price    = s.price  != null ? '$' + parseFloat(s.price).toFixed(2)  : '-';
        const vwap     = s.vwap   != null ? '$' + parseFloat(s.vwap).toFixed(2)   : '-';
        const mfi      = s.mfi    != null ? parseFloat(s.mfi).toFixed(1)           : '-';
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

        '</div>';
    }

    /* ── Carousel: update classes + dots + counter ── */
    function _updateCarousel(index) {
        var container = document.getElementById('latest-signals-list');
        if (!container) return;

        var cards = container.querySelectorAll('.sig-card');
        var n = cards.length;
        if (!n) return;

        _carouselIndex = index;

        cards.forEach(function (card, i) {
            card.classList.remove('active', 'next', 'prev', 'hidden');
            if (i === index) {
                card.classList.add('active');
            } else if (i === (index + 1) % n) {
                card.classList.add('next');
            } else if (i === (index - 1 + n) % n) {
                card.classList.add('prev');
            } else {
                card.classList.add('hidden');
            }
        });

        /* Update dots */
        var dotsEl = document.getElementById('sig-carousel-dots');
        if (dotsEl) {
            dotsEl.querySelectorAll('.sig-carousel-dot').forEach(function (dot, i) {
                dot.classList.toggle('active', i === index);
            });
        }

        /* Sync track height to active card */
        var active = container.querySelector('.sig-card.active');
        if (active) container.style.height = active.offsetHeight + 'px';
    }

    /* ── Carousel: inject cards + dots, start auto-rotate ── */
    function _renderCarousel() {
        var container = document.getElementById('latest-signals-list');
        if (!container) return;

        var n = _carouselSignals.length;

        /* Inject all cards */
        container.innerHTML = _carouselSignals.map(buildCard).join('');

        /* Build dots */
        var dotsEl = document.getElementById('sig-carousel-dots');
        if (dotsEl) {
            dotsEl.innerHTML = _carouselSignals.map(function (_, i) {
                return '<button class="sig-carousel-dot" aria-label="Signal ' + (i + 1) + '" data-idx="' + i + '"></button>';
            }).join('');

            /* Dot click events */
            dotsEl.querySelectorAll('.sig-carousel-dot').forEach(function (dot) {
                dot.addEventListener('click', function () {
                    _updateCarousel(parseInt(this.dataset.idx, 10));
                });
            });
        }

        /* Click on peeking prev/next cards to advance */
        container.addEventListener('click', function (e) {
            var card = e.target.closest('.sig-card');
            if (!card) return;
            var total = _carouselSignals.length;
            if (!total) return;
            if (card.classList.contains('next')) {
                _updateCarousel((_carouselIndex + 1) % total);
            } else if (card.classList.contains('prev')) {
                _updateCarousel((_carouselIndex - 1 + total) % total);
            }
        });

        /* Hide footer when empty */
        var footer = document.querySelector('.sig-carousel-footer');
        if (footer) footer.style.display = n > 0 ? '' : 'none';

        /* Initial positioning */
        _updateCarousel(0);

        /* Correct track height after paint (cards are position:absolute so track has 0 natural height) */
        requestAnimationFrame(function () {
            var active = container.querySelector('.sig-card.active');
            if (active) container.style.height = active.offsetHeight + 'px';
        });

        /* Auto-rotate every 3 seconds, matching homepage carousel */
        if (_autoplayTimer) clearInterval(_autoplayTimer);
        _autoplayTimer = setInterval(function () {
            if (!_carouselSignals.length) return;
            _updateCarousel((_carouselIndex + 1) % _carouselSignals.length);
        }, 3000);
    }

    /* ── Carousel: store filtered set and re-render from index 0 ── */
    function _buildCarousel(signals) {
        _carouselSignals = signals;
        _carouselIndex   = 0;
        _renderCarousel();
    }

    /* ── Render (applies active filter on top of _allSignals) ── */
    function renderSignals(signals) {
        var container = document.getElementById('latest-signals-list');
        var badge     = document.getElementById('latest-signals-count');
        if (!container) return;

        if (signals === null) {
            container.style.height = '';
            container.innerHTML = '<p class="sig-empty"><i class="fas fa-circle-exclamation"></i> Could not reach signals server. Retrying…</p>';
            var footer = document.querySelector('.sig-carousel-footer');
            if (footer) footer.style.display = 'none';
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

        if (_channelEnabled && typeof _channelEnabled === 'object') {
            signals = signals.filter(function (s) {
                return _channelEnabled[s.stock] !== false;
            });
        }

        if (badge) badge.textContent = signals.length;

        if (signals.length === 0) {
            container.style.height = '';
            container.innerHTML = '<p class="sig-empty"><i class="fas fa-satellite-dish"></i> No signals match this filter.</p>';
            var footer = document.querySelector('.sig-carousel-footer');
            if (footer) footer.style.display = 'none';
            return;
        }

        _buildCarousel(signals);
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
        window.location.href = 'trading-journal';
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

        /* Event delegation -  filter changes snap carousel back to index 0 */
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

    function normalizeSupabaseRow(row, id) {
        var ts = row.timestamp;
        if (ts && typeof ts === 'string') {
            ts = ts.replace('T', ' ').slice(0, 19);
        } else if (ts && typeof ts.toISOString === 'function') {
            ts = ts.toISOString().replace('T', ' ').slice(0, 19);
        } else {
            ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        }
        return {
            id: id || row.id,
            stock: row.stock,
            price: row.price,
            vwap: row.vwap,
            mfi: row.mfi,
            timestamp: ts,
            contract: {
                type: row.contract_type,
                strike: row.strike,
                premium: row.premium,
                expiration: row.expiration,
                volume: row.volume || 0
            }
        };
    }

    /* ── Normalize flat Firestore/demo signal → nested contract shape for buildCard ── */
    function normalizeFirestoreDoc(data, id) {
        /* Convert Firestore Timestamp object to "YYYY-MM-DD HH:MM:SS" string */
        var ts = data.timestamp;
        if (ts && typeof ts.toDate === 'function') {
            ts = ts.toDate().toISOString().replace('T', ' ').slice(0, 19);
        } else if (ts instanceof Date) {
            ts = ts.toISOString().replace('T', ' ').slice(0, 19);
        } else if (!ts) {
            ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        }
        return {
            id:        id || data.id,
            stock:     data.stock,
            price:     data.price,
            vwap:      data.vwap,
            mfi:       data.mfi,
            timestamp: ts,
            contract: {
                type:       data.contractType,
                strike:     data.strike,
                premium:    data.premium,
                expiration: data.expiration,
                volume:     data.volume || 0
            }
        };
    }

    async function refreshChannelTogglesFromSupabase() {
        if (!_supabaseClient) return;
        try {
            var res = await _supabaseClient
                .from('bcs_site_documents')
                .select('data')
                .eq('id', 'signals')
                .maybeSingle();
            if (!res.error && res.data && res.data.data && typeof res.data.data === 'object') {
                _channelEnabled = res.data.data;
            }
        } catch (e) {
            console.warn('[BCS] channel toggles fetch failed:', e);
        }
    }

    async function pullSupabaseSignals() {
        if (!_supabaseClient) {
            _runREST();
            return;
        }
        try {
            var q = _supabaseClient
                .from('bcs_signals')
                .select('*')
                .order('timestamp', { ascending: false })
                .limit(_limit);
            if (_tickerFilter && _tickerFilter !== '__NO_ACCESS__') {
                q = q.eq('stock', _tickerFilter);
            }
            var result = await q;
            if (result.error) {
                console.warn('[BCS] Supabase signals error:', result.error);
                _runREST();
                return;
            }
            _allSignals = (result.data || []).map(function (row) {
                return normalizeSupabaseRow(row, row.id);
            });
            renderSignals(_allSignals);
        } catch (e) {
            console.warn('[BCS] Supabase signals fetch failed:', e);
            _runREST();
        }
    }

    function listenSupabase() {
        pullSupabaseSignals();
        if (_interval) clearInterval(_interval);
        _interval = setInterval(pullSupabaseSignals, 30000);
    }

    /* ── REST polling fallback ── */
    async function _runREST() {
        const raw = await fetchSignalsREST();
        if (raw !== null) _allSignals = raw;
        renderSignals(_allSignals.length ? _allSignals : raw);

        if (_interval) clearInterval(_interval);
        _interval = setInterval(async function () {
            const fresh = await fetchSignalsREST();
            if (fresh !== null) _allSignals = fresh;
            renderSignals(_allSignals);
        }, 5 * 60 * 1000);
    }

    /* ── Public API -  called by dashboard.html after Firebase auth resolves ── */
    window.BCSSignals = {
        init: function (options) {
            _tickerFilter    = (options && options.tickerFilter) ? options.tickerFilter.toUpperCase() : null;
            _limit           = _tickerFilter ? 30 : 50;
            _activeTicker    = 'ALL';
            _activeDirection = 'ALL';
            _supabaseClient  = options && options.supabase ? options.supabase : null;
            if (options && Object.prototype.hasOwnProperty.call(options, 'channelEnabled')) {
                _channelEnabled = options.channelEnabled && typeof options.channelEnabled === 'object'
                    ? options.channelEnabled
                    : null;
            } else {
                _channelEnabled = null;
            }

            /* Demo mode: render mock signals, skip network fetch */
            if (window._BCS_DEMO_SIGNALS) {
                var demoSignals = window._BCS_DEMO_SIGNALS.map(function (s) {
                    return normalizeFirestoreDoc(s, s.id);
                });
                window._BCS_DEMO_SIGNALS = null;
                _allSignals = demoSignals;
                renderSignals(demoSignals);
                return;
            }

            if (_supabaseClient) {
                var startListen = function () { listenSupabase(); };
                if (_channelEnabled && typeof _channelEnabled === 'object') {
                    startListen();
                } else {
                    refreshChannelTogglesFromSupabase().then(startListen).catch(startListen);
                }
            } else {
                _runREST();
            }
        },

        /* Re-filter the cached signals without a new fetch */
        filter: function (opts) {
            if (opts && opts.ticker)    _activeTicker    = opts.ticker.toUpperCase();
            if (opts && opts.direction) _activeDirection = opts.direction.toUpperCase();
            renderSignals(_allSignals);
        }
    };
})();
