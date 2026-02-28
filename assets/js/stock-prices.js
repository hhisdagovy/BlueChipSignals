import { POLYGON_API_KEY } from './config.js';

document.addEventListener('DOMContentLoaded', () => {
    const polygonApiKey = POLYGON_API_KEY;

    // This logic is only needed for the bot pages.
    if (document.querySelector('.bot-symbol')) {
        const symbol = document.querySelector('.bot-symbol').textContent;
        updateNews(symbol);
    }

    async function updateNews(symbol) {
        const newsData = await fetchNews(symbol);
        if (newsData) {
            renderNews(newsData);
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
}); 