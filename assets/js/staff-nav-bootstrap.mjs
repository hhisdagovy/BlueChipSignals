/**
 * Sets `bluechip_is_admin` + dispatches `adminConfirmed` for internal nav (ADMIN link).
 * Loaded dynamically from nav-component.js so History / Journal / Planner / Account get the link without visiting dashboard first.
 */
import { getSupabase } from '/src/lib/supabase-browser.js';
import { isStaffUser } from '/assets/js/supabase-member-access.js';

export async function syncStaffAdminNav() {
    try {
        const supabase = await getSupabase();
        const { data: sess } = await supabase.auth.getSession();
        if (!sess?.session) {
            try {
                localStorage.removeItem('bluechip_is_admin');
            } catch (_) {}
            return;
        }
        const staff = await isStaffUser(supabase);
        if (staff) {
            try {
                localStorage.setItem('bluechip_is_admin', '1');
            } catch (_) {}
            window.dispatchEvent(new Event('adminConfirmed'));
        } else {
            try {
                localStorage.removeItem('bluechip_is_admin');
            } catch (_) {}
        }
    } catch (e) {
        console.warn('syncStaffAdminNav:', e?.message || e);
        try {
            localStorage.removeItem('bluechip_is_admin');
        } catch (_) {}
    }
}
