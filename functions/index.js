const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const SUPPORTED_TICKERS = ['SPY', 'TSLA', 'META', 'AAPL', 'NVDA', 'AMZN'];
const DEFAULT_BUNDLE_TICKERS = [...SUPPORTED_TICKERS];
const ENTITLEMENT_STATUS = {
  ACTIVE: 'active',
  PENDING_CHANNEL_SELECTION: 'pending_channel_selection',
  PROVISIONING_FAILED: 'provisioning_failed'
};
const PRODUCT_CATALOG = {
  SINGLE_CHANNEL: 'single_channel',
  FULL_BUNDLE: 'full_bundle'
};

function getStripeClient() {
  const stripeSecret = process.env.STRIPE_SECRET_KEY || functions.config().stripe?.secret_key;
  if (!stripeSecret) {
    throw new Error('Missing STRIPE_SECRET_KEY / functions.config().stripe.secret_key');
  }

  // Lazy-load so local editing/tests do not crash when Stripe is not installed yet.
  // eslint-disable-next-line global-require
  const Stripe = require('stripe');
  return new Stripe(stripeSecret, { apiVersion: '2024-06-20' });
}

function getStripeWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET || functions.config().stripe?.webhook_secret || '';
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeTicker(ticker) {
  const normalized = String(ticker || '').trim().toUpperCase();
  return SUPPORTED_TICKERS.includes(normalized) ? normalized : '';
}

function deriveProductKey({ metadata = {}, lineItems = [] }) {
  const metadataProduct = String(metadata.product_key || metadata.productKey || '').trim().toLowerCase();
  if (metadataProduct === PRODUCT_CATALOG.SINGLE_CHANNEL || metadataProduct === PRODUCT_CATALOG.FULL_BUNDLE) {
    return metadataProduct;
  }

  for (const item of lineItems) {
    const price = item?.price || {};
    const productMetadata = price.product?.metadata || {};
    const priceMetadata = price.metadata || {};
    const candidate = String(
      productMetadata.product_key || priceMetadata.product_key || productMetadata.plan || priceMetadata.plan || ''
    ).trim().toLowerCase();

    if (candidate === PRODUCT_CATALOG.SINGLE_CHANNEL || candidate === PRODUCT_CATALOG.FULL_BUNDLE) {
      return candidate;
    }
  }

  return '';
}

function buildEntitlements({ productKey, ticker }) {
  if (productKey === PRODUCT_CATALOG.FULL_BUNDLE) {
    return {
      plan: 'bundle',
      allowedTicker: '',
      tickerSelections: DEFAULT_BUNDLE_TICKERS,
      entitlementStatus: ENTITLEMENT_STATUS.ACTIVE,
      hasPendingTickerSelection: false
    };
  }

  if (productKey === PRODUCT_CATALOG.SINGLE_CHANNEL) {
    const normalizedTicker = normalizeTicker(ticker);
    return {
      plan: 'single',
      allowedTicker: normalizedTicker,
      tickerSelections: normalizedTicker ? [normalizedTicker] : [],
      entitlementStatus: normalizedTicker
        ? ENTITLEMENT_STATUS.ACTIVE
        : ENTITLEMENT_STATUS.PENDING_CHANNEL_SELECTION,
      hasPendingTickerSelection: !normalizedTicker
    };
  }

  throw new Error(`Unsupported product key: ${productKey}`);
}

async function findUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const matchingAuthUser = await admin.auth().getUserByEmail(normalizedEmail).catch(() => null);
  if (matchingAuthUser) {
    const userRef = db.collection('users').doc(matchingAuthUser.uid);
    const userSnap = await userRef.get();
    return {
      uid: matchingAuthUser.uid,
      authUser: matchingAuthUser,
      userRef,
      userSnap
    };
  }

  const querySnap = await db.collection('users').where('email', '==', normalizedEmail).limit(1).get();
  if (querySnap.empty) return null;

  return {
    uid: querySnap.docs[0].id,
    authUser: null,
    userRef: querySnap.docs[0].ref,
    userSnap: querySnap.docs[0]
  };
}

