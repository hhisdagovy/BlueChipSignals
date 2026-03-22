/**
 * Evaluate member access from member-onboarding `fetch_state` payload
 * (same shape as dashboard member state).
 */
import { parseFunctionsHttpError } from '../src/lib/parse-functions-http-error.js';
import { unwrapMemberPayload } from '../src/lib/member-state-unwrap.js';

export async function fetchMemberState(supabase) {
    const { data: sess } = await supabase.auth.getSession();
    const session = sess?.session;
    if (!session?.access_token) return { session: null, state: null };

    const { data, error } = await supabase.functions.invoke('member-onboarding', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { action: 'fetch_state' }
    });
    if (error) {
        const detail = await parseFunctionsHttpError(error);
        throw new Error(detail || 'Unable to load membership state.');
    }
    return { session, state: unwrapMemberPayload(data), user: session.user };
}

/** Public-site staff (admin.html, RLS staff policies). Uses `bcs_site_staff`, not CRM `profiles`. */
export async function isStaffUser(supabase) {
    const { data: u } = await supabase.auth.getUser();
    const uid = u?.user?.id;
    if (!uid) return false;
    const { data, error } = await supabase
        .from('bcs_site_staff')
        .select('user_id')
        .eq('user_id', uid)
        .maybeSingle();
    if (error || !data?.user_id) return false;
    return true;
}

function setupDone(state) {
    const v = state?.setupCompleted;
    if (v === true || v === 'true' || v === 1 || v === '1') return true;
    const p = state?.profile || {};
    return p.setupCompleted === true || p.setupCompleted === 'true';
}

/**
 * Member access rules from `member-onboarding` state (replaces legacy Firebase profile checks).
 */
export function evaluateMemberStateAccess(state, options = {}) {
    const profile = state?.profile || {};
    const plan = String(state?.plan || '').toLowerCase();
    const entitlementStatus = String(state?.entitlementStatus || '').toLowerCase();
    const allowedTicker = String(state?.allowedTicker || '').toUpperCase();
    const pendingTickerSelection = Boolean(state?.pendingTickerSelection);
    const ent = state?.entitlement;

    const hasEntitlementRow = ent != null && typeof ent === 'object' && Object.keys(ent).length > 0;

    if (!hasEntitlementRow && !plan && !pendingTickerSelection) {
        return {
            status: 'account_issue',
            code: 'account_issue',
            profile: { ...profile, plan, allowedTicker, entitlementStatus },
            message: ''
        };
    }

    if (options.requireSetup && !setupDone(state)) {
        return {
            status: 'setup_incomplete',
            code: 'setup_incomplete',
            profile: { ...profile, plan, allowedTicker, entitlementStatus },
            message: ''
        };
    }

    if (entitlementStatus === 'pending_channel_selection' || pendingTickerSelection) {
        return {
            status: 'pending_channel_selection',
            code: 'pending_channel_selection',
            profile: { ...profile, plan, allowedTicker, entitlementStatus },
            message: ''
        };
    }

    if (entitlementStatus === 'inactive' || entitlementStatus === 'canceled' || entitlementStatus === 'cancelled') {
        return {
            status: 'inactive',
            code: 'inactive',
            profile: { ...profile, plan, allowedTicker, entitlementStatus },
            message: ''
        };
    }

    if (options.planType === 'bundle' && plan !== 'bundle') {
        return {
            status: 'plan_mismatch',
            code: 'plan_mismatch',
            profile: { ...profile, plan, allowedTicker, entitlementStatus },
            message: ''
        };
    }

    if (options.planType === 'ticker') {
        const requested = String(options.ticker || '').trim().toUpperCase();
        if (!requested) {
            return {
                status: 'account_issue',
                code: 'account_issue',
                profile: { ...profile, plan, allowedTicker, entitlementStatus },
                message: ''
            };
        }
        const can =
            plan === 'bundle' || (plan === 'single' && allowedTicker === requested);
        if (!can) {
            return {
                status: 'plan_mismatch',
                code: 'plan_mismatch',
                profile: { ...profile, plan, allowedTicker, entitlementStatus },
                message: ''
            };
        }
    }

    return {
        status: 'ok',
        code: 'ok',
        profile: { ...profile, plan, allowedTicker, entitlementStatus, isAdmin: false },
        message: ''
    };
}
