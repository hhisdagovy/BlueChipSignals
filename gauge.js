// gauge.js - renders Fear & Greed semicircular gauge using SVG paths
(function(){
  const arc      = document.getElementById('fg-arc');
  const needle   = document.getElementById('fg-needle');
  const valueTxt = document.getElementById('fg-value');
  const classTxt = document.getElementById('fg-class');
  if(!arc || !needle) return;

  // Use brand colors from the CSS variables
  const colors = {
    fear: '#b3a17d', // A more subdued gold for "Fear"
    greed: '#E2CFB5'   // The bright --secondary-gold for "Greed"
  };

  function getFearGreedColor(value) {
    const normalizedValue = value / 100;
    const fearColor = hexToRgb(colors.fear);
    const greedColor = hexToRgb(colors.greed);

    // Linear interpolation between fear and greed colors
    const r = Math.round(fearColor.r + normalizedValue * (greedColor.r - fearColor.r));
    const g = Math.round(fearColor.g + normalizedValue * (greedColor.g - fearColor.g));
    const b = Math.round(fearColor.b + normalizedValue * (greedColor.b - fearColor.b));

    return `rgb(${r}, ${g}, ${b})`;
  }

  function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : null;
  }

  function updateGauge(value) {
    const percentage = Math.min(Math.max(value, 0), 100) / 100;
    const angle = -90 + (percentage * 180); // from -90 to 90 degrees
    const arcLength = percentage * 282.7; // Half circumference of a 90 radius circle (π*r)
    
    arc.setAttribute('stroke-dasharray', `${arcLength} 565`);
    arc.style.stroke = getFearGreedColor(value);
    needle.setAttribute('transform', `rotate(${angle})`);

    // Update arc dasharray (first value rendered, second transparent)
    arc.setAttribute('stroke-dasharray', `${arcLength} 565`);

    // Color logic based on ranges
    valueTxt.setAttribute('fill', getFearGreedColor(value));
    valueTxt.textContent = percentage * 100;
    if(classTxt){ classTxt.textContent = classification(percentage * 100); }
  }

  function classification(v){
    if(v<25) return 'Extreme Fear';
    if(v<50) return 'Fear';
    if(v<75) return 'Greed';
    return 'Extreme Greed';
  }

  window.updateFearGreed = updateGauge; // exposed to fear-greed.js
})(); 