async function ensureUserAccount({ email, customerName = '', source = 'stripe_webhook' }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error('Customer email is required for fulfillment.');
  }

  const existing = await findUserByEmail(normalizedEmail);
  if (existing) return existing;

  const createdAuthUser = await admin.auth().createUser({
    email: normalizedEmail,
    emailVerified: false,
    displayName: String(customerName || '').trim() || undefined
  });

  const userRef = db.collection('users').doc(createdAuthUser.uid);
  const splitName = String(customerName || '').trim().split(/\s+/).filter(Boolean);
  const firstName = splitName[0] || '';
  const lastName = splitName.slice(1).join(' ');
  const timestamp = nowIso();

  await userRef.set({
    email: normalizedEmail,
    firstName,
    lastName,
    displayName: String(customerName || '').trim(),
    role: 'user',
    signInMethod: 'email',
    profileComplete: false,
    setupCompleted: false,
    subscriptionStatus: 'Provisioning',
    entitlementStatus: ENTITLEMENT_STATUS.PROVISIONING_FAILED,
    joinedDate: timestamp,
    accountProvisioningSource: source,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  return {
    uid: createdAuthUser.uid,
    authUser: createdAuthUser,
    userRef,
    userSnap: await userRef.get()
  };
}

async function recordProvisioningEvent({ orderId, eventType, status, payload = {}, userId = '' }) {
  await db.collection('provisioning_events').add({
    orderId: String(orderId || ''),
    userId: String(userId || ''),
    eventType,
    status,
    payload,
    createdAt: FieldValue.serverTimestamp(),
    createdAtIso: nowIso()
  });
}

async function applyFulfillmentForCheckoutSession(session, eventId = '') {
  const stripe = getStripeClient();
  const expandedSession = session.line_items
    ? session
    : await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['line_items.data.price.product', 'customer']
    });

  const lineItems = expandedSession.line_items?.data || [];
  const metadata = expandedSession.metadata || {};
  const productKey = deriveProductKey({ metadata, lineItems });
  if (!productKey) {
    throw new Error('Unable to derive product key from Stripe session metadata/line items.');
  }

  const requestedTicker = normalizeTicker(
    metadata.ticker || metadata.allowed_ticker || metadata.allowedTicker || metadata.single_channel_ticker
  );
  const entitlements = buildEntitlements({ productKey, ticker: requestedTicker });
  const email = expandedSession.customer_details?.email || expandedSession.customer_email || '';
  const customerName = expandedSession.customer_details?.name || expandedSession.customer?.name || '';
  const userRecord = await ensureUserAccount({ email, customerName, source: 'stripe_webhook' });

  const userRef = userRecord.userRef;
  const orderRef = db.collection('orders').doc(expandedSession.id);
  const entitlementRef = db.collection('entitlements').doc(userRecord.uid);
  const accessRef = db.collection('channel_access').doc(userRecord.uid);
  const orderPayload = {
    provider: 'stripe',
    checkoutSessionId: expandedSession.id,
    paymentIntentId: expandedSession.payment_intent || '',
    customerId: expandedSession.customer?.id || expandedSession.customer || '',
    customerEmail: normalizeEmail(email),
    customerName: String(customerName || '').trim(),
    amountTotal: expandedSession.amount_total || 0,
    currency: expandedSession.currency || 'usd',
    paymentStatus: expandedSession.payment_status || '',
    fulfillmentStatus: entitlements.entitlementStatus,
    productKey,
    requestedTicker,
    metadata,
    lineItems: lineItems.map((item) => ({
      quantity: item.quantity || 1,
      priceId: item.price?.id || '',
      productId: item.price?.product?.id || item.price?.product || '',
      description: item.description || '',
      productKey: item.price?.product?.metadata?.product_key || item.price?.metadata?.product_key || ''
    })),
    userId: userRecord.uid,
    stripeEventId: String(eventId || ''),
    updatedAt: FieldValue.serverTimestamp(),
    createdAtIso: nowIso()
  };

  const entitlementPayload = {
    userId: userRecord.uid,
    email: normalizeEmail(email),
    plan: entitlements.plan,
    entitlementStatus: entitlements.entitlementStatus,
    allowedTickers: entitlements.tickerSelections,
    allowedTicker: entitlements.allowedTicker,
    productKey,
    sourceOrderId: expandedSession.id,
    updatedAt: FieldValue.serverTimestamp(),
    updatedAtIso: nowIso()
  };

  const channelAccessPayload = {
    userId: userRecord.uid,
    entitlementStatus: entitlements.entitlementStatus,
    telegramChannels: entitlements.tickerSelections,
    updatedAt: FieldValue.serverTimestamp(),
    updatedAtIso: nowIso()
  };

  const userPayload = {
    email: normalizeEmail(email),
    displayName: String(customerName || '').trim() || (userRecord.userSnap.data()?.displayName || ''),
    plan: entitlements.plan,
    allowedTicker: entitlements.allowedTicker,
    subscriptionStatus: entitlements.entitlementStatus === ENTITLEMENT_STATUS.ACTIVE ? 'Premium Active' : 'Pending channel selection',
    entitlementStatus: entitlements.entitlementStatus,
    entitlementVersion: 1,
    pendingChannelSelection: entitlements.hasPendingTickerSelection,
    setupCompleted: userRecord.userSnap.data()?.setupCompleted === true,
    profileComplete: userRecord.userSnap.data()?.profileComplete === true,
    lastFulfilledOrderId: expandedSession.id,
    lastStripeEventId: String(eventId || ''),
    updatedAt: FieldValue.serverTimestamp()
  };

  await db.runTransaction(async (tx) => {
    tx.set(orderRef, orderPayload, { merge: true });
    tx.set(entitlementRef, entitlementPayload, { merge: true });
    tx.set(accessRef, channelAccessPayload, { merge: true });
    tx.set(userRef, userPayload, { merge: true });
  });

  await recordProvisioningEvent({
    orderId: expandedSession.id,
    eventType: 'checkout.session.completed',
    status: entitlements.entitlementStatus,
    userId: userRecord.uid,
    payload: {
      productKey,
      requestedTicker,
      allowedTickers: entitlements.tickerSelections,
      stripeEventId: String(eventId || '')
    }
  });

  return {
    orderId: expandedSession.id,
    userId: userRecord.uid,
    entitlementStatus: entitlements.entitlementStatus,
    productKey,
    allowedTickers: entitlements.tickerSelections
  };
}

function getTelegramConfig() {
  const configured = functions.config().telegram || {};
  return {
    SPY: process.env.TELEGRAM_INVITE_SPY || configured.spy || '',
    TSLA: process.env.TELEGRAM_INVITE_TSLA || configured.tsla || '',
    META: process.env.TELEGRAM_INVITE_META || configured.meta || '',
    AAPL: process.env.TELEGRAM_INVITE_AAPL || configured.aapl || '',
    NVDA: process.env.TELEGRAM_INVITE_NVDA || configured.nvda || '',
    AMZN: process.env.TELEGRAM_INVITE_AMZN || configured.amzn || ''
  };
}

async function resolveMemberAccess(uid) {
  const [userSnap, entitlementSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('entitlements').doc(uid).get()
  ]);

  if (!userSnap.exists) {
    throw new functions.https.HttpsError('failed-precondition', 'User profile not found.');
  }

  const user = userSnap.data() || {};
  const entitlement = entitlementSnap.exists ? (entitlementSnap.data() || {}) : {};
  const isAdmin = String(user.role || '').toLowerCase() === 'admin';
  const entitlementStatus = String(
    entitlement.entitlementStatus || user.entitlementStatus || ''
  ).trim().toLowerCase();

  const allowedTickers = isAdmin
    ? DEFAULT_BUNDLE_TICKERS
    : Array.from(new Set(
      ((Array.isArray(entitlement.allowedTickers) && entitlement.allowedTickers.length)
        ? entitlement.allowedTickers
        : [user.allowedTicker].filter(Boolean)
      )
        .map(normalizeTicker)
        .filter(Boolean)
    ));

  const telegramConfig = getTelegramConfig();
  const channels = allowedTickers
    .filter((ticker) => Boolean(telegramConfig[ticker]))
    .map((ticker) => ({
      ticker,
      label: `${ticker} Telegram`,
      inviteUrl: telegramConfig[ticker]
    }));

  return {
    isAdmin,
    user,
    entitlement,
    entitlementStatus,
    allowedTickers,
    channels
  };
}

