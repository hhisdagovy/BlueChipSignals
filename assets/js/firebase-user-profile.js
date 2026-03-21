import { db, doc, getDoc, updateDoc } from './firebase-config.js';

export const SUPPORT_EMAIL = 'support@bluechipsignals.online';
export const ACCOUNT_ISSUE_REASON = 'account_issue';
export const ACCOUNT_ISSUE_MESSAGE =
    `We couldn't verify your membership details. Please contact support at ${SUPPORT_EMAIL}.`;

function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function getCanonicalSetupCompleted(userData = {}) {
    if (typeof userData.setupCompleted === 'boolean') {
        return userData.setupCompleted;
    }
    if (typeof userData.profileComplete === 'boolean') {
        return userData.profileComplete;
    }
    return false;
}

export function normalizeUserProfile(userData = {}, options = {}) {
    const source = userData || {};
    const normalizedRole = normalizeText(source.role).toLowerCase();
    const isAdmin = normalizedRole === 'admin';
    const plan = normalizeText(source.plan).toLowerCase();
    const allowedTicker = normalizeText(source.allowedTicker).toUpperCase();
    const subscriptionStatus = normalizeText(source.subscriptionStatus);
    const entitlementStatus = normalizeText(source.entitlementStatus).toLowerCase();
    const pendingChannelSelection = Boolean(source.pendingChannelSelection) || entitlementStatus === 'pending_channel_selection';
    const setupCompleted = getCanonicalSetupCompleted(source);
    const missingFields = [];

    if (!isAdmin && options.requireEntitlements) {
        if (!plan || (plan !== 'single' && plan !== 'bundle')) {
            missingFields.push('plan');
        }
        if (!subscriptionStatus) {
            missingFields.push('subscriptionStatus');
        }
        if (plan === 'single' && !allowedTicker && !pendingChannelSelection) {
            missingFields.push('allowedTicker');
        }
    }

    return {
        ...source,
        normalizedRole,
        isAdmin,
        plan,
        allowedTicker,
        subscriptionStatus,
        entitlementStatus,
        pendingChannelSelection,
        setupCompleted,
        profileComplete: setupCompleted,
        missingFields,
        hasEntitlementIssue: !isAdmin && missingFields.length > 0
    };
}

export function buildAuthStatusUrl(path, reason, extraParams = {}) {
    if (typeof window === 'undefined') {
        return path;
    }

    const url = new URL(path, window.location.href);
    if (reason) {
        url.searchParams.set('reason', reason);
    }

    Object.entries(extraParams).forEach(([key, value]) => {
        if (value == null || value === '') {
            return;
        }
        url.searchParams.set(key, String(value));
    });

    return url.pathname + url.search + url.hash;
}

export function getAccountIssueMessage() {
    return ACCOUNT_ISSUE_MESSAGE;
}

export function getLoginMessageFromReason(reason) {
    return reason === ACCOUNT_ISSUE_REASON ? ACCOUNT_ISSUE_MESSAGE : '';
}

export async function loadUserProfile(uid, options = {}) {
    const userDocRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userDocRef);

    if (!userSnap.exists()) {
        return {
            status: 'missing_profile',
            code: 'missing_profile',
            ref: userDocRef,
            rawData: null,
            profile: null,
            message: ACCOUNT_ISSUE_MESSAGE
        };
    }

    const rawData = userSnap.data() || {};
    const profile = normalizeUserProfile(rawData, options);

    if (profile.hasEntitlementIssue) {
        return {
            status: 'account_issue',
            code: 'account_issue',
            ref: userDocRef,
            rawData,
            profile,
            message: ACCOUNT_ISSUE_MESSAGE
        };
    }

    return {
        status: 'ok',
        code: 'ok',
        ref: userDocRef,
        rawData,
        profile,
        message: ''
    };
}

export function evaluateUserAccess(profile, options = {}) {
    const normalizedProfile = normalizeUserProfile(profile, {
        requireEntitlements: options.requireEntitlements || Boolean(options.planType)
    });

    if (normalizedProfile.hasEntitlementIssue) {
        return {
            status: 'account_issue',
            code: 'account_issue',
            profile: normalizedProfile,
            message: ACCOUNT_ISSUE_MESSAGE
        };
    }

    if (options.requireSetup && !normalizedProfile.setupCompleted) {
        return {
            status: 'setup_incomplete',
            code: 'setup_incomplete',
            profile: normalizedProfile,
            message: ''
        };
    }

    if (!normalizedProfile.isAdmin && normalizedProfile.entitlementStatus === 'pending_channel_selection') {
        return {
            status: 'pending_channel_selection',
            code: 'pending_channel_selection',
            profile: normalizedProfile,
            message: ''
        };
    }

    if (!normalizedProfile.isAdmin && normalizedProfile.subscriptionStatus.toLowerCase() === 'inactive') {
        return {
            status: 'inactive',
            code: 'inactive',
            profile: normalizedProfile,
            message: ''
        };
    }

    if (options.planType === 'bundle' && !normalizedProfile.isAdmin && normalizedProfile.plan !== 'bundle') {
        return {
            status: 'plan_mismatch',
            code: 'plan_mismatch',
            profile: normalizedProfile,
            message: ''
        };
    }

    if (options.planType === 'ticker') {
        const requestedTicker = normalizeText(options.ticker).toUpperCase();

        if (!requestedTicker) {
            return {
                status: 'account_issue',
                code: 'account_issue',
                profile: normalizedProfile,
                message: ACCOUNT_ISSUE_MESSAGE
            };
        }

        const canAccessTicker = normalizedProfile.isAdmin ||
            normalizedProfile.plan === 'bundle' ||
            (normalizedProfile.plan === 'single' && normalizedProfile.allowedTicker === requestedTicker);

        if (!canAccessTicker) {
            return {
                status: 'plan_mismatch',
                code: 'plan_mismatch',
                profile: normalizedProfile,
                message: ''
            };
        }
    }

    return {
        status: 'ok',
        code: 'ok',
        profile: normalizedProfile,
        message: ''
    };
}

export async function loadAndEvaluateUserProfile(uid, options = {}) {
    const profileResult = await loadUserProfile(uid, {
        requireEntitlements: options.requireEntitlements || Boolean(options.planType)
    });

    if (profileResult.status !== 'ok') {
        return profileResult;
    }

    const accessResult = evaluateUserAccess(profileResult.profile, options);

    return {
        ...profileResult,
        ...accessResult,
        profile: accessResult.profile || profileResult.profile,
        message: accessResult.message || profileResult.message || ''
    };
}

export async function updateUserOnboardingProfile(uid, onboardingFields = {}) {
    const profileResult = await loadUserProfile(uid, { requireEntitlements: true });
    if (profileResult.status !== 'ok') {
        return profileResult;
    }

    const timestampIso = new Date().toISOString();
    const updates = {
        ...onboardingFields,
        setupCompleted: true,
        profileComplete: true,
        lastLogin: timestampIso
    };

    if (!profileResult.rawData.joinedDate) {
        updates.joinedDate = timestampIso;
    }

    await updateDoc(profileResult.ref, updates);

    return {
        status: 'ok',
        code: 'ok',
        ref: profileResult.ref,
        rawData: { ...profileResult.rawData, ...updates },
        profile: normalizeUserProfile(
            { ...profileResult.rawData, ...updates },
            { requireEntitlements: true }
        ),
        message: '',
        updates
    };
}
