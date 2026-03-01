/* ─────────────────────────────────────────────────────────────────────────────
   tsla-trend.js — Live TSLA Trend Strength Analyzer
   Fetches 100 daily candles from Alpha Vantage once per day (cached in
   sessionStorage), computes SMA20, SMA50, RSI14, Volume Trend, and Trend
   Duration client-side, then auto-renders the result into the page.
───────────────────────────────────────────────────────────────────────────── */

import { ALPHA_VANTAGE_KEY } from './config.js';

const FINNHUB_TOKEN = 'ctrlh6hr01qhlbactc50ctrlh6hr01qhlbactc5g';
const AV_URL        = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=TSLA&outputsize=compact&apikey=${ALPHA_VANTAGE_KEY}`;
const CACHE_KEY     = () => `tsla_candles_${new Date().toISOString().slice(0, 10)}`;

/* ── Helpers ────────────────────────────────────────────────────────────────── */

function sma(closes, period) {
    const slice = closes.slice(0, period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function rsi14(closes) {
    const prices = closes.slice(0, 15).reverse(); // oldest first, 15 points for 14 changes
    let gains = 0, losses = 0;
    for (let i = 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff >= 0) gains  += diff;
        else           losses -= diff;
    }
    const avgGain = gains  / 14;
    const avgLoss = losses / 14;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function volumeTrend(volumes) {
    // volumes[0] = most recent
    const avg5  = volumes.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const avg20 = volumes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
    const ratio = avg5 / avg20;
    if (ratio > 1.10) return 'increasing';
    if (ratio < 0.90) return 'decreasing';
    return 'stable';
}

function trendDuration(closes, sma20Values) {
    // Walk back through days until price crossed SMA20 from same side
    const currentAbove = closes[0] > sma20Values[0];
    for (let i = 1; i < Math.min(closes.length, sma20Values.length); i++) {
        const wasAbove = closes[i] > sma20Values[i];
        if (wasAbove !== currentAbove) return i; // days since crossover
    }
    return Math.min(closes.length, sma20Values.length) - 1;
}

/* ── Fetch & cache ─────────────────────────────────────────────────────────── */

async function getCandles() {
    const key = CACHE_KEY();
    const cached = sessionStorage.getItem(key);
    if (cached) return JSON.parse(cached);

    const res  = await fetch(AV_URL);
    const json = await res.json();
    const ts   = json['Time Series (Daily)'];
    if (!ts) throw new Error('Alpha Vantage returned no data');

    // Convert to arrays, newest first
    const dates   = Object.keys(ts).sort((a, b) => b.localeCompare(a));
    const candles = dates.map(d => ({
        date:   d,
        close:  parseFloat(ts[d]['4. close']),
        volume: parseInt(ts[d]['5. volume'], 10),
    }));

    sessionStorage.setItem(key, JSON.stringify(candles));
    return candles;
}

async function getLivePrice() {
    const res  = await fetch(`https://finnhub.io/api/v1/quote?symbol=TSLA&token=${FINNHUB_TOKEN}`);
    const data = await res.json();
    return data.c || null;
}

/* ── Score ─────────────────────────────────────────────────────────────────── */

