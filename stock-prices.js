document.addEventListener('DOMContentLoaded', () => {
    const apiKey = "sTQWgQESNYRtbmcO5yKoOrToz2ZZeryV";
    const stockCards = document.querySelectorAll('.bot-card[data-symbol]');
    const singleBotSymbolEl = document.querySelector('.bot-symbol');

    // -- Helper Functions --
    const formatDate = (date) => {
        return date.toISOString().split('T')[0];
    };

    const today = new Date();
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(today.getDate() - 14);

    const to = formatDate(today);
    const from = formatDate(twoWeeksAgo);

    // -- Main Logic --

    // If we are on a bot page
    if (singleBotSymbolEl) {
        const symbol = singleBotSymbolEl.textContent;
        updateSingleBotPage(symbol);
    }

    // If we are on the main index page
    if (stockCards.length > 0) {
        updateIndexPage();
    }


    // -- Page-Specific Update Functions --

    async function updateSingleBotPage(symbol) {
        // Fetch and display the current price
        const { price, change } = await fetchPreviousDayClose(symbol);
        updatePriceDisplay(document, price, change);

        // Fetch and display the chart
        const historicalData = await fetchHistoricalData(symbol, from, to);
        if (historicalData) {
            renderPriceChart(historicalData);
        }
    }

    function updateIndexPage() {
        for (const card of stockCards) {
            const symbol = card.dataset.symbol;
            if (symbol) {
                fetchPreviousDayClose(symbol).then(({ price, change }) => {
                    updatePriceDisplay(card, price, change);
                });
            }
        }
    }

    // -- Data Fetching --

    async function fetchPreviousDayClose(symbol) {
        const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${apiKey}`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            if (data.status === "OK" && data.resultsCount > 0) {
                const quote = data.results[0];
                const price = quote.c.toFixed(2);
                const previousClose = quote.o;
                const change = (((quote.c - previousClose) / previousClose) * 100).toFixed(2);
                return { price, change };
            } else {
                console.error(`Could not retrieve price for ${symbol}. Response was: `, data);
                return { price: 'N/A', change: 'N/A' };
            }
        } catch (error) {
            console.error(`Error fetching stock data for ${symbol}:`, error);
            return { price: 'Error', change: '' };
        }
    }

    async function fetchHistoricalData(symbol, from, to) {
        const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}?adjusted=true&sort=asc&apiKey=${apiKey}`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            if (data.status === "OK" && data.results) {
                return data.results;
            } else {
                console.error(`Could not retrieve historical data for ${symbol}. Response was: `, data);
                return null;
            }
        } catch (error) {
            console.error(`Error fetching historical data for ${symbol}:`, error);
            return null;
        }
    }


    // -- DOM Manipulation & Rendering --

    function updatePriceDisplay(container, price, change) {
        const priceElement = container.querySelector('.price');
        const changeElement = container.querySelector('.change');

        if (priceElement) {
            priceElement.textContent = `$${price}`;
        }

        if (changeElement) {
            const changeValue = parseFloat(change);
            if (!isNaN(changeValue)) {
                changeElement.textContent = `${changeValue.toFixed(2)}%`;
                changeElement.classList.toggle('positive', changeValue > 0);
                changeElement.classList.toggle('negative', changeValue < 0);
            } else {
                changeElement.textContent = '';
            }
        }
    }

    function renderPriceChart(historicalData) {
        const ctx = document.getElementById('priceChart').getContext('2d');
        const labels = historicalData.map(item => formatDate(new Date(item.t)));
        const dataPoints = historicalData.map(item => item.c);

        const chartGradient = ctx.createLinearGradient(0, 0, 0, 400);
        chartGradient.addColorStop(0, 'rgba(179, 161, 125, 0.4)');
        chartGradient.addColorStop(1, 'rgba(179, 161, 125, 0)');

        new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Close Price',
                    data: dataPoints,
                    borderColor: '#b3a17d',
                    backgroundColor: chartGradient,
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)'
                        },
                        ticks: {
                            color: '#A0A0A0'
                        }
                    },
                    y: {
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)'
                        },
                        ticks: {
                            color: '#A0A0A0',
                            callback: function(value, index, values) {
                                return '$' + value;
                            }
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: false
                    }
                }
            }
        });
    }

}); 