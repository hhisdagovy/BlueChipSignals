// fear-greed.js
(function(){
  const API_URL = 'https://api.alternative.me/fng/?limit=1&format=json';
  const REFRESH  = 300000; // 5 min

  /* ── Needle animation (SVG attribute — immune to CSS scaling issues) ── */
  let _needleAngle = -90; // tracks current angle for smooth re-animation
  let _needleRaf   = null;

  function animateNeedle(targetAngle) {
    const startAngle = _needleAngle;
    const startTime  = performance.now();
    const duration   = 1200;

    function easeOutBack(t) {
      // spring-like overshoot matching the original cubic-bezier feel
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }

    if (_needleRaf) cancelAnimationFrame(_needleRaf);

    function step(now) {
      const t      = Math.min((now - startTime) / duration, 1);
      const eased  = t < 1 ? easeOutBack(t) : 1;
      const angle  = startAngle + (targetAngle - startAngle) * eased;
      const needle = document.getElementById('fg-needle');
      // SVG rotate(angle, cx, cy) always uses SVG user-coordinates regardless of CSS scaling
      if (needle) needle.setAttribute('transform', `rotate(${angle.toFixed(2)}, 150, 130)`);
      if (t < 1) { _needleRaf = requestAnimationFrame(step); }
      else        { _needleAngle = targetAngle; _needleRaf = null; }
    }

    _needleRaf = requestAnimationFrame(step);
  }

  /* ── Zone helpers ── */
  function zoneFor(val) {
    if (val <= 25) return { idx: 0, label: 'Extreme Fear', color: '#ef4444' };
    if (val <= 45) return { idx: 1, label: 'Fear',         color: '#f97316' };
    if (val <= 55) return { idx: 2, label: 'Neutral',      color: '#c9b037' };
    if (val <= 75) return { idx: 3, label: 'Greed',        color: '#84cc16' };
    return             { idx: 4, label: 'Extreme Greed', color: '#22c55e' };
  }

  function applyToGauge(value) {
    const val  = parseInt(value, 10);
    const zone = zoneFor(val);

    /* Needle: value 0 → −90°, value 100 → +90°  (SVG attribute, pivot at 150,130) */
    animateNeedle((val / 100) * 180 - 90);

    /* Big number */
    const numEl = document.getElementById('fg-value-num');
    if (numEl) {
      numEl.textContent = val;
      numEl.style.color  = zone.color;
    }

    /* Zone badge */
    const badge  = document.getElementById('fg-zone-badge');
    const labelEl = document.getElementById('fg-class');
    if (badge) {
      badge.style.color       = zone.color;
      badge.style.borderColor = zone.color;
      badge.style.background  = zone.color + '18';
    }
    if (labelEl) labelEl.textContent = zone.label;

    /* Zone chips: highlight active, dim others */
    document.querySelectorAll('.fg-zone-chip').forEach(chip => {
      const active = parseInt(chip.dataset.zone, 10) === zone.idx;
      chip.classList.toggle('fg-active', active);
    });
  }

  /* Legacy SVG text elements (kept for backward compat with old gauge markup) */
  function applyLegacy(value, classification) {
    const v = document.getElementById('fg-value');
    const l = document.getElementById('fg-class');
    if (v && v !== document.getElementById('fg-value-num')) v.textContent = value;
    if (l && !l.closest('#fg-zone-badge')) l.textContent = classification;
  }

  async function fetchFG() {
    try {
      const res  = await fetch(API_URL);
      if (!res.ok) throw new Error('network');
      const json = await res.json();
      const item = json?.data?.[0];
      if (!item)  throw new Error('parse');

      applyLegacy(item.value, item.value_classification);
      applyToGauge(item.value);
      if (window.updateFearGreed) window.updateFearGreed(item.value);
    } catch (e) {
      const numEl  = document.getElementById('fg-value-num');
      const labelEl = document.getElementById('fg-class');
      if (numEl)  numEl.textContent  = '—';
      if (labelEl) labelEl.textContent = 'Unavailable';
    }
  }

  fetchFG();
  setInterval(fetchFG, REFRESH);
})();