function score(price, ma20, ma50, volTrend, rsiVal, durationDays) {
    let pts = 0;
    const analysis = [];

    // MA alignment (30pts)
    if (price > ma20 && ma20 > ma50) {
        pts += 30;
        analysis.push({ ok: true,  text: 'Strong bullish alignment (Price > SMA20 > SMA50)' });
    } else if (price < ma20 && ma20 < ma50) {
        pts += 30;
        analysis.push({ ok: true,  text: 'Strong bearish alignment (Price < SMA20 < SMA50)' });
    } else {
        pts += 10;
        analysis.push({ ok: false, text: 'Mixed moving average signals — no clear alignment' });
    }

    // Volume (25pts)
    if (volTrend === 'increasing') {
        pts += 25;
        analysis.push({ ok: true,  text: 'Volume supporting trend direction (5-day avg > 20-day avg)' });
    } else if (volTrend === 'stable') {
        pts += 15;
        analysis.push({ ok: false, text: 'Stable volume — trend may be maturing' });
    } else {
        pts += 5;
        analysis.push({ ok: false, text: 'Decreasing volume — trend weakening' });
    }

    // RSI (20pts)
    if ((rsiVal > 50 && price > ma20) || (rsiVal < 50 && price < ma20)) {
        pts += 20;
        analysis.push({ ok: true,  text: `RSI ${rsiVal.toFixed(1)} confirms trend direction` });
    } else {
        pts += 5;
        analysis.push({ ok: false, text: `RSI ${rsiVal.toFixed(1)} showing potential divergence` });
    }

    // Duration (15pts)
    if (durationDays >= 5 && durationDays <= 20) {
        pts += 15;
        analysis.push({ ok: true,  text: `Trend active ${durationDays} days — optimal for continuation` });
    } else if (durationDays > 20) {
        pts += 5;
        analysis.push({ ok: false, text: `Extended trend (${durationDays} days) — watch for reversal signals` });
    } else {
        pts += 10;
        analysis.push({ ok: false, text: `Young trend (${durationDays} days) — needs further confirmation` });
    }

    // MA distance (10pts)
    const ma20Dist = Math.abs((price - ma20) / ma20 * 100);
    if (ma20Dist < 5) {
        pts += 10;
        analysis.push({ ok: true,  text: `Price near SMA20 (${ma20Dist.toFixed(1)}% away) — good entry zone` });
    } else if (ma20Dist > 10) {
        pts -= 5;
        analysis.push({ ok: false, text: `Price extended from SMA20 (${ma20Dist.toFixed(1)}% away) — wait for pullback` });
    }

    return { pts: Math.max(0, pts), analysis };
}

/* ── Render ─────────────────────────────────────────────────────────────────── */

