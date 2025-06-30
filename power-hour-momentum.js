class PowerHourMomentum {
    constructor() {
        this.apiKey = 'd0lumg9r01qpni31glsgd0lumg9r01qpni31glt0';
        this.symbol = 'SPY';
        this.updateInterval = 900000; // Update every 15 minutes
        this.momentumScore = 0;
        this.factors = {};
        
        this.init();
    }

    async init() {
        await this.updateMomentumIndicator();
        
        // Update every 15 minutes during market hours
        setInterval(() => {
            this.updateMomentumIndicator();
        }, this.updateInterval);
    }

    async fetchMarketData() {
        try {
            // Get current price and basic data
            const quoteResponse = await fetch(`https://finnhub.io/api/v1/quote?symbol=${this.symbol}&token=${this.apiKey}`);
            const quoteData = await quoteResponse.json();
            
            // Get intraday data for trend analysis
            const intradayResponse = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${this.symbol}&resolution=5&from=${Math.floor(Date.now()/1000) - 86400}&to=${Math.floor(Date.now()/1000)}&token=${this.apiKey}`);
            const intradayData = await intradayResponse.json();
            
            return {
                currentPrice: quoteData.c,
                previousClose: quoteData.pc,
                dayHigh: quoteData.h,
                dayLow: quoteData.l,
                openPrice: quoteData.o,
                volume: quoteData.v || 0,
                intraday: intradayData
            };
        } catch (error) {
            console.error('Error fetching market data:', error);
            return null;
        }
    }

    calculateVWAP(intradayData) {
        if (!intradayData || !intradayData.c || intradayData.c.length === 0) {
            return null;
        }

        let totalPV = 0;
        let totalVolume = 0;
        
        for (let i = 0; i < intradayData.c.length; i++) {
            const price = (intradayData.h[i] + intradayData.l[i] + intradayData.c[i]) / 3;
            const volume = intradayData.v[i] || 1000; // Fallback volume
            totalPV += price * volume;
            totalVolume += volume;
        }
        
        return totalVolume > 0 ? totalPV / totalVolume : null;
    }

    analyzeTrendStrength(intradayData, currentPrice, openPrice) {
        if (!intradayData || !intradayData.c || intradayData.c.length < 10) {
            return { strength: 'Unknown', score: 0 };
        }

        const prices = intradayData.c;
        const recentPrices = prices.slice(-20); // Last 20 periods
        
        // Calculate trend direction
        const priceChange = currentPrice - openPrice;
        const percentChange = (priceChange / openPrice) * 100;
        
        // Calculate momentum (recent price movement)
        const momentum = recentPrices[recentPrices.length - 1] - recentPrices[0];
        const momentumPercent = (momentum / recentPrices[0]) * 100;
        
        // Determine trend strength
        let strength, score;
        if (Math.abs(percentChange) > 1.5) {
            strength = Math.abs(momentumPercent) > 0.3 ? 'Very Strong' : 'Strong';
            score = Math.abs(percentChange) > 2 ? 85 : 70;
        } else if (Math.abs(percentChange) > 0.5) {
            strength = 'Moderate';
            score = 50;
        } else {
            strength = 'Weak';
            score = 25;
        }
        
        return {
            strength: `${strength} ${priceChange >= 0 ? 'Bullish' : 'Bearish'}`,
            score: priceChange >= 0 ? score : -score,
            percentChange: percentChange.toFixed(2)
        };
    }

    analyzeVolumePattern(intradayData) {
        if (!intradayData || !intradayData.v || intradayData.v.length < 10) {
            return { pattern: 'Unknown', score: 0 };
        }

        const volumes = intradayData.v;
        const recentVolume = volumes.slice(-10); // Last 10 periods
        const earlierVolume = volumes.slice(-30, -10); // Previous 20 periods
        
        const avgRecentVolume = recentVolume.reduce((a, b) => a + b, 0) / recentVolume.length;
        const avgEarlierVolume = earlierVolume.reduce((a, b) => a + b, 0) / earlierVolume.length;
        
        const volumeRatio = avgRecentVolume / avgEarlierVolume;
        
        let pattern, score;
        if (volumeRatio > 1.5) {
            pattern = 'Increasing';
            score = 75;
        } else if (volumeRatio > 1.2) {
            pattern = 'Rising';
            score = 60;
        } else if (volumeRatio > 0.8) {
            pattern = 'Steady';
            score = 40;
        } else {
            pattern = 'Declining';
            score = 20;
        }
        
        return { pattern, score };
    }

    calculateMomentumScore(trendAnalysis, volumeAnalysis, vwapPosition, sessionPerformance) {
        // Weight the different factors
        const trendWeight = 0.4;
        const volumeWeight = 0.25;
        const vwapWeight = 0.2;
        const sessionWeight = 0.15;
        
        const trendScore = Math.abs(trendAnalysis.score);
        const volumeScore = volumeAnalysis.score;
        const vwapScore = vwapPosition.score;
        const sessionScore = sessionPerformance.score;
        
        const weightedScore = (
            trendScore * trendWeight +
            volumeScore * volumeWeight +
            vwapScore * vwapWeight +
            sessionScore * sessionWeight
        );
        
        // Apply direction (bullish/bearish)
        const direction = trendAnalysis.score >= 0 ? 1 : -1;
        
        return Math.round(weightedScore * direction);
    }

    getMomentumLabel(score) {
        const absScore = Math.abs(score);
        const direction = score >= 0 ? 'Bullish' : 'Bearish';
        
        if (absScore >= 80) return `Very Strong ${direction}`;
        if (absScore >= 65) return `Strong ${direction}`;
        if (absScore >= 45) return `Moderate ${direction}`;
        if (absScore >= 25) return `Weak ${direction}`;
        return 'Neutral/Choppy';
    }

    getMomentumDescription(score, isMarketHours) {
        const absScore = Math.abs(score);
        const direction = score >= 0 ? 'bullish' : 'bearish';
        
        if (!isMarketHours) {
            return 'Market is closed. Analysis based on last trading session.';
        }
        
        if (absScore >= 70) {
            return `Strong ${direction} momentum suggests trend continuation into power hour. High probability setup.`;
        } else if (absScore >= 50) {
            return `Moderate ${direction} momentum. Watch for confirmation signals before power hour entries.`;
        } else if (absScore >= 30) {
            return `Weak momentum. Consider waiting for clearer directional signals or trade smaller size.`;
        } else {
            return 'Choppy/neutral conditions. Power hour could break either direction. Wait for volume confirmation.';
        }
    }

    isMarketHours() {
        const now = new Date();
        const easternTime = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
        const hours = easternTime.getHours();
        const minutes = easternTime.getMinutes();
        const dayOfWeek = easternTime.getDay();
        
        // Check if it's a weekday (Monday = 1, Friday = 5)
        if (dayOfWeek === 0 || dayOfWeek === 6) return false;
        
        // Market hours: 9:30 AM - 4:00 PM ET
        const marketOpen = 9.5; // 9:30 AM
        const marketClose = 16; // 4:00 PM
        const currentTime = hours + minutes / 60;
        
        return currentTime >= marketOpen && currentTime < marketClose;
    }

    async updateMomentumIndicator() {
        try {
            const marketData = await this.fetchMarketData();
            if (!marketData) {
                this.displayError();
                return;
            }

            // Calculate VWAP
            const vwap = this.calculateVWAP(marketData.intraday);
            
            // Analyze trend strength
            const trendAnalysis = this.analyzeTrendStrength(
                marketData.intraday, 
                marketData.currentPrice, 
                marketData.openPrice
            );
            
            // Analyze volume pattern
            const volumeAnalysis = this.analyzeVolumePattern(marketData.intraday);
            
            // VWAP position analysis
            const vwapPosition = {
                position: vwap ? (marketData.currentPrice > vwap ? 'Above VWAP' : 'Below VWAP') : 'Unknown',
                score: vwap ? (marketData.currentPrice > vwap ? 60 : 40) : 30
            };
            
            // Session performance
            const sessionChange = ((marketData.currentPrice - marketData.previousClose) / marketData.previousClose) * 100;
            const sessionPerformance = {
                change: sessionChange.toFixed(2),
                score: Math.min(Math.abs(sessionChange) * 20, 80) // Cap at 80
            };
            
            // Calculate overall momentum score
            const momentumScore = this.calculateMomentumScore(
                trendAnalysis, 
                volumeAnalysis, 
                vwapPosition, 
                sessionPerformance
            );
            
            // Store factors for display
            this.factors = {
                trendAnalysis,
                volumeAnalysis,
                vwapPosition,
                sessionPerformance,
                currentPrice: marketData.currentPrice
            };
            
            this.momentumScore = momentumScore;
            
            // Update display
            this.updateDisplay(momentumScore, this.isMarketHours());
            
        } catch (error) {
            console.error('Error updating momentum indicator:', error);
            this.displayError();
        }
    }

    updateDisplay(score, isMarketHours) {
        // Update main score display
        document.getElementById('momentum-score').textContent = score;
        document.getElementById('momentum-label').textContent = this.getMomentumLabel(score);
        document.getElementById('momentum-description').textContent = this.getMomentumDescription(score, isMarketHours);
        
        // Color coding
        const scoreElement = document.getElementById('momentum-score');
        if (Math.abs(score) >= 70) {
            scoreElement.style.color = score >= 0 ? '#00ff88' : '#ff4444';
        } else if (Math.abs(score) >= 40) {
            scoreElement.style.color = 'var(--secondary-gold)';
        } else {
            scoreElement.style.color = '#888';
        }
        
        // Update factor details
        if (this.factors.trendAnalysis) {
            document.getElementById('trend-strength').textContent = this.factors.trendAnalysis.strength;
            document.getElementById('trend-strength').style.color = 
                this.factors.trendAnalysis.score >= 0 ? '#00ff88' : '#ff4444';
        }
        
        if (this.factors.volumeAnalysis) {
            document.getElementById('volume-pattern').textContent = this.factors.volumeAnalysis.pattern;
            const volumeColor = this.factors.volumeAnalysis.score >= 60 ? '#00ff88' : 
                               this.factors.volumeAnalysis.score >= 40 ? 'var(--secondary-gold)' : '#ff4444';
            document.getElementById('volume-pattern').style.color = volumeColor;
        }
        
        if (this.factors.vwapPosition) {
            document.getElementById('vwap-position').textContent = this.factors.vwapPosition.position;
            document.getElementById('vwap-position').style.color = 
                this.factors.vwapPosition.position.includes('Above') ? '#00ff88' : '#ff4444';
        }
        
        if (this.factors.sessionPerformance) {
            const change = parseFloat(this.factors.sessionPerformance.change);
            document.getElementById('session-performance').textContent = `${change >= 0 ? '+' : ''}${change}%`;
            document.getElementById('session-performance').style.color = change >= 0 ? '#00ff88' : '#ff4444';
        }
        
        if (this.factors.currentPrice) {
            document.getElementById('current-price').textContent = `$${this.factors.currentPrice.toFixed(2)}`;
        }
        
        // Show factor details
        document.getElementById('momentum-factors').style.display = 'block';
    }

    displayError() {
        document.getElementById('momentum-score').textContent = '--';
        document.getElementById('momentum-label').textContent = 'Data Unavailable';
        document.getElementById('momentum-description').textContent = 'Unable to load market data. Please try again later.';
        document.getElementById('momentum-factors').style.display = 'none';
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new PowerHourMomentum();
}); 