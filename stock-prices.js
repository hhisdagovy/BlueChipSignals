document.addEventListener('DOMContentLoaded', () => {
    const stockCards = document.querySelectorAll('.bot-card[data-symbol]');
    
    const fetchStockPrice = async (symbol) => {
        const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            const quote = data['Global Quote'];

            if (quote && quote['05. price']) {
                const price = parseFloat(quote['05. price']).toFixed(2);
                const change = parseFloat(quote['10. change percent']).toFixed(2);
                return { price, change };
            } else {
                // Alpha Vantage free tier is limited. If the API call fails, it might be due to the call limit.
                // It could also be that the object is empty for that symbol.
                console.error(`Could not retrieve price for ${symbol}. Response was: `, data);
                return { price: 'N/A', change: 'N/A' };
            }
        } catch (error) {
            console.error('Error fetching stock data:', error);
            return { price: 'Error', change: '' };
        }
    };

    const updateStockPrices = async () => {
        for (const card of stockCards) {
            const symbol = card.dataset.symbol;
            if (symbol) {
                const { price, change } = await fetchStockPrice(symbol);
                
                const priceElement = card.querySelector('.price');
                const changeElement = card.querySelector('.change');

                if (priceElement) {
                    priceElement.textContent = `$${price}`;
                }
                if (changeElement) {
                    const changeValue = parseFloat(change);
                    if (!isNaN(changeValue)) {
                        changeElement.textContent = `${change}%`;
                        if (changeValue > 0) {
                            changeElement.classList.add('positive');
                            changeElement.classList.remove('negative');
                        } else {
                            changeElement.classList.add('negative');
                            changeElement.classList.remove('positive');
                        }
                    } else {
                        changeElement.textContent = '';
                    }
                }
            }
        }
    };

    // Update prices on load and then every minute
    updateStockPrices();
    setInterval(updateStockPrices, 60000); 
}); 