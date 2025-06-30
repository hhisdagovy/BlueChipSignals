// bls-data.js - Fetches latest CPI and PPI figures from the BLS API and injects mini-cards on the SPY economic data page.

(() => {
  const API_KEY = '6db22f52282f4b429de1712f22bf4336';
  const SERIES = [
    { id: 'CUUR0000SA0', label: 'Headline CPI YoY', changeType: 'yoy' },
    { id: 'CUUR0000SA0L1E', label: 'Core CPI YoY', changeType: 'yoy' },
    { id: 'WPSFD4', label: 'PPI MoM', changeType: 'mom' }
  ];

  const CACHE_KEY = 'bls_macro_cache_v1';
  const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    const cached = getCached();
    if (cached) {
      renderCards(cached);
      return;
    }
    fetchData().then(data => {
      if (data) {
        cacheData(data);
        renderCards(data);
      }
    }).catch(() => {
      renderError();
    });
  }

  function getCached() {
    try {
      const str = sessionStorage.getItem(CACHE_KEY);
      if (!str) return null;
      const obj = JSON.parse(str);
      if (Date.now() - obj.timestamp > CACHE_TTL_MS) return null;
      return obj.data;
    } catch (e) { return null; }
  }

  function cacheData(data) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data }));
    } catch (_) {}
  }

  async function fetchData() {
    const now = new Date();
    const payload = {
      seriesid: SERIES.map(s => s.id),
      startyear: String(now.getFullYear() - 1),
      endyear: String(now.getFullYear()),
      registrationKey: API_KEY,
      calculations: true
    };

    const endpoint = 'https://cors.isomorphic-git.org/https://api.bls.gov/publicAPI/v2/timeseries/data/';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error('Network');
    const json = await res.json();
    if (json.status !== 'REQUEST_SUCCEEDED') throw new Error('API');

    const output = {};

    json.Results.series.forEach(series => {
      const meta = SERIES.find(s => s.id === series.seriesID);
      if (!meta) return;
      const latest = series.data[0];
      if (!latest) return;

      let value = latest.value;
      let dateLabel = `${latest.periodName} ${latest.year}`;
      let display = value;

      // Attempt to get YoY or MoM change using calculations
      if (series.calculations && series.calculations.net_changes) {
        const changes = series.calculations.net_changes;
        const findChange = (period) => {
          const item = changes.find(c => c.period === period);
          return item ? item.value : null;
        };
        const yoy = findChange('M12');
        const mom = findChange('M01');
        if (meta.changeType === 'yoy' && yoy !== null) display = yoy;
        if (meta.changeType === 'mom' && mom !== null) display = mom;
      }

      output[meta.id] = {
        label: meta.label,
        value: display + ' %',
        date: dateLabel
      };
    });

    return output;
  }

  function renderCards(data) {
    const grid = document.getElementById('bls-grid');
    if (!grid) return;
    Object.values(data).forEach(d => {
      const card = document.createElement('div');
      card.className = 'bea-card';
      card.innerHTML = `<h4>${d.label}</h4><p>${d.value}</p><small>${d.date}</small>`;
      grid.appendChild(card);
    });
  }

  function renderError() {
    const grid = document.getElementById('bls-grid');
    if (grid) {
      grid.innerHTML = '<p style="color: var(--gray-text);">Data unavailable</p>';
    }
  }
})(); 