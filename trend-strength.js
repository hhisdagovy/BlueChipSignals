// trend-strength.js - SPY Trend Strength Indicator
(function(){
    const ALPHA_API_KEY = 'HDOWXQPV1MQWV0MI'; // Alpha Vantage API key
    const FINNHUB_API_KEY = 'd0lumg9r01qpni31glsgd0lumg9r01qpni31glt0'; // Finnhub API key
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
            // Try Finnhub quote first (simpler endpoint)
            console.log('Trying Finnhub quote API...');
            const quoteResponse = await fetch(`https://finnhub.io/api/v1/quote?symbol=${SYMBOL}&token=${FINNHUB_API_KEY}`);
            
            if (!quoteResponse.ok) {
                throw new Error(`Finnhub quote API failed: ${quoteResponse.status}`);
            }
            
            const quoteData = await quoteResponse.json();
            console.log('Finnhub quote response:', quoteData);
            
            if (!quoteData.c) {
                throw new Error('No current price in Finnhub quote response');
            }

            const currentPrice = quoteData.c;
            
            // Now try to get historical data for MAs
            console.log('Trying Finnhub candle API for historical data...');
            const toDate = Math.floor(Date.now() / 1000);
            const fromDate = toDate - (365 * 24 * 60 * 60); // 1 year ago
            
            const candleResponse = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${SYMBOL}&resolution=D&from=${fromDate}&to=${toDate}&token=${FINNHUB_API_KEY}`);
            
            if (candleResponse.ok) {
                const candleData = await candleResponse.json();
                console.log('Finnhub candle response status:', candleData.s);
                
                if (candleData.s === 'ok' && candleData.c && candleData.c.length >= 200) {
                    const prices = candleData.c;
                    const ma20 = calculateMAFromArray(prices, 20);
                    const ma50 = calculateMAFromArray(prices, 50);
                    const ma200 = calculateMAFromArray(prices, 200);

                    console.log('Successfully fetched Finnhub data with historical MAs:', { currentPrice, ma20, ma50, ma200 });
                    updateTrendMeter(currentPrice, ma20, ma50, ma200);
                    return;
                } else {
                    console.log('Historical data insufficient, using estimated MAs');
                }
            }
            
            // Use current price with estimated MAs if historical data fails
            const ma20 = currentPrice * 0.995;  // Estimate based on typical SPY behavior
            const ma50 = currentPrice * 0.985;  
            const ma200 = currentPrice * 0.95;  
            
            console.log('Using Finnhub current price with estimated MAs:', { currentPrice, ma20, ma50, ma200 });
            updateTrendMeter(currentPrice, ma20, ma50, ma200);
            
            // Add note about estimated MAs
            setTimeout(() => {
                if (trendDescription.textContent && !trendDescription.textContent.includes('Estimated')) {
                    trendDescription.textContent = trendDescription.textContent + ' (Estimated MAs)';
                }
            }, 1000);

        } catch (error) {
            console.error('Error fetching SPY data from Finnhub:', error);
            
            // Try Alpha Vantage as backup
            try {
                const response = await fetch(`https://www.alphavantage.co/query?function=DAILY&symbol=${SYMBOL}&apikey=${ALPHA_API_KEY}&outputsize=compact`);
                const data = await response.json();
                
                if (data['Time Series (Daily)']) {
                    const timeSeries = data['Time Series (Daily)'];
                    const dates = Object.keys(timeSeries).sort((a, b) => new Date(b) - new Date(a));
                    const latestDate = dates[0];
                    const currentPrice = parseFloat(timeSeries[latestDate]['4. close']);

                    const ma20 = calculateMA(timeSeries, dates, 20);
                    const ma50 = calculateMA(timeSeries, dates, 50);
                    const ma200 = calculateMA(timeSeries, dates, 200);

                    console.log('Successfully fetched Alpha Vantage data:', { currentPrice, ma20, ma50, ma200 });
                    updateTrendMeter(currentPrice, ma20, ma50, ma200);
                    return;
                }
            } catch (alphaError) {
                console.error('Alpha Vantage backup also failed:', alphaError);
            }
            
            // Try Yahoo Finance via proxy as last resort
            try {
                const proxyUrl = 'https://api.allorigins.win/get?url=';
                const targetUrl = encodeURIComponent('https://query1.finance.yahoo.com/v8/finance/chart/SPY?period1=0&period2=9999999999&interval=1d&includePrePost=false&events=div%2Csplit');
                
                const response = await fetch(proxyUrl + targetUrl);
                const proxyData = await response.json();
                const data = JSON.parse(proxyData.contents);
                
                if (data.chart && data.chart.result && data.chart.result[0]) {
                    const result = data.chart.result[0];
                    const prices = result.indicators.quote[0].close;
                    
                    if (prices && prices.length >= 200) {
                        const currentPrice = prices[prices.length - 1];
                        const ma20 = calculateMAFromArray(prices, 20);
                        const ma50 = calculateMAFromArray(prices, 50);
                        const ma200 = calculateMAFromArray(prices, 200);

                        console.log('Successfully fetched Yahoo Finance data via proxy:', { currentPrice, ma20, ma50, ma200 });
                        updateTrendMeter(currentPrice, ma20, ma50, ma200);
                        return;
                    }
                }
            } catch (yahooError) {
                console.error('Yahoo Finance backup also failed:', yahooError);
            }
            
            // Show error state if all APIs fail
            trendScore.textContent = 'API Error';
            trendDescription.textContent = 'Unable to fetch live market data. Please try again later.';
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

    function calculateMA(timeSeries, dates, period) {
        if (dates.length < period) return null;
        
        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += parseFloat(timeSeries[dates[i]]['4. close']);
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