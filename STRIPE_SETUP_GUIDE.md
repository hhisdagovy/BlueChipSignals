# 💳 Stripe Integration Setup Guide

## Overview
This guide will help you integrate Stripe subscription management with your BlueChip Signals platform.

---

## 🚀 Quick Start (3 Main Steps)

### Step 1: Set Up Stripe Account
### Step 2: Configure Stripe Customer Portal
### Step 3: Connect to Your Website

---

## 📋 Step 1: Set Up Stripe Account

### 1.1 Create/Login to Stripe
1. Go to [https://dashboard.stripe.com](https://dashboard.stripe.com)
2. Sign up or log in to your account
3. Complete business verification if needed

### 1.2 Get Your API Keys
1. Go to **Developers → API Keys**
2. You'll see two sets of keys:
   - **Test Mode** (for development)
   - **Live Mode** (for production)

3. Copy these keys:
   - **Publishable Key** (starts with `pk_test_` or `pk_live_`)
   - **Secret Key** (starts with `sk_test_` or `sk_live_`)

⚠️ **Important**: Keep your Secret Key private! Never expose it in frontend code.

---

## 📋 Step 2: Configure Stripe Products & Pricing

### 2.1 Create Your Subscription Product
1. Go to **Products → Add Product**
2. Fill in:
   - **Name**: "BlueChip Signals - Premium Access"
   - **Description**: "All trading signals and guides"
3. Click **Add pricing**:
   - **Pricing Model**: Recurring
   - **Price**: (e.g., $99/month)
   - **Billing Period**: Monthly (or your preference)
4. Click **Save product**

### 2.2 Copy Your Price ID
- After creating, you'll see a **Price ID** (starts with `price_`)
- Copy this - you'll need it for checkout

---

## 📋 Step 3: Set Up Customer Portal

### 3.1 Configure Customer Portal Settings
1. Go to **Settings → Billing → Customer Portal**
2. Click **Activate test link** (or configure custom)
3. Configure what customers can do:
   - ✅ Update payment method
   - ✅ View invoices
   - ✅ Cancel subscription
   - ✅ Update billing information
4. Click **Save**

### 3.2 Get Portal Configuration
- Your portal URL will be: `https://billing.stripe.com/p/login/...`
- Or you'll create sessions programmatically (recommended)

---

## 📋 Step 4: Backend Integration (Choose One Option)

You need a backend to securely create Stripe sessions. Choose the option that works best for you:

### Option A: Firebase Cloud Functions (Recommended)
### Option B: Simple Node.js Server
### Option C: Stripe Payment Links (Easiest, No Code)

---

## 🔥 Option A: Firebase Cloud Functions (Recommended)

### Install Firebase Functions
```bash
cd /Users/hamza/Desktop/BlueChipSignals-main
npm install -g firebase-tools
firebase login
firebase init functions
```

### Install Stripe SDK
```bash
cd functions
npm install stripe
```

### Create the Function
Create `functions/index.js`:

```javascript
const functions = require('firebase-functions');
const stripe = require('stripe')(functions.config().stripe.secret_key);
const admin = require('firebase-admin');
admin.initializeApp();

// Create Checkout Session
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
    // Ensure user is authenticated
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    }

    try {
        const session = await stripe.checkout.sessions.create({
            customer_email: context.auth.token.email,
            line_items: [{
                price: 'price_YOUR_PRICE_ID_HERE', // Replace with your Price ID
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: 'https://yourwebsite.com/dashboard.html?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: 'https://yourwebsite.com/dashboard.html',
            metadata: {
                firebaseUID: context.auth.uid
            }
        });

        return { sessionId: session.id, url: session.url };
    } catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});

// Create Customer Portal Session
exports.createPortalSession = functions.https.onCall(async (data, context) => {
    // Ensure user is authenticated
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    }

    try {
        // Get user's Stripe customer ID from Firestore
        const userDoc = await admin.firestore()
            .collection('users')
            .doc(context.auth.uid)
            .get();
        
        const stripeCustomerId = userDoc.data().stripeCustomerId;

        if (!stripeCustomerId) {
            throw new functions.https.HttpsError('not-found', 'No Stripe customer found');
        }

        const session = await stripe.billingPortal.sessions.create({
            customer: stripeCustomerId,
            return_url: 'https://yourwebsite.com/dashboard.html',
        });

        return { url: session.url };
    } catch (error) {
        throw new functions.https.HttpsError('internal', error.message);
    }
});
```

### Set Stripe Secret Key
```bash
firebase functions:config:set stripe.secret_key="sk_test_YOUR_SECRET_KEY"
```

### Deploy Functions
```bash
firebase deploy --only functions
```

---

## 🌐 Option B: Simple Node.js Server

Create `server.js`:

```javascript
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')('sk_test_YOUR_SECRET_KEY');

const app = express();
app.use(cors({ origin: 'http://localhost:8000' }));
app.use(express.json());

// Create checkout session
app.post('/create-checkout-session', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            customer_email: req.body.email,
            line_items: [{
                price: 'price_YOUR_PRICE_ID',
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: 'http://localhost:8000/dashboard.html?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: 'http://localhost:8000/dashboard.html',
        });
        
        res.json({ url: session.url });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Create portal session
app.post('/create-portal-session', async (req, res) => {
    try {
        const session = await stripe.billingPortal.sessions.create({
            customer: req.body.customerId,
            return_url: 'http://localhost:8000/dashboard.html',
        });
        
        res.json({ url: session.url });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.listen(3000, () => console.log('Server running on port 3000'));
```

Install and run:
```bash
npm install express cors stripe
node server.js
```

---

## 🔗 Option C: Stripe Payment Links (Easiest - No Backend Required!)

### For New Subscriptions:
1. Go to **Products → Your Product**
2. Click **Create payment link**
3. Configure:
   - Quantity: 1 (fixed)
   - After payment: Redirect to `https://yourwebsite.com/dashboard.html`
4. Copy the payment link (e.g., `https://buy.stripe.com/...`)

### For Managing Subscriptions:
1. Go to **Settings → Customer Portal**
2. Click **Get shareable link**
3. Copy the portal link

⚠️ **Limitation**: With payment links, you'll need to manually map Stripe customers to Firebase users.

---

## 🔌 Frontend Integration (Dashboard)

### Update dashboard.html

Replace the "Manage Subscription" button code with:

```javascript
// If using Firebase Functions (Option A)
async function manageSubscription() {
    try {
        const functions = firebase.functions();
        const createPortal = functions.httpsCallable('createPortalSession');
        const result = await createPortal();
        window.location.href = result.data.url;
    } catch (error) {
        console.error('Error:', error);
        alert('Unable to access billing portal. Please contact support.');
    }
}

// If using Node.js Server (Option B)
async function manageSubscription() {
    try {
        const userDoc = await getDoc(doc(db, 'users', auth.currentUser.uid));
        const customerId = userDoc.data().stripeCustomerId;
        
        const response = await fetch('http://localhost:3000/create-portal-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customerId })
        });
        
        const data = await response.json();
        window.location.href = data.url;
    } catch (error) {
        console.error('Error:', error);
        alert('Unable to access billing portal. Please contact support.');
    }
}

// If using Payment Links (Option C)
function manageSubscription() {
    window.open('https://billing.stripe.com/p/login/YOUR_PORTAL_LINK', '_blank');
}
```

---

## 💾 Storing Stripe Customer IDs

After a successful subscription, store the Stripe Customer ID in Firestore:

```javascript
// In your webhook handler or after successful checkout
await setDoc(doc(db, 'users', userId), {
    stripeCustomerId: 'cus_...',
    subscriptionStatus: 'active',
    subscriptionId: 'sub_...',
    planName: 'Premium - All Signals'
}, { merge: true });
```

---

## 🎯 Recommended Workflow

1. **User signs up** → Create Firebase account
2. **User subscribes** → Redirect to Stripe Checkout
3. **Stripe checkout completes** → Webhook fires
4. **Webhook handler**:
   - Creates/updates customer in Stripe
   - Stores `stripeCustomerId` in Firebase user document
   - Updates subscription status
5. **User clicks "Manage Subscription"** → Opens Stripe Customer Portal
6. **Customer Portal** → User can update payment, cancel, view invoices

---

## 🧪 Testing

### Test Cards (Stripe Test Mode)
- **Success**: 4242 4242 4242 4242
- **Decline**: 4000 0000 0000 0002
- Use any future expiry date and any 3-digit CVC

### Test Portal Access
1. Create a test subscription
2. Copy the customer ID from Stripe Dashboard
3. Add it to your Firebase user document
4. Click "Manage Subscription" button
5. Should open Stripe Customer Portal

---

## 📊 Monitoring Subscriptions

### Stripe Dashboard
- **Customers** → View all subscribers
- **Subscriptions** → Track active/canceled
- **Payments** → View transaction history

### Firebase Sync
- Use Stripe webhooks to keep Firebase in sync
- Update user subscription status in real-time

---

## 🔐 Security Checklist

✅ Never expose Stripe Secret Key in frontend  
✅ Always validate user authentication before creating sessions  
✅ Use HTTPS in production  
✅ Verify webhook signatures  
✅ Store only necessary customer data  
✅ Set up proper Firebase security rules  

---

## 🚀 Going Live

When ready to accept real payments:

1. **Complete Stripe business verification**
2. **Switch to Live Mode** in Stripe Dashboard
3. **Get Live API keys** (pk_live_ and sk_live_)
4. **Update all API keys** in your code
5. **Test end-to-end** with a real card (then refund)
6. **Enable Customer Portal** for live mode
7. **Set up webhook endpoints** for production URLs

---

## 📞 Support

- Stripe Docs: https://stripe.com/docs
- Stripe Support: https://support.stripe.com
- Firebase Functions: https://firebase.google.com/docs/functions

---

**Last Updated**: January 2025

