// fear-greed.js
(function(){
  const SOURCE_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/greedandfear.json';
  const API_URL = `https://api.allorigins.win/raw?url=${encodeURIComponent(SOURCE_URL)}`;
  const REFRESH = 300000; // 5 min
  const valueEl = document.getElementById('fg-value');
  const labelEl = document.getElementById('fg-label');
  if(!valueEl) return;

  async function fetchFG(){
    try{
      const res = await fetch(API_URL);
      if(!res.ok) throw new Error('network');
      const json = await res.json();
      const data = json.fear_and_greed?.now;
      if(!data) throw new Error('parse');
      valueEl.textContent = data.value;
      labelEl.textContent = data.value_classification;
    }catch(e){
      valueEl.textContent = 'N/A';
      labelEl.textContent = 'Unavailable';
    }
  }

  fetchFG();
  setInterval(fetchFG, REFRESH);
})(); 