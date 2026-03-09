/* ─────────────────────────────────────────────────────────────────────────────
   BCS Demo Data  -   window.BCS_DEMO
   Loaded as a plain (non-module) script on dashboard, journal, planner,
   and signal-history pages so the data is available before module scripts run.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {

    /* ── Mock user profile ─────────────────────────────────────────────────── */
    var USER = {
        firstName:          'Alex',
        plan:               'bundle',
        subscriptionStatus: 'Active',
        joinedDate:         '2025-01-15',
        isDemo:             true
    };

    /* ── Mock trades  (22 closed + 3 open = 25 total)
          16 wins / 6 losses  →  73 % win rate  |  net +$4,040 P&L
          Dates spread across Jan 3 – Mar 4 2026 for a populated heatmap
       ─────────────────────────────────────────────────────────────────────── */
    var TRADES = [
        // ── Wins ────────────────────────────────────────────────────────────
        { id:'d001', tradeType:'Option', ticker:'SPY',  direction:'Long', optionType:'Call', strikePrice:590, expirationDate:'2026-01-10', contracts:1, entryPrice:3.20, exitPrice:6.40, status:'Closed', pnl:320,  date:'2026-01-03T14:30', strategy:'Orderly Pullbacks',  entryReason:'Strong VWAP reclaim with MFI confirmation', exitReason:'Target hit',    notes:'' },
        { id:'d002', tradeType:'Option', ticker:'NVDA', direction:'Long', optionType:'Call', strikePrice:640, expirationDate:'2026-01-17', contracts:1, entryPrice:8.50, exitPrice:13.70, status:'Closed', pnl:520, date:'2026-01-06T10:15', strategy:'Supplier News',       entryReason:'Gap up on analyst upgrade', exitReason:'Target hit',    notes:'' },
        { id:'d003', tradeType:'Option', ticker:'TSLA', direction:'Long', optionType:'Call', strikePrice:390, expirationDate:'2026-01-16', contracts:1, entryPrice:5.80, exitPrice:8.70, status:'Closed', pnl:290,  date:'2026-01-08T11:00', strategy:'Orderly Pullbacks',  entryReason:'Bullish flag breakout', exitReason:'Target hit',          notes:'' },
        { id:'d004', tradeType:'Option', ticker:'META', direction:'Long', optionType:'Call', strikePrice:595, expirationDate:'2026-01-16', contracts:1, entryPrice:4.20, exitPrice:6.30, status:'Closed', pnl:210,  date:'2026-01-10T13:45', strategy:'Earnings Play',      entryReason:'Pre-earnings momentum', exitReason:'Target hit',           notes:'' },
        { id:'d005', tradeType:'Option', ticker:'SPY',  direction:'Long', optionType:'Call', strikePrice:592, expirationDate:'2026-01-23', contracts:1, entryPrice:3.80, exitPrice:8.30, status:'Closed', pnl:450,  date:'2026-01-13T09:45', strategy:'Breakout',          entryReason:'CPI print bullish reaction', exitReason:'Target hit',    notes:'' },
        { id:'d006', tradeType:'Option', ticker:'AAPL', direction:'Long', optionType:'Call', strikePrice:235, expirationDate:'2026-01-23', contracts:1, entryPrice:3.20, exitPrice:4.80, status:'Closed', pnl:160,  date:'2026-01-15T14:00', strategy:'Orderly Pullbacks',  entryReason:'Support hold with volume', exitReason:'Target hit',      notes:'' },
        { id:'d007', tradeType:'Option', ticker:'AMZN', direction:'Long', optionType:'Call', strikePrice:218, expirationDate:'2026-01-30', contracts:1, entryPrice:4.50, exitPrice:7.40, status:'Closed', pnl:290,  date:'2026-01-17T10:30', strategy:'Supplier News',       entryReason:'AWS growth catalyst', exitReason:'Target hit',            notes:'' },
        { id:'d008', tradeType:'Option', ticker:'NVDA', direction:'Long', optionType:'Call', strikePrice:650, expirationDate:'2026-01-30', contracts:1, entryPrice:9.20, exitPrice:16.00, status:'Closed', pnl:680, date:'2026-01-22T11:15', strategy:'Breakout',          entryReason:'Chip sector rally', exitReason:'Target hit',               notes:'' },
        { id:'d009', tradeType:'Option', ticker:'SPY',  direction:'Long', optionType:'Call', strikePrice:594, expirationDate:'2026-01-30', contracts:1, entryPrice:2.90, exitPrice:5.70, status:'Closed', pnl:280,  date:'2026-01-24T13:00', strategy:'Orderly Pullbacks',  entryReason:'FOMC hold bullish reaction', exitReason:'Target hit',   notes:'' },
        { id:'d010', tradeType:'Option', ticker:'META', direction:'Long', optionType:'Call', strikePrice:600, expirationDate:'2026-02-06', contracts:1, entryPrice:5.10, exitPrice:8.50, status:'Closed', pnl:340,  date:'2026-01-27T09:50', strategy:'Earnings Play',      entryReason:'Q4 earnings beat expectations', exitReason:'Target hit', notes:'' },
        { id:'d011', tradeType:'Option', ticker:'TSLA', direction:'Long', optionType:'Call', strikePrice:395, expirationDate:'2026-02-06', contracts:1, entryPrice:6.10, exitPrice:9.90, status:'Closed', pnl:380,  date:'2026-01-29T14:20', strategy:'Breakout',          entryReason:'EV delivery beat', exitReason:'Target hit',               notes:'' },
        { id:'d012', tradeType:'Option', ticker:'NVDA', direction:'Long', optionType:'Call', strikePrice:655, expirationDate:'2026-02-13', contracts:1, entryPrice:7.80, exitPrice:11.90, status:'Closed', pnl:410, date:'2026-02-03T10:00', strategy:'Supplier News',       entryReason:'AI demand update', exitReason:'Target hit',               notes:'' },
        { id:'d013', tradeType:'Option', ticker:'SPY',  direction:'Long', optionType:'Call', strikePrice:596, expirationDate:'2026-02-20', contracts:1, entryPrice:3.50, exitPrice:7.40, status:'Closed', pnl:390,  date:'2026-02-07T11:30', strategy:'Orderly Pullbacks',  entryReason:'Jobs report beat', exitReason:'Target hit',              notes:'' },
        { id:'d014', tradeType:'Option', ticker:'AAPL', direction:'Long', optionType:'Call', strikePrice:238, expirationDate:'2026-02-20', contracts:1, entryPrice:2.80, exitPrice:5.00, status:'Closed', pnl:220,  date:'2026-02-12T13:15', strategy:'Earnings Play',      entryReason:'Services revenue guidance raise', exitReason:'Target hit', notes:'' },
        { id:'d015', tradeType:'Option', ticker:'AMZN', direction:'Long', optionType:'Call', strikePrice:222, expirationDate:'2026-02-27', contracts:1, entryPrice:3.70, exitPrice:6.00, status:'Closed', pnl:230,  date:'2026-02-19T09:55', strategy:'Breakout',          entryReason:'Logistics expansion news', exitReason:'Target hit',      notes:'' },
        { id:'d016', tradeType:'Option', ticker:'META', direction:'Long', optionType:'Call', strikePrice:610, expirationDate:'2026-02-27', contracts:1, entryPrice:4.80, exitPrice:6.60, status:'Closed', pnl:180,  date:'2026-02-25T14:45', strategy:'Orderly Pullbacks',  entryReason:'Ad revenue trend up', exitReason:'Target hit',           notes:'' },

        // ── Losses ──────────────────────────────────────────────────────────
        { id:'d017', tradeType:'Option', ticker:'SPY',  direction:'Long', optionType:'Put',  strikePrice:585, expirationDate:'2026-01-24', contracts:1, entryPrice:3.50, exitPrice:1.40, status:'Closed', pnl:-210, date:'2026-01-20T10:00', strategy:'Breakout',          entryReason:'Bearish reversal setup', exitReason:'Stop hit',         notes:'' },
        { id:'d018', tradeType:'Option', ticker:'NVDA', direction:'Long', optionType:'Call', strikePrice:660, expirationDate:'2026-02-06', contracts:1, entryPrice:8.80, exitPrice:6.60, status:'Closed', pnl:-220, date:'2026-02-05T11:00', strategy:'Supplier News',       entryReason:'Chip order catalyst', exitReason:'Stop hit',            notes:'' },
        { id:'d019', tradeType:'Option', ticker:'TSLA', direction:'Long', optionType:'Put',  strikePrice:380, expirationDate:'2026-02-13', contracts:1, entryPrice:5.20, exitPrice:3.25, status:'Closed', pnl:-195, date:'2026-02-10T09:30', strategy:'Breakout',          entryReason:'Breakdown setup', exitReason:'Stop hit',                notes:'' },
        { id:'d020', tradeType:'Option', ticker:'SPY',  direction:'Long', optionType:'Put',  strikePrice:590, expirationDate:'2026-02-20', contracts:1, entryPrice:3.00, exitPrice:1.20, status:'Closed', pnl:-180, date:'2026-02-14T13:00', strategy:'Orderly Pullbacks',  entryReason:'Overbought reversal', exitReason:'Stop hit',            notes:'' },
        { id:'d021', tradeType:'Option', ticker:'META', direction:'Long', optionType:'Put',  strikePrice:600, expirationDate:'2026-02-27', contracts:1, entryPrice:5.50, exitPrice:3.85, status:'Closed', pnl:-165, date:'2026-02-21T10:30', strategy:'Earnings Play',      entryReason:'Post-earnings fade', exitReason:'Stop hit',             notes:'' },
        { id:'d022', tradeType:'Option', ticker:'AAPL', direction:'Long', optionType:'Put',  strikePrice:230, expirationDate:'2026-03-06', contracts:1, entryPrice:2.80, exitPrice:1.40, status:'Closed', pnl:-140, date:'2026-03-03T11:15', strategy:'Breakout',          entryReason:'Resistance rejection', exitReason:'Stop hit',            notes:'' },

        // ── Open positions ───────────────────────────────────────────────────
        { id:'d023', tradeType:'Option', ticker:'SPY',  direction:'Long', optionType:'Call', strikePrice:595, expirationDate:'2026-03-20', contracts:2, entryPrice:4.10, exitPrice:null,  status:'Open',   pnl:0,    date:'2026-01-31T14:00', strategy:'Orderly Pullbacks',  entryReason:'VWAP reclaim + MFI uptrend', exitReason:'', notes:'' },
        { id:'d024', tradeType:'Option', ticker:'NVDA', direction:'Long', optionType:'Call', strikePrice:970, expirationDate:'2026-03-21', contracts:1, entryPrice:11.20, exitPrice:null, status:'Open',   pnl:0,    date:'2026-02-28T10:45', strategy:'Supplier News',       entryReason:'GPU demand catalyst', exitReason:'',            notes:'' },
        { id:'d025', tradeType:'Option', ticker:'META', direction:'Long', optionType:'Call', strikePrice:620, expirationDate:'2026-03-21', contracts:1, entryPrice:6.80, exitPrice:null,  status:'Open',   pnl:0,    date:'2026-03-04T09:50', strategy:'Earnings Play',      entryReason:'AI monetization momentum', exitReason:'',        notes:'' }
    ];

    /* ── Mock trade plans  (4 active/watching + 2 closed) ──────────────────── */
    var PLANS = [
        { id:'p001', ticker:'SPY',  tradeType:'Option', direction:'Long',  optionType:'Call', strikePrice:595, expiryDate:'2026-03-20', contracts:2, entryPrice:4.10, targetPrice:8.50, stopPrice:2.05, rr:2.1, status:'Active',   outcome:null,         notes:'VWAP reclaim setup post CPI', createdAt:'2026-01-31T14:00' },
        { id:'p002', ticker:'NVDA', tradeType:'Option', direction:'Long',  optionType:'Call', strikePrice:970, expiryDate:'2026-03-21', contracts:1, entryPrice:11.20, targetPrice:22.50, stopPrice:6.00, rr:1.9, status:'Watching', outcome:null,         notes:'Watching for breakout above $960', createdAt:'2026-02-28T10:45' },
        { id:'p003', ticker:'META', tradeType:'Option', direction:'Long',  optionType:'Put',  strikePrice:580, expiryDate:'2026-03-21', contracts:1, entryPrice:7.20, targetPrice:14.80, stopPrice:3.80, rr:1.7, status:'Active',   outcome:null,         notes:'Bearish divergence on daily', createdAt:'2026-02-20T11:00' },
        { id:'p004', ticker:'TSLA', tradeType:'Option', direction:'Long',  optionType:'Call', strikePrice:290, expiryDate:'2026-03-28', contracts:1, entryPrice:5.50, targetPrice:13.50, stopPrice:2.75, rr:2.3, status:'Watching', outcome:null,         notes:'Waiting for $285 support hold', createdAt:'2026-03-01T09:30' },
        { id:'p005', ticker:'AAPL', tradeType:'Option', direction:'Long',  optionType:'Call', strikePrice:240, expiryDate:'2026-02-20', contracts:1, entryPrice:3.20, targetPrice:6.00, stopPrice:1.60, rr:1.8, status:'Closed',   outcome:'Hit Target', notes:'Services pivot trade', createdAt:'2026-02-01T10:00' },
        { id:'p006', ticker:'AMZN', tradeType:'Option', direction:'Long',  optionType:'Call', strikePrice:225, expiryDate:'2026-02-27', contracts:1, entryPrice:3.70, targetPrice:7.60, stopPrice:1.85, rr:2.0, status:'Closed',   outcome:'Hit Target', notes:'AWS re:Invent catalyst play', createdAt:'2026-02-10T13:00' }
    ];

    /* ── Mock signals  (20 entries across all 6 tickers) ───────────────────── */
    var SIGNALS = [
        { id:'s001', stock:'SPY',  contractType:'Call', price:592.10, strike:595.00, premium:3.20, expiration:'2026-01-10', vwap:589.45, mfi:67.3, timestamp:'2026-01-03 14:30:00' },
        { id:'s002', stock:'NVDA', contractType:'Call', price:628.40, strike:635.00, premium:8.50, expiration:'2026-01-17', vwap:622.10, mfi:71.2, timestamp:'2026-01-06 10:15:00' },
        { id:'s003', stock:'TSLA', contractType:'Call', price:382.50, strike:390.00, premium:5.80, expiration:'2026-01-16', vwap:378.90, mfi:65.8, timestamp:'2026-01-08 11:00:00' },
        { id:'s004', stock:'META', contractType:'Call', price:588.20, strike:595.00, premium:4.20, expiration:'2026-01-16', vwap:584.60, mfi:69.4, timestamp:'2026-01-10 13:45:00' },
        { id:'s005', stock:'SPY',  contractType:'Call', price:585.70, strike:592.00, premium:3.80, expiration:'2026-01-23', vwap:582.30, mfi:72.1, timestamp:'2026-01-13 09:45:00' },
        { id:'s006', stock:'AAPL', contractType:'Call', price:228.90, strike:235.00, premium:3.20, expiration:'2026-01-23', vwap:226.40, mfi:63.7, timestamp:'2026-01-15 14:00:00' },
        { id:'s007', stock:'AMZN', contractType:'Call', price:212.30, strike:218.00, premium:4.50, expiration:'2026-01-30', vwap:209.80, mfi:68.9, timestamp:'2026-01-17 10:30:00' },
        { id:'s008', stock:'NVDA', contractType:'Call', price:641.80, strike:650.00, premium:9.20, expiration:'2026-01-30', vwap:637.50, mfi:74.5, timestamp:'2026-01-22 11:15:00' },
        { id:'s009', stock:'SPY',  contractType:'Put',  price:591.20, strike:585.00, premium:3.50, expiration:'2026-01-24', vwap:594.10, mfi:28.4, timestamp:'2026-01-20 10:00:00' },
        { id:'s010', stock:'META', contractType:'Call', price:594.50, strike:600.00, premium:5.10, expiration:'2026-02-06', vwap:590.20, mfi:70.8, timestamp:'2026-01-27 09:50:00' },
        { id:'s011', stock:'TSLA', contractType:'Call', price:386.40, strike:395.00, premium:6.10, expiration:'2026-02-06', vwap:382.70, mfi:66.3, timestamp:'2026-01-29 14:20:00' },
        { id:'s012', stock:'NVDA', contractType:'Call', price:645.20, strike:655.00, premium:7.80, expiration:'2026-02-13', vwap:640.90, mfi:69.1, timestamp:'2026-02-03 10:00:00' },
        { id:'s013', stock:'SPY',  contractType:'Call', price:589.30, strike:596.00, premium:3.50, expiration:'2026-02-20', vwap:585.80, mfi:71.6, timestamp:'2026-02-07 11:30:00' },
        { id:'s014', stock:'AAPL', contractType:'Call', price:232.10, strike:238.00, premium:2.80, expiration:'2026-02-20', vwap:229.50, mfi:64.2, timestamp:'2026-02-12 13:15:00' },
        { id:'s015', stock:'TSLA', contractType:'Put',  price:388.60, strike:380.00, premium:5.20, expiration:'2026-02-13', vwap:392.10, mfi:29.7, timestamp:'2026-02-10 09:30:00' },
        { id:'s016', stock:'AMZN', contractType:'Call', price:216.80, strike:222.00, premium:3.70, expiration:'2026-02-27', vwap:214.20, mfi:67.5, timestamp:'2026-02-19 09:55:00' },
        { id:'s017', stock:'META', contractType:'Call', price:603.90, strike:610.00, premium:4.80, expiration:'2026-02-27', vwap:600.30, mfi:65.9, timestamp:'2026-02-25 14:45:00' },
        { id:'s018', stock:'SPY',  contractType:'Call', price:591.80, strike:595.00, premium:4.10, expiration:'2026-03-20', vwap:588.40, mfi:70.3, timestamp:'2026-01-31 14:00:00' },
        { id:'s019', stock:'NVDA', contractType:'Call', price:958.40, strike:970.00, premium:11.20, expiration:'2026-03-21', vwap:952.70, mfi:68.8, timestamp:'2026-02-28 10:45:00' },
        { id:'s020', stock:'META', contractType:'Call', price:612.50, strike:620.00, premium:6.80, expiration:'2026-03-21', vwap:608.90, mfi:66.4, timestamp:'2026-03-04 09:50:00' }
    ];

    /* ── Demo banner helper ─────────────────────────────────────────────────── */
    function injectBanner() {
        if (document.getElementById('bcs-demo-banner')) return;
        var el = document.createElement('div');
        el.id = 'bcs-demo-banner';
        el.style.cssText = [
            'background:rgba(201,176,55,0.1)',
            'border-bottom:1px solid rgba(201,176,55,0.25)',
            'color:#c9b037',
            'padding:0.55rem 1.25rem',
            'display:flex',
            'align-items:center',
            'gap:0.6rem',
            'font-size:0.78rem',
            'font-weight:600',
            'position:relative',
            'z-index:999'
        ].join(';');
        el.innerHTML =
            '<i class="fas fa-eye" style="flex-shrink:0;"></i>' +
            '<span>You\'re viewing a demo. Actual results vary per user.</span>' +
            '<a href="pricing" style="color:inherit;font-weight:800;text-decoration:underline;margin-left:auto;white-space:nowrap;">Get Access &rarr;</a>' +
            '<button onclick="this.parentElement.remove()" style="background:none;border:none;color:inherit;cursor:pointer;padding:0 0 0 0.5rem;font-size:1rem;line-height:1;" title="Dismiss"><i class="fas fa-xmark"></i></button>';
        var main = document.querySelector('.main-content') || document.body;
        main.insertBefore(el, main.firstChild);
    }

    /* ── Export ─────────────────────────────────────────────────────────────── */
    window.BCS_DEMO = {
        USER:         USER,
        TRADES:       TRADES,
        PLANS:        PLANS,
        SIGNALS:      SIGNALS,
        injectBanner: injectBanner
    };

})();