function renderResult(container, price, ma20, ma50, rsiVal, volTrend, durationDays, updatedAt) {
    const { pts, analysis } = score(price, ma20, ma50, volTrend, rsiVal, durationDays);

    const pctVsMa20 = ((price - ma20) / ma20 * 100);
    const pctVsMa50 = ((price - ma50) / ma50 * 100);

    const volLabel = { increasing: 'Increasing', stable: 'Stable', decreasing: 'Decreasing' }[volTrend];
    const volClass = { increasing: 'ta-bull', stable: 'ta-neutral', decreasing: 'ta-bear' }[volTrend];

    let verdict, verdictClass, verdictIcon;
    if (pts >= 80) {
        verdict = price > ma20 ? 'STRONG UPTREND' : 'STRONG DOWNTREND';
        verdictClass = price > ma20 ? 'ta-bull' : 'ta-bear';
        verdictIcon  = price > ma20 ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down';
    } else if (pts >= 55) {
        verdict = 'MODERATE TREND';
        verdictClass = 'ta-neutral';
        verdictIcon  = 'fa-chart-line';
    } else {
        verdict = 'WEAK / NO TREND';
        verdictClass = 'ta-bear';
        verdictIcon  = 'fa-triangle-exclamation';
    }

    const rsiClass = rsiVal >= 70 ? 'ta-bear' : rsiVal <= 30 ? 'ta-bull' : 'ta-neutral';

    container.innerHTML = `
        <div class="ta-metrics">
            <div class="ta-metric">
                <div class="ta-metric-val">$${price.toFixed(2)}</div>
                <div class="ta-metric-label">Live Price</div>
            </div>
            <div class="ta-metric">
                <div class="ta-metric-val ${pctVsMa20 >= 0 ? 'ta-bull' : 'ta-bear'}">${pctVsMa20 >= 0 ? '+' : ''}${pctVsMa20.toFixed(1)}%</div>
                <div class="ta-metric-label">vs SMA20 ($${ma20.toFixed(0)})</div>
            </div>
            <div class="ta-metric">
                <div class="ta-metric-val ${pctVsMa50 >= 0 ? 'ta-bull' : 'ta-bear'}">${pctVsMa50 >= 0 ? '+' : ''}${pctVsMa50.toFixed(1)}%</div>
                <div class="ta-metric-label">vs SMA50 ($${ma50.toFixed(0)})</div>
            </div>
            <div class="ta-metric">
                <div class="ta-metric-val ${rsiClass}">${rsiVal.toFixed(1)}</div>
                <div class="ta-metric-label">RSI (14)</div>
            </div>
            <div class="ta-metric">
                <div class="ta-metric-val ${volClass}">${volLabel}</div>
                <div class="ta-metric-label">Volume Trend</div>
            </div>
            <div class="ta-metric">
                <div class="ta-metric-val">${durationDays}d</div>
                <div class="ta-metric-label">Trend Duration</div>
            </div>
        </div>

        <div class="ta-verdict ${verdictClass}">
            <div class="ta-verdict-left">
                <i class="fas ${verdictIcon} ta-verdict-icon"></i>
                <div>
                    <div class="ta-verdict-label">${verdict}</div>
                    <div class="ta-verdict-score">Score: ${pts} / 100</div>
                </div>
            </div>
            <div class="ta-score-ring">
                <svg viewBox="0 0 44 44" width="64" height="64">
                    <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="4"/>
                    <circle cx="22" cy="22" r="18" fill="none" stroke="currentColor" stroke-width="4"
                        stroke-dasharray="${(pts / 100 * 113).toFixed(1)} 113"
                        stroke-linecap="round"
                        transform="rotate(-90 22 22)"/>
                    <text x="22" y="26" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">${pts}</text>
                </svg>
            </div>
        </div>

        <div class="ta-analysis">
            ${analysis.map(a => `
                <div class="ta-analysis-row">
                    <i class="fas ${a.ok ? 'fa-circle-check ta-bull' : 'fa-circle-exclamation ta-warn'}"></i>
                    <span>${a.text}</span>
                </div>
            `).join('')}
        </div>

        <div class="ta-footer">
            <span><i class="fas fa-clock"></i> Updated ${updatedAt}</span>
            <button class="ta-refresh-btn" id="ta-refresh-btn">
                <i class="fas fa-rotate-right"></i> Refresh
            </button>
        </div>
    `;

    document.getElementById('ta-refresh-btn')?.addEventListener('click', () => {
        sessionStorage.removeItem(CACHE_KEY());
        renderTrendAnalyzer();
    });
}

function renderLoading(container) {
    container.innerHTML = `
        <div class="ta-loading">
            <div class="ta-spinner"></div>
            <span>Loading live TSLA data…</span>
        </div>
    `;
}

function renderError(container, msg) {
    container.innerHTML = `
        <div class="ta-error">
            <i class="fas fa-triangle-exclamation"></i>
            <span>${msg}</span>
            <button class="ta-refresh-btn" onclick="location.reload()">Retry</button>
        </div>
    `;
}

/* ── Public entry point ─────────────────────────────────────────────────────── */

export async function renderTrendAnalyzer(containerId = 'ta-container') {
    const container = document.getElementById(containerId);
    if (!container) return;

    renderLoading(container);

    try {
        const [candles, livePrice] = await Promise.all([getCandles(), getLivePrice()]);

        const closes  = candles.map(c => c.close);
        const volumes = candles.map(c => c.volume);

        const ma20val = sma(closes, 20);
        const ma50val = sma(closes, 50);
        const rsiVal  = rsi14(closes);
        const volT    = volumeTrend(volumes);

        // Build rolling SMA20 values for trend-duration detection
        const sma20Series = candles.map((_, i) => {
            if (i + 20 > candles.length) return null;
            return sma(closes.slice(i, i + 20), 20);
        }).filter(v => v !== null);

        const duration = trendDuration(closes, sma20Series);

        const price = livePrice || closes[0];
        const now   = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

        renderResult(container, price, ma20val, ma50val, rsiVal, volT, duration, now);
    } catch (err) {
        console.error('[tsla-trend]', err);
        renderError(container, 'Could not load live data. Please try again later.');
    }
}
