# Blue Chip Signals Backend

FastHTML backend for managing trading signals.

## Setup

### 1. Install Dependencies
```bash
pip install -r requirements.txt
```

### 2. Run Locally
```bash
python main.py
```

The server will start at `http://localhost:5001`

### 3. Test API
```bash
# Health check
curl http://localhost:5001/

# Post a test signal
curl -X POST http://localhost:5001/api/signals/new \
  -H "Content-Type: application/json" \
  -d '{
    "stock": "TSLA",
    "price": 339.96,
    "vwap": 339.39,
    "mfi": 63.00,
    "contract": {
      "type": "Call",
      "strike": 337.50,
      "premium": 3.48,
      "expiration": "2025-05-23",
      "volume": 66367
    }
  }'

# Get latest signals
curl http://localhost:5001/api/signals/latest
```

## Admin Access

- URL: `http://localhost:5001/admin`
- Password: `Pumrvb12!`

## API Endpoints

### POST /api/signals/new
Post a new trading signal (used by GitHub Action)

### GET /api/signals/latest?limit=50
Get latest signals for dashboard

### GET /api/signals/filter?stock=TSLA&start_date=2025-01-01
Filter signals by stock and date

## Deployment to Railway

1. Create Railway account at https://railway.app
2. Connect your GitHub repo
3. Railway will auto-detect Python and deploy
4. Set environment variables if needed
5. Get your Railway URL (e.g., `https://your-app.railway.app`)

## Update GitHub Action

Add this to your GitHub Action after posting to Telegram:

```python
import requests

# Post to backend
response = requests.post(
    'https://your-backend-url.railway.app/api/signals/new',
    json={
        "stock": "TSLA",
        "price": price,
        "vwap": vwap,
        "mfi": mfi,
        "contract": {
            "type": "Call",
            "strike": strike_price,
            "premium": premium,
            "expiration": expiration_date,
            "volume": volume
        }
    }
)
print(f"Backend response: {response.json()}")
```