exports.createUserForAdmin = functions.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.token || context.auth.token.role !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', 'Admin only');
  }

  const {
    email,
    password,
    firstName = '',
    lastName = '',
    displayName = '',
    role = 'user',
    plan,
    allowedTicker = '',
    subscriptionStatus = 'Premium Active',
  } = data || {};

  const normalizedEmail = normalizeEmail(email);
  const normalizedFirstName = String(firstName || '').trim();
  const normalizedLastName = String(lastName || '').trim();
  const resolvedDisplayName = String(displayName || '').trim() ||
    [normalizedFirstName, normalizedLastName].filter(Boolean).join(' ');
  const normalizedPlan = String(plan || '').trim().toLowerCase();
  const normalizedTicker = normalizedPlan === 'single'
    ? normalizeTicker(allowedTicker)
    : '';
  const normalizedRole = String(role || 'user').trim().toLowerCase() || 'user';
  const normalizedSubscriptionStatus = String(subscriptionStatus || '').trim() || 'Premium Active';

  if (!normalizedEmail || !password) {
    throw new functions.https.HttpsError('invalid-argument', 'Email and password are required.');
  }

  if (normalizedPlan !== 'single' && normalizedPlan !== 'bundle') {
    throw new functions.https.HttpsError('invalid-argument', 'A valid plan is required.');
  }

  if (normalizedPlan === 'single' && !normalizedTicker) {
    throw new functions.https.HttpsError('invalid-argument', 'Single-channel members require an allowed ticker.');
  }

  const userRecord = await admin.auth().createUser({
    email: normalizedEmail,
    password,
    displayName: resolvedDisplayName,
  });

  if (normalizedRole) {
    await admin.auth().setCustomUserClaims(userRecord.uid, { role: normalizedRole });
  }

  await db.collection('users').doc(userRecord.uid).set({
    email: normalizedEmail,
    firstName: normalizedFirstName,
    lastName: normalizedLastName,
    displayName: resolvedDisplayName,
    plan: normalizedPlan,
    allowedTicker: normalizedTicker,
    subscriptionStatus: normalizedSubscriptionStatus,
    signInMethod: 'email',
    profileComplete: false,
    setupCompleted: false,
    role: normalizedRole,
    joinedDate: nowIso(),
    entitlementStatus: ENTITLEMENT_STATUS.ACTIVE,
    pendingChannelSelection: false,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await db.collection('entitlements').doc(userRecord.uid).set({
    userId: userRecord.uid,
    email: normalizedEmail,
    plan: normalizedPlan,
    allowedTickers: normalizedPlan === 'bundle' ? DEFAULT_BUNDLE_TICKERS : [normalizedTicker],
    allowedTicker: normalizedTicker,
    entitlementStatus: ENTITLEMENT_STATUS.ACTIVE,
    sourceOrderId: 'manual_admin',
    updatedAt: FieldValue.serverTimestamp(),
    updatedAtIso: nowIso(),
  }, { merge: true });

  await db.collection('channel_access').doc(userRecord.uid).set({
    userId: userRecord.uid,
    entitlementStatus: ENTITLEMENT_STATUS.ACTIVE,
    telegramChannels: normalizedPlan === 'bundle' ? DEFAULT_BUNDLE_TICKERS : [normalizedTicker],
    updatedAt: FieldValue.serverTimestamp(),
    updatedAtIso: nowIso(),
  }, { merge: true });

  return { uid: userRecord.uid };
});

