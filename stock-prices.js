document.addEventListener('DOMContentLoaded', () => {
    const stockDataApiKey = "MVQoRQoD8ZPzoqrFuPpGV2CA2L4vuOZCL2AEflMU";
    const polygonApiKey = "sTQWgQESNYRtbmcO5yKoOrToz2ZZeryV";
    const priceChartCanvas = document.getElementById('priceChart');

    // Helper Functions
    const formatDate = (date) => {
        return date.toISOString().split('T')[0];
    };
    
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // This logic is only needed for the bot pages.
    if (priceChartCanvas) {
        const today = new Date();
        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(today.getDate() - 15);
        const to = formatDate(today);
        const from = formatDate(twoWeeksAgo);
        
        const symbol = document.querySelector('.bot-symbol').textContent;
        updateSingleBotPage(symbol, from, to);
    }

    // Main function for bot pages
    async function updateSingleBotPage(symbol, from, to) {
        const { price, change } = await fetchPreviousDayClose(symbol);
        updatePriceDisplay(document, price, change);

        const historicalData = await fetchHistoricalData(symbol, from, to);
        if (historicalData) {
            renderPriceChart(historicalData);
        }

        const newsData = await fetchNews(symbol);
        if (newsData) {
            renderNews(newsData);
        }
    }

    // Data Fetching functions
    async function fetchPreviousDayClose(symbol) {
        const url = `https://api.stockdata.org/v1/data/quote?symbols=${symbol}&api_token=${stockDataApiKey}`;
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();

            if (data.data && data.data.length > 0) {
                const quote = data.data[0];
                const price = quote.price.toFixed(2);
                const change = quote.day_change;
                return { price, change };
            } else {
                console.error(`Could not retrieve price for ${symbol}. Response was: `, data);
                return { price: 'N/A', change: '' };
            }
        } catch (error) {
            console.error(`Error fetching stock data for ${symbol}:`, error);
            return { price: 'Error', change: '' };
        }
    }

    async function fetchHistoricalData(symbol, from, to) {
        const url = `https://api.stockdata.org/v1/data/eod?symbols=${symbol}&date_from=${from}&date_to=${to}&api_token=${stockDataApiKey}`;
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();

            if (data.data && data.data.length > 0) {
                return data.data;
            } else {
                console.error(`Could not retrieve historical data for ${symbol}. Response was: `, data);
                return null;
            }
        } catch (error) {
            console.error(`Error fetching historical data for ${symbol}:`, error);
            return null;
        }
    }

    async function fetchNews(symbol) {
        const url = `https://api.polygon.io/v2/reference/news?ticker=${symbol}&limit=3&apiKey=${polygonApiKey}`;
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            if (data.results && data.results.length > 0) {
                return data.results;
            } else {
                console.error(`Could not retrieve news for ${symbol} from Polygon. Response was: `, data);
                return null;
            }
        } catch (error) {
            console.error(`Error fetching news for ${symbol} from Polygon:`, error);
            return null;
        }
    }

    // -- DOM Manipulation & Rendering --
    function updatePriceDisplay(container, price, change) {
        const priceElement = container.querySelector('.price');
        const changeElement = container.querySelector('.change');

        if (priceElement) {
             // Don't show a dollar sign if the price is N/A or Error
            if (isNaN(price)) {
                priceElement.textContent = price;
            } else {
                priceElement.textContent = `$${price}`;
            }
        }

        if (changeElement) {
            const changeValue = parseFloat(change);
            if (!isNaN(changeValue)) {
                const sign = changeValue > 0 ? '+' : '';
                changeElement.textContent = `${sign}${changeValue.toFixed(2)}%`;
                changeElement.classList.toggle('positive', changeValue > 0);
                changeElement.classList.toggle('negative', changeValue < 0);
            } else {
                changeElement.textContent = '';
            }
        }
    }

    function renderNews(newsData) {
        const newsGrid = document.getElementById('news-grid');
        if (!newsGrid) return;

        newsGrid.innerHTML = ''; // Clear existing news

        newsData.forEach(article => {
            const newsCard = document.createElement('a');
            newsCard.href = article.article_url;
            newsCard.target = '_blank';
            newsCard.rel = 'noopener noreferrer';
            newsCard.className = 'news-card';

            const image = document.createElement('img');
            image.src = article.image_url || 'logo.png'; // Use a placeholder if no image
            image.alt = article.title;
            image.className = 'news-image';
            image.onerror = () => { image.src = 'logo.png'; }; // Fallback for broken image links

            const content = document.createElement('div');
            content.className = 'news-content';

            const title = document.createElement('h4');
            title.className = 'news-title';
            title.textContent = article.title;

            const description = document.createElement('p');
            description.className = 'news-description';
            description.textContent = article.description || 'No description available.';

            const footer = document.createElement('div');
            footer.className = 'news-footer';

            const publisher = document.createElement('span');
            publisher.className = 'news-publisher';
            publisher.textContent = article.publisher.name;

            const publishedDate = new Date(article.published_utc);
            const dateSpan = document.createElement('span');
            dateSpan.className = 'news-date';
            dateSpan.textContent = publishedDate.toLocaleDateString();

            footer.appendChild(publisher);
            footer.appendChild(dateSpan);
            
            content.appendChild(title);
            content.appendChild(description);
            content.appendChild(footer);

            newsCard.appendChild(image);
            newsCard.appendChild(content);

            newsGrid.appendChild(newsCard);
        });
    }

    function renderPriceChart(historicalData) {
        const ctx = priceChartCanvas.getContext('2d');
        const labels = historicalData.map(item => formatDate(new Date(item.date)));
        const dataPoints = historicalData.map(item => item.close);

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
                    pointRadius: 3,
                    pointBackgroundColor: '#b3a17d',
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
                                return '$' + value.toFixed(2);
                            }
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        callbacks: {
                            label: function(context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.y !== null) {
                                    label += new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(context.parsed.y);
                                }
                                return label;
                            }
                        }
                    }
                }
            }
        });
    }

}); 