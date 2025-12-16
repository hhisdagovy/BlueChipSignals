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
 * Expects data: { email, password, displayName?, role? }
 */
exports.createUserForAdmin = functions.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.token || context.auth.token.role !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', 'Admin only');
  }

  const { email, password, displayName = '', role = 'user' } = data || {};

  if (!email || !password) {
    throw new functions.https.HttpsError('invalid-argument', 'Email and password are required.');
  }

  // Create auth user
  const userRecord = await admin.auth().createUser({ email, password, displayName });

  // Optionally set a custom claim
  if (role) {
    await admin.auth().setCustomUserClaims(userRecord.uid, { role });
  }

  // Create Firestore profile (adjust fields as needed)
  await admin.firestore().collection('users').doc(userRecord.uid).set({
    email,
    displayName,
    signInMethod: 'email',
    profileComplete: false,
    role,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { uid: userRecord.uid };
});


