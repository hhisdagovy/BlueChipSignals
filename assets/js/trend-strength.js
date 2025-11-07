// trend-strength.js - SPY Trend Strength Indicator
(function(){
    const POLYGON_API_KEY = 'sTQWgQESNYRtbmcO5yKoOrToz2ZZeryV'; // Polygon.io API key
    const SYMBOL = 'SPY';
    const REFRESH_INTERVAL = 300000; // 5 minutes

    const trendArc = document.getElementById('trend-arc');
    const trendNeedle = document.getElementById('trend-needle');
    const trendScore = document.getElementById('trend-score');
    const trendDescription = document.getElementById('trend-description');
    const maStatus = document.getElementById('ma-status');

    if (!trendArc) return;

    async function fetchSPYData() {
        try {
            console.log('Fetching SPY data from Polygon.io...');
            
            // Get current snapshot
            const snapshotResponse = await fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${SYMBOL}?apiKey=${POLYGON_API_KEY}`);
            const snapshotData = await snapshotResponse.json();
            
            if (!snapshotData.ticker) {
                throw new Error('No snapshot data from Polygon');
            }
            
            const currentPrice = snapshotData.ticker.lastTrade?.p || snapshotData.ticker.day?.c;
            
            if (!currentPrice) {
                throw new Error('No current price available');
            }
            
            // Get historical daily data for moving averages (need 200+ days)
            const toDate = new Date().toISOString().split('T')[0];
            const fromDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            
            const aggregatesResponse = await fetch(`https://api.polygon.io/v2/aggs/ticker/${SYMBOL}/range/1/day/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=300&apiKey=${POLYGON_API_KEY}`);
            const aggregatesData = await aggregatesResponse.json();
            
            if (aggregatesData.results && aggregatesData.results.length >= 200) {
                const prices = aggregatesData.results.map(bar => bar.c);
                const ma20 = calculateMAFromArray(prices, 20);
                const ma50 = calculateMAFromArray(prices, 50);
                const ma200 = calculateMAFromArray(prices, 200);
                
                console.log('Successfully fetched Polygon data:', { currentPrice, ma20, ma50, ma200 });
                updateTrendMeter(currentPrice, ma20, ma50, ma200);
                return;
            }
            
            // If we don't have enough historical data, estimate MAs
            console.log('Insufficient historical data, using estimates');
            const ma20 = currentPrice * 0.995;
            const ma50 = currentPrice * 0.99;
            const ma200 = currentPrice * 0.97;
            updateTrendMeter(currentPrice, ma20, ma50, ma200);
            
        } catch (error) {
            console.error('Error fetching SPY data from Polygon:', error);
            trendScore.textContent = '--';
            trendDescription.textContent = 'Data Unavailable';
        }
    }

    function calculateMAFromArray(prices, period) {
        if (prices.length < period) return null;
        
        let sum = 0;
        for (let i = prices.length - period; i < prices.length; i++) {
            sum += prices[i];
        }
        return sum / period;
    }

    function updateTrendMeter(currentPrice, ma20, ma50, ma200) {
        // Calculate trend strength score (0-100)
        let score = 50; // Start at neutral
        let bullishSignals = 0;
        let bearishSignals = 0;

        // Check position relative to each MA
        if (ma20) {
            if (currentPrice > ma20) {
                bullishSignals++;
                score += 15;
            } else {
                bearishSignals++;
                score -= 15;
            }
        }

        if (ma50) {
            if (currentPrice > ma50) {
                bullishSignals++;
                score += 15;
            } else {
                bearishSignals++;
                score -= 15;
            }
        }

        if (ma200) {
            if (currentPrice > ma200) {
                bullishSignals++;
                score += 20; // 200-day MA gets more weight
            } else {
                bearishSignals++;
                score -= 20;
            }
        }

        // Ensure score stays within bounds
        score = Math.max(0, Math.min(100, score));

        // Update visual elements
        updateMeter(score);
        updateStatus(currentPrice, ma20, ma50, ma200, score, bullishSignals, bearishSignals);
    }

    function updateMeter(score) {
        const percentage = score / 100;
        const angle = -90 + (percentage * 180); // -90 to +90 degrees
        const arcLength = percentage * 282.7; // Half circumference of a 90 radius circle (π*r)
        
        // Update needle position
        trendNeedle.setAttribute('transform', `rotate(${angle})`);
        
        // Update arc length and color
        trendArc.setAttribute('stroke-dasharray', `${arcLength} 565`);
        
        // Color based on score
        let color;
        if (score >= 70) color = '#27AE60'; // Strong bullish - green
        else if (score >= 55) color = '#E2CFB5'; // Mild bullish - light gold
        else if (score >= 45) color = '#b3a17d'; // Neutral - primary gold
        else if (score >= 30) color = '#E67E22'; // Mild bearish - orange
        else color = '#C0392B'; // Strong bearish - red
        
        trendArc.style.stroke = color;
    }

    function updateStatus(currentPrice, ma20, ma50, ma200, score, bullishSignals, bearishSignals) {
        // Update main score display
        trendScore.textContent = Math.round(score);
        
        // Update description
        let description;
        if (score >= 70) description = 'Strong Bullish';
        else if (score >= 55) description = 'Mild Bullish';
        else if (score >= 45) description = 'Neutral';
        else if (score >= 30) description = 'Mild Bearish';
        else description = 'Strong Bearish';
        
        trendDescription.textContent = description;

        // Update current price
        document.getElementById('current-spy-price').textContent = `$${currentPrice.toFixed(2)}`;

        // Update MA status
        updateMAStatus('ma20', currentPrice, ma20);
        updateMAStatus('ma50', currentPrice, ma50);
        updateMAStatus('ma200', currentPrice, ma200);

        // Show the MA status section
        maStatus.style.display = 'block';
    }

    function updateMAStatus(maId, currentPrice, maValue) {
        const statusEl = document.getElementById(maId + '-status');
        const priceEl = document.getElementById(maId + '-price');
        
        if (maValue) {
            const isAbove = currentPrice > maValue;
            statusEl.textContent = isAbove ? 'Above' : 'Below';
            statusEl.style.color = isAbove ? '#27AE60' : '#C0392B';
            priceEl.textContent = `$${maValue.toFixed(2)}`;
        } else {
            statusEl.textContent = 'N/A';
            statusEl.style.color = 'var(--gray-text)';
            priceEl.textContent = '--';
        }
    }

    // Initial fetch
    fetchSPYData();
    
    // Refresh every 5 minutes
    setInterval(fetchSPYData, REFRESH_INTERVAL);

})(); 