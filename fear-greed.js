// fear-greed.js
(function(){
  const API_URL = 'https://api.alternative.me/fng/?limit=1&format=json';
  const REFRESH = 300000; // 5 min
  const valueEl = document.getElementById('fg-value');
  const labelEl = document.getElementById('fg-class');
  if(!valueEl) return;

  async function fetchFG(){
    try{
      const res = await fetch(API_URL);
      if(!res.ok) throw new Error('network');
      const json = await res.json();
      const item = json?.data?.[0];
      if(!item) throw new Error('parse');
      valueEl.textContent = item.value;
      if (labelEl) {
        labelEl.textContent = item.value_classification;
      }
      if(window.updateFearGreed){ window.updateFearGreed(item.value);}
    }catch(e){
      valueEl.textContent = 'N/A';
      if (labelEl) {
        labelEl.textContent = '--';
      }
    }
  }

  fetchFG();
  setInterval(fetchFG, REFRESH);
})(); 