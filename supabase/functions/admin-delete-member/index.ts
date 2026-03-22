import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeaders, mergeCors } from "../_shared/cors.ts";

function requireEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function getSupabaseAdmin() {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function createJwtValidationClient(): ReturnType<typeof createClient> {
  const url = requireEnv("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const key = (anonKey && anonKey.trim()) || requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function assertSiteStaff(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
) {
  const { data, error } = await supabaseAdmin
    .from("bcs_site_staff")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (!error && data?.user_id) return;

  const { data: prof } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  const role = String(prof?.role || "").toLowerCase();
  if (["admin", "staff", "owner", "super_admin", "superadmin"].includes(role)) return;

  throw new Error("Forbidden: admin or site staff only.");
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: mergeCors({ "Content-Type": "application/json" }),
  });
}

/** Best-effort delete by user_id; logs and continues on failure (missing table, FK, etc.). */
async function tryDeleteUserRows(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  table: string,
  userId: string,
) {
  const { error } = await supabaseAdmin.from(table).delete().eq("user_id", userId);
  if (error) {
    console.warn(`admin-delete-member: ${table}:`, error.message);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = request.headers.get("authorization") || "";
    const token = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";
    if (!token) {
      return jsonResponse({ error: "Missing Authorization header." }, 401);
    }

    const body = await request.json().catch(() => ({}));
    const targetUserId = String(body?.userId || body?.user_id || "").trim();
    if (!targetUserId) {
      return jsonResponse({ error: "userId is required." }, 400);
    }

    const supabaseAdmin = getSupabaseAdmin();
    const jwtClient = createJwtValidationClient();
    const { data: userData, error: userErr } = await jwtClient.auth.getUser(token);
    if (userErr || !userData?.user?.id) {
      return jsonResponse({ error: userErr?.message || "Invalid session." }, 401);
    }

    await assertSiteStaff(supabaseAdmin, userData.user.id);

    if (targetUserId === userData.user.id) {
      return jsonResponse({ error: "You cannot delete your own account from the admin panel." }, 400);
    }

    const { data: staffTarget } = await supabaseAdmin
      .from("bcs_site_staff")
      .select("user_id")
      .eq("user_id", targetUserId)
      .maybeSingle();
    if (staffTarget?.user_id) {
      return jsonResponse({
        error: "This user is site staff. Remove them from bcs_site_staff before deleting their account.",
      }, 400);
    }

    await tryDeleteUserRows(supabaseAdmin, "bcs_channel_access", targetUserId);
    await tryDeleteUserRows(supabaseAdmin, "bcs_member_app_state", targetUserId);
    await tryDeleteUserRows(supabaseAdmin, "bcs_entitlements", targetUserId);
    await tryDeleteUserRows(supabaseAdmin, "bcs_orders", targetUserId);
    await tryDeleteUserRows(supabaseAdmin, "bcs_provisioning_events", targetUserId);

    const { error: profileErr } = await supabaseAdmin.from("profiles").delete().eq("id", targetUserId);
    if (profileErr) {
      const msg = profileErr.message || "";
      if (!msg.includes("does not exist") && !msg.includes("schema cache")) {
        console.warn("admin-delete-member: profiles delete:", msg);
      }
    }

    const { error: delAuthErr } = await supabaseAdmin.auth.admin.deleteUser(targetUserId);
    if (delAuthErr) {
      return jsonResponse({
        error: delAuthErr.message || "Unable to delete Supabase Auth user.",
      }, 400);
    }

    return jsonResponse({
      ok: true,
      message: "Member data removed and Supabase Auth user deleted.",
    }, 200);
  } catch (error) {
    console.error("admin-delete-member error", error);
    const message = error instanceof Error ? error.message : String(error || "Server error");
    return jsonResponse({ error: message }, 400);
  }
});