exports.stripeCheckoutFulfillment = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  let event;
  try {
    const stripe = getStripeClient();
    const signature = req.headers['stripe-signature'];
    const webhookSecret = getStripeWebhookSecret();

    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.rawBody, signature, webhookSecret);
    } else {
      event = req.body;
    }
  } catch (error) {
    console.error('Stripe webhook verification failed:', error);
    res.status(400).send(`Webhook Error: ${error.message}`);
    return;
  }

  if (!event || !event.type) {
    res.status(400).send('Missing Stripe event payload.');
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await applyFulfillmentForCheckoutSession(event.data.object, event.id);
    }

    res.status(200).json({ received: true, type: event.type });
  } catch (error) {
    console.error('Stripe fulfillment failed:', error);
    const sessionId = event?.data?.object?.id || '';

    if (sessionId) {
      await db.collection('orders').doc(sessionId).set({
        fulfillmentStatus: ENTITLEMENT_STATUS.PROVISIONING_FAILED,
        provisioningError: error.message,
        stripeEventId: String(event.id || ''),
        updatedAt: FieldValue.serverTimestamp(),
        createdAtIso: nowIso()
      }, { merge: true });

      await recordProvisioningEvent({
        orderId: sessionId,
        eventType: event.type,
        status: ENTITLEMENT_STATUS.PROVISIONING_FAILED,
        payload: { error: error.message, stripeEventId: String(event.id || '') }
      });
    }

    res.status(500).json({ received: true, error: error.message });
  }
});

exports.getDashboardAccessState = functions.https.onCall(async (_data, context) => {
  if (!context.auth?.uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
  }

  const access = await resolveMemberAccess(context.auth.uid);
  const user = access.user;
  const status = access.entitlementStatus || (access.channels.length ? ENTITLEMENT_STATUS.ACTIVE : '');

  return {
    entitlementStatus: status,
    pendingChannelSelection: status === ENTITLEMENT_STATUS.PENDING_CHANNEL_SELECTION,
    plan: String(user.plan || '').toLowerCase(),
    allowedTickers: access.allowedTickers,
    telegramChannels: access.channels
  };
});

exports.selectSingleChannelTicker = functions.https.onCall(async (data, context) => {
  if (!context.auth?.uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
  }

  const selectedTicker = normalizeTicker(data?.ticker);
  if (!selectedTicker) {
    throw new functions.https.HttpsError('invalid-argument', 'A supported ticker is required.');
  }

  const uid = context.auth.uid;
  const userRef = db.collection('users').doc(uid);
  const entitlementRef = db.collection('entitlements').doc(uid);
  const [userSnap, entitlementSnap] = await Promise.all([userRef.get(), entitlementRef.get()]);

  if (!userSnap.exists) {
    throw new functions.https.HttpsError('failed-precondition', 'User profile not found.');
  }

  const user = userSnap.data() || {};
  const entitlement = entitlementSnap.exists ? entitlementSnap.data() || {} : {};
  const plan = String(entitlement.plan || user.plan || '').toLowerCase();
  const entitlementStatus = String(entitlement.entitlementStatus || user.entitlementStatus || '').toLowerCase();

  if (plan !== 'single') {
    throw new functions.https.HttpsError('failed-precondition', 'Ticker selection only applies to single-channel members.');
  }

  if (entitlementStatus !== ENTITLEMENT_STATUS.PENDING_CHANNEL_SELECTION) {
    throw new functions.https.HttpsError('failed-precondition', 'Ticker selection is not pending for this account.');
  }

  await db.runTransaction(async (tx) => {
    tx.set(userRef, {
      allowedTicker: selectedTicker,
      subscriptionStatus: 'Premium Active',
      entitlementStatus: ENTITLEMENT_STATUS.ACTIVE,
      pendingChannelSelection: false,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    tx.set(entitlementRef, {
      userId: uid,
      email: normalizeEmail(user.email),
      plan: 'single',
      allowedTicker: selectedTicker,
      allowedTickers: [selectedTicker],
      entitlementStatus: ENTITLEMENT_STATUS.ACTIVE,
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtIso: nowIso()
    }, { merge: true });

    tx.set(db.collection('channel_access').doc(uid), {
      userId: uid,
      entitlementStatus: ENTITLEMENT_STATUS.ACTIVE,
      telegramChannels: [selectedTicker],
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtIso: nowIso()
    }, { merge: true });
  });

  await recordProvisioningEvent({
    orderId: String(user.lastFulfilledOrderId || 'manual_selection'),
    eventType: 'single_channel_ticker_selected',
    status: ENTITLEMENT_STATUS.ACTIVE,
    userId: uid,
    payload: { ticker: selectedTicker }
  });

  return {
    status: ENTITLEMENT_STATUS.ACTIVE,
    ticker: selectedTicker
  };
});
