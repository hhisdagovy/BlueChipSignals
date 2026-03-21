/**
 * Firebase Functions - Admin user creation callable
 *
 * Deploy with:
 *   firebase deploy --only functions:createUserForAdmin
 *
 * Requires: firebase-admin, firebase-functions
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Initialize Admin SDK (uses default service account)
admin.initializeApp();

/**
 * Callable function to create a Firebase Auth user and Firestore profile.
 * Only callers with custom claim role === 'admin' are allowed.
 *
 * Expects data:
 * {
 *   email,
 *   password,
 *   firstName?,
 *   lastName?,
 *   displayName?,
 *   role?,
 *   plan,
 *   allowedTicker?,
 *   subscriptionStatus?
 * }
 */
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

  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedFirstName = String(firstName || '').trim();
  const normalizedLastName = String(lastName || '').trim();
  const resolvedDisplayName = String(displayName || '').trim() ||
    [normalizedFirstName, normalizedLastName].filter(Boolean).join(' ');
  const normalizedPlan = String(plan || '').trim().toLowerCase();
  const normalizedTicker = normalizedPlan === 'single'
    ? String(allowedTicker || '').trim().toUpperCase()
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

  // Create auth user
  const userRecord = await admin.auth().createUser({
    email: normalizedEmail,
    password,
    displayName: resolvedDisplayName,
  });

  // Optionally set a custom claim
  if (normalizedRole) {
    await admin.auth().setCustomUserClaims(userRecord.uid, { role: normalizedRole });
  }

  // Create Firestore profile (adjust fields as needed)
  await admin.firestore().collection('users').doc(userRecord.uid).set({
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
    joinedDate: new Date().toISOString(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { uid: userRecord.uid };
});
