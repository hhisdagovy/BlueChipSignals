/**
 * member-onboarding returns JSON { data: state }. supabase.functions.invoke may pass
 * that through as-is. Unwrap only until we see a member state object — avoid treating
 * arbitrary `.data` properties as a wrapper.
 */
export function unwrapMemberPayload(payload) {
    let current = payload;
    for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
        if (looksLikeMemberState(current)) {
            return current;
        }
        const inner = current.data;
        if (inner != null && typeof inner === 'object') {
            current = inner;
            continue;
        }
        break;
    }
    return payload && typeof payload === 'object' ? payload : current;
}

function looksLikeMemberState(obj) {
    return (
        Object.prototype.hasOwnProperty.call(obj, 'setupCompleted') ||
        (Object.prototype.hasOwnProperty.call(obj, 'profile') &&
            (Object.prototype.hasOwnProperty.call(obj, 'plan') ||
                Object.prototype.hasOwnProperty.call(obj, 'telegramChannels') ||
                Object.prototype.hasOwnProperty.call(obj, 'entitlementStatus')))
    );
}
