# Deploy to Railway - Step by Step

## What is Railway?
Railway is a hosting platform that makes it super easy to deploy Python apps. Free tier is generous and perfect for this backend.

---

## Deployment Steps

### 1. Create Railway Account
1. Go to https://railway.app
2. Click **"Start a New Project"**
3. Sign up with GitHub (recommended)

### 2. Create New Project
1. Click **"New Project"**
2. Select **"Deploy from GitHub repo"**
3. Authorize Railway to access your GitHub
4. Select your `BlueChipSignals-main` repository

### 3. Configure Deployment
Railway will auto-detect Python. If it asks for settings:

**Root Directory:** `backend`  
**Build Command:** `pip install -r requirements.txt`  
**Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`

### 4. Add Environment Variables (Optional)
Go to your project → **Variables** tab:
- No special variables needed for basic setup
- Database is SQLite (auto-created)

### 5. Deploy!
1. Click **"Deploy"**
2. Railway will build and deploy (takes 2-3 minutes)
3. Once deployed, you'll see a green **"Active"** status

### 6. Get Your URL
1. Click on your deployment
2. Go to **Settings** tab
3. Scroll to **"Domains"**
4. Click **"Generate Domain"**
5. Copy the URL (e.g., `https://bluechip-signals-production.up.railway.app`)

---

## Update Your Code

### A. Update Dashboard
Open `dashboard.html` and change line 800:

```javascript
// OLD:
const API_URL = 'http://localhost:5001';

// NEW:
const API_URL = 'https://your-app-name.railway.app';
```

### B. Update GitHub Action
Add this to your GitHub repository secrets:

**Name:** `BACKEND_URL`  
**Value:** `https://your-app-name.railway.app/api/signals/new`

---

## Test Your Deployment

### 1. Health Check
Open in browser:
```
https://your-app-name.railway.app/
```

You should see:
```json
{
  "status": "online",
  "service": "BlueChip Signals Backend",
  "version": "1.0.0"
}
```

### 2. Admin Panel
Visit:
```
https://your-app-name.railway.app/admin
```

Login with password: `Pumrvb12!`

### 3. Post Test Signal
From admin panel, click **"Post Signal"** and fill out the form.

### 4. Check Dashboard
Go to your dashboard at GitHub Pages and verify the signal appears!

---

## Railway Free Tier Limits

✅ **Free Tier Includes:**
- 500 hours/month execution time (plenty for your use case)
- $5 credit per month
- Automatic sleeping after inactivity
- SSL certificate included

⚠️ **Important:**
- Backend "sleeps" after 10 minutes of no activity
- First request after sleep takes 10-20 seconds
- This is fine since signals only come every 2 hours

💡 **Pro Tip:** Upgrade to Hobby plan ($5/month) to prevent sleeping if needed.

---

## Monitoring & Logs

### View Logs:
1. Go to Railway dashboard
2. Click on your project
3. Click **"Deployments"** tab
4. Click on the active deployment
5. See real-time logs

### What to Look For:
```
✅ Signal for TSLA saved successfully
✅ GET /api/signals/latest
✅ POST /api/signals/new
```

---

## Troubleshooting

### Backend Not Starting?
**Check logs for:**
- Missing dependencies → `pip install` errors
- Port binding errors → Railway handles this automatically
- Database errors → SQLite creates automatically

**Fix:** Verify `requirements.txt` is correct

### Can't Access Admin Panel?
**Check:**
- URL is correct: `/admin` (no trailing slash)
- Password is exactly: `Pumrvb12!`
- Try incognito/private browser window

### Signals Not Appearing?
**Check:**
1. Railway logs show POST requests
2. Dashboard API_URL is updated
3. Browser console for errors (F12)
4. CORS enabled (backend already handles this)

### Connection Timeout?
- Backend was sleeping, wait 20 seconds and retry
- Or upgrade to prevent sleeping

---

## Custom Domain (Optional)

Want to use your own domain?

1. Buy a domain (Namecheap, GoDaddy, etc.)
2. In Railway: **Settings → Domains**
3. Click **"Custom Domain"**
4. Add your domain (e.g., `api.bluechipsignals.com`)
5. Update DNS records as Railway instructs
6. Wait for SSL certificate (automatic)

Then update your dashboard to use: `https://api.bluechipsignals.com`

---

## Security Notes

🔒 **Current Setup:**
- Admin password is in code (okay for MVP)
- No rate limiting (okay for private use)
- SQLite database (fine for starting)

🔐 **Before Going Public:**
- Move password to environment variable
- Add rate limiting for API endpoints
- Migrate to PostgreSQL
- Add proper user authentication
- Add API keys for GitHub Action

---

## Estimated Costs

**Free Tier:**
- First month: **$0**
- With your usage (signals every 2 hours): **$0**

**If You Upgrade to Hobby ($5/mo):**
- No sleeping
- Better performance
- More resources

---

## You're All Set! 🎉

**Order of Operations:**
1. ✅ Deploy to Railway (5 min)
2. ✅ Get Railway URL
3. ✅ Update dashboard.html with Railway URL
4. ✅ Add Backend URL to GitHub secrets
5. ✅ Update GitHub Action code
6. ✅ Test with manual trigger
7. ✅ Watch signals flow in!

**Need help with deployment? Share any error messages!**

