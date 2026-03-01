// bls-data.js — Live BLS economic data (CPI, Core CPI, PPI)
import { BLS_API_KEY } from './config.js';

const KEY       = BLS_API_KEY;
const CACHE_KEY = 'bls_econ_v3';
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

// BLS series → card element IDs
const SERIES = [
  {
    id:      'CUUR0000SA0',     // Headline CPI, not seasonally adjusted
    valueId: 'econ-cpi-value',
    dateId:  'econ-cpi-date',
    trendId: 'econ-cpi-trend',
  },
  {
    id:      'CUUR0000SA0L1E',  // Core CPI (ex food & energy), not seasonally adjusted
    valueId: 'econ-core-value',
    dateId:  'econ-core-date',
    trendId: 'econ-core-trend',
  },
  {
    id:      'WPSFD4',          // PPI Final Demand, not seasonally adjusted
    valueId: 'econ-ppi-value',
    dateId:  'econ-ppi-date',
    trendId: 'econ-ppi-trend',
  },
];

document.addEventListener('DOMContentLoaded', async () => {
  // Try cache first
  const cached = getCache();
  if (cached) {
    renderAll(cached, true);
    return;
  }

  // Fetch live
  const data = await fetchAll();
  if (data) {
    setCache(data);
    renderAll(data, false);
  } else {
    renderError();
  }
});

/* ── Fetch ── */
async function fetchAll() {
  const now       = new Date();
  const endYear   = now.getFullYear();
  const startYear = endYear - 2; // 2 years → ensures 14+ monthly data points

  const results = {};

  try {
    for (const s of SERIES) {
      const url = [
        'https://api.bls.gov/publicAPI/v2/timeseries/data/',
        s.id,
        `?startyear=${startYear}&endyear=${endYear}`,
        `&registrationKey=${KEY}`,
      ].join('');

      const res  = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();
      if (json.status !== 'REQUEST_SUCCEEDED') continue;

      const pts = json.Results.series[0].data; // newest first
      if (pts.length < 13) continue;

      // YoY % for latest data point
      const curr = parseFloat(pts[0].value);
      const yr0  = parseFloat(pts[12].value);  // same month last year
      const yoy  = ((curr - yr0) / yr0) * 100;

      // YoY % for previous month (trend comparison)
      let prevYoy  = null;
      let delta    = null;
      if (pts.length >= 14) {
        const prev = parseFloat(pts[1].value);
        const yr1  = parseFloat(pts[13].value);
        prevYoy    = ((prev - yr1) / yr1) * 100;
        delta      = yoy - prevYoy;
      }

      results[s.id] = {
        yoy:   yoy.toFixed(1),
        delta: delta !== null ? delta.toFixed(2) : null,
        date:  `${pts[0].periodName} ${pts[0].year}`,
      };
    }
  } catch {
    return null;
  }

  return Object.keys(results).length > 0 ? results : null;
}

/* ── Render ── */
function renderAll(data, fromCache) {
  SERIES.forEach(s => {
    const d = data[s.id];
    if (!d) return;

    const valEl   = document.getElementById(s.valueId);
    const dateEl  = document.getElementById(s.dateId);
    const trendEl = document.getElementById(s.trendId);

    if (valEl) {
      valEl.classList.remove('loading');
      valEl.textContent = d.yoy + '%';
    }
    if (dateEl) dateEl.textContent = d.date;

    if (trendEl && d.delta !== null) {
      const delta   = parseFloat(d.delta);
      const abs     = Math.abs(delta);
      const sign    = delta > 0 ? '+' : '';

      if (abs < 0.05) {
        trendEl.innerHTML =
          '<span class="trend-flat"><i class="fas fa-minus"></i> flat</span>';
      } else if (delta > 0) {
        // Rising inflation → hawkish signal → shown in red
        trendEl.innerHTML =
          `<span class="trend-up"><i class="fas fa-arrow-trend-up"></i> ${sign}${d.delta}pp</span>`;
      } else {
        // Cooling inflation → dovish signal → shown in green
        trendEl.innerHTML =
          `<span class="trend-down"><i class="fas fa-arrow-trend-down"></i> ${d.delta}pp</span>`;
      }
    }
  });

  // Timestamp
  const stamp = document.getElementById('econ-last-updated');
  if (stamp) {
    if (fromCache) {
      stamp.textContent = 'Data from local cache';
    } else {
      const now = new Date();
      stamp.textContent = `Updated ${now.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })}`;
    }
  }
}

function renderError() {
  SERIES.forEach(s => {
    const valEl  = document.getElementById(s.valueId);
    const dateEl = document.getElementById(s.dateId);
    if (valEl)  { valEl.classList.remove('loading'); valEl.textContent = 'N/A'; }
    if (dateEl) dateEl.textContent = 'Unavailable';
  });
  const stamp = document.getElementById('econ-last-updated');
  if (stamp) stamp.textContent = 'Data unavailable — check BLS API';
}

/* ── Cache helpers ── */
function getCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.ts > CACHE_TTL) return null;
    return obj.data;
  } catch { return null; }
}

function setCache(data) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* storage full */ }
}
