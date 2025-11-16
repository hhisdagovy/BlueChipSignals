# GitHub Action Integration Guide

## What You Need to Add

After your GitHub Action sends a signal to Telegram, add **one more step** to also post it to your backend.

---

## Step 1: Add This Code to Your GitHub Action

Find the part of your Python script where you **successfully send to Telegram**, then add this right after:

```python
import requests
import json

def post_to_backend(signal_data):
    """
    Post signal to Blue Chip Signals backend
    
    Args:
        signal_data: Dictionary containing signal information
    """
    # Your backend URL (update after deploying to Railway)
    BACKEND_URL = "https://your-app-name.railway.app/api/signals/new"
    
    try:
        response = requests.post(
            BACKEND_URL,
            json=signal_data,
            headers={"Content-Type": "application/json"},
            timeout=10
        )
        
        if response.status_code == 200:
            result = response.json()
            print(f"✅ Signal posted to backend: {result['message']}")
            return True
        else:
            print(f"❌ Backend error: {response.text}")
            return False
            
    except Exception as e:
        print(f"❌ Failed to post to backend: {e}")
        # Don't fail the whole action if backend is down
        return False


# Example: After you post to Telegram, call this function
# Your existing code finds a signal like:
stock = "TSLA"
price = 339.96
vwap = 339.39
mfi = 63.00
contract_type = "Call"
strike_price = 337.50
premium = 3.48
expiration = "2025-05-23"
volume = 66367

# Format data for backend
signal_payload = {
    "stock": stock,
    "price": price,
    "vwap": vwap,
    "mfi": mfi,
    "contract": {
        "type": contract_type,
        "strike": strike_price,
        "premium": premium,
        "expiration": expiration,
        "volume": volume
    }
}

# Send to Telegram (your existing code)
send_telegram_message(...)  # Your existing function

# THEN send to backend
post_to_backend(signal_payload)
```

---

## Step 2: Complete Example

Here's what your GitHub Action Python file might look like after adding backend integration:

```python
# your_signal_bot.py

import requests
import os

# Telegram config (your existing)
TELEGRAM_BOT_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN')
TELEGRAM_CHAT_ID = os.getenv('TELEGRAM_CHAT_ID')

# Backend config (NEW)
BACKEND_URL = os.getenv('BACKEND_URL', 'https://your-app.railway.app/api/signals/new')


def send_telegram(stock, price, vwap, mfi, contract_info):
    """Your existing Telegram function"""
    message = f"""
🚨 {stock} Signal Alert

📊 Entry: ${price}
📈 VWAP: ${vwap}
💹 MFI: {mfi}

📝 Contract:
Type: {contract_info['type']}
Strike: ${contract_info['strike']}
Premium: ${contract_info['premium']}
Exp: {contract_info['expiration']}
    """
    
    telegram_url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    response = requests.post(telegram_url, json={
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "HTML"
    })
    return response.status_code == 200


def post_to_backend(signal_data):
    """Post signal to backend database"""
    try:
        response = requests.post(
            BACKEND_URL,
            json=signal_data,
            headers={"Content-Type": "application/json"},
            timeout=10
        )
        
        if response.status_code == 200:
            print(f"✅ Backend: {response.json()['message']}")
            return True
        else:
            print(f"⚠️ Backend returned {response.status_code}")
            return False
    except Exception as e:
        print(f"⚠️ Backend error: {e}")
        return False


def main():
    # Your existing logic to find signals
    # ...
    # When you find a viable signal:
    
    signal_data = {
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
    }
    
    # 1. Send to Telegram
    if send_telegram(
        signal_data['stock'],
        signal_data['price'],
        signal_data['vwap'],
        signal_data['mfi'],
        signal_data['contract']
    ):
        print("✅ Sent to Telegram")
    
    # 2. Send to Backend
    post_to_backend(signal_data)


if __name__ == "__main__":
    main()
```

---

## Step 3: Add Backend URL to GitHub Secrets

1. Go to your GitHub repository
2. Navigate to: **Settings → Secrets and variables → Actions**
3. Click **New repository secret**
4. Name: `BACKEND_URL`
5. Value: `https://your-app-name.railway.app/api/signals/new`
6. Click **Add secret**

Then in your workflow file (`.github/workflows/your-workflow.yml`), add:

```yaml
env:
  BACKEND_URL: ${{ secrets.BACKEND_URL }}
```

---

## Testing

### Test Backend Locally First:

```bash
# In backend folder
cd backend
python main.py
```

Then test API:
```bash
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
```

You should see:
```json
{
  "success": true,
  "signal_id": 1,
  "message": "Signal for TSLA saved successfully"
}
```

---

## Deployment Checklist

- [ ] Backend deployed to Railway
- [ ] Railway URL obtained (e.g., `https://bluechip-signals.railway.app`)
- [ ] GitHub Secret `BACKEND_URL` added
- [ ] Backend integration code added to GitHub Action
- [ ] Dashboard `API_URL` updated with Railway URL
- [ ] Test signal posted manually to verify
- [ ] GitHub Action tested with manual trigger

---

## Troubleshooting

**Backend returns 400 "Missing required fields":**
- Check JSON structure matches exactly
- Ensure all required fields are present

**Backend returns 500:**
- Check Railway logs
- Database might not be initialized

**Connection timeout:**
- Backend might be sleeping (Railway free tier)
- First request after sleep takes 10-20 seconds

**Dashboard shows no signals:**
- Check browser console for errors
- Verify `API_URL` in dashboard.html is correct
- Check CORS if needed (backend should allow it)

---

## Next Steps

1. Deploy backend to Railway
2. Update GitHub Action with backend code
3. Test with manual workflow dispatch
4. Monitor signals appearing in admin panel
5. Check dashboard displays real signals

**Need help with any step? Share your GitHub Action Python file and I'll show you exactly where to add the code!**

