import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeaders, mergeCors } from "../_shared/cors.ts";

const SUPPORTED_TICKERS = ["SPY", "TSLA", "META", "AAPL", "NVDA", "AMZN"];
const DEFAULT_BUNDLE_TICKERS = [...SUPPORTED_TICKERS];

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

function normalizeEmail(value: string) {
  return String(value || "").trim().toLowerCase();
}

function normalizeTicker(value: string) {
  const ticker = String(value || "").trim().toUpperCase();
  return SUPPORTED_TICKERS.includes(ticker) ? ticker : "";
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
    const email = normalizeEmail(body?.email || "");
    const password = String(body?.password || "");
    const firstName = String(body?.firstName || body?.first_name || "").trim();
    const lastName = String(body?.lastName || body?.last_name || "").trim();
    const plan = String(body?.plan || "").trim().toLowerCase();
    const ticker = normalizeTicker(body?.ticker || body?.allowedTicker || "");
    const statusLabel = String(body?.subscriptionStatus || body?.status || "Premium Active").trim();

    if (!email || !password || password.length < 6) {
      return jsonResponse({ error: "Valid email and password (min 6 characters) are required." }, 400);
    }
    if (!firstName) {
      return jsonResponse({ error: "First name is required." }, 400);
    }
    if (plan !== "bundle" && plan !== "single") {
      return jsonResponse({ error: "Plan must be bundle or single." }, 400);
    }
    if (plan === "single" && !ticker) {
      return jsonResponse({ error: "Single-channel members require an allowed ticker." }, 400);
    }

    const isActive = statusLabel.toLowerCase().includes("active");
    const entitlementStatus = isActive
      ? (plan === "single" ? "active" : "active")
      : "inactive";
    const fulfillmentStatus = entitlementStatus;

    const supabaseAdmin = getSupabaseAdmin();
    const jwtClient = createJwtValidationClient();
    const { data: userData, error: userErr } = await jwtClient.auth.getUser(token);
    if (userErr || !userData?.user?.id) {
      return jsonResponse({ error: userErr?.message || "Invalid session." }, 401);
    }

    await assertSiteStaff(supabaseAdmin, userData.user.id);

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        first_name: firstName,
        last_name: lastName,
        setup_completed: true,
      },
    });

    if (createErr || !created?.user?.id) {
      const msg = createErr?.message || "Unable to create auth user.";
      return jsonResponse({ error: msg }, 400);
    }

    const userId = created.user.id;
    const now = new Date().toISOString();

    const allowedTickers = plan === "bundle"
      ? DEFAULT_BUNDLE_TICKERS
      : [ticker];

    const entitlementRow = {
      user_id: userId,
      email,
      product_key: "admin_created",
      plan_key: plan,
      plan,
      allowed_ticker: plan === "single" ? ticker : null,
      allowed_tickers: allowedTickers,
      fulfillment_status: fulfillmentStatus,
      entitlement_status: entitlementStatus,
      updated_at: now,
    };

    const { error: entErr } = await supabaseAdmin
      .from("bcs_entitlements")
      .upsert(entitlementRow, { onConflict: "user_id" });

    if (entErr) {
      console.error("admin-create-member entitlement error", entErr);
      return jsonResponse({
        error: entErr.message || "User was created but entitlement row failed. Fix in Dashboard or SQL.",
        userId,
        partial: true,
      }, 500);
    }

    if (isActive) {
      const { error: accessErr } = await supabaseAdmin.from("bcs_channel_access").upsert({
        user_id: userId,
        entitlement_status: entitlementStatus,
        telegram_channels: allowedTickers,
        updated_at: now,
      }, { onConflict: "user_id" });

      if (accessErr) {
        console.error("admin-create-member channel_access error", accessErr);
        return jsonResponse({
          error: accessErr.message || "Entitlement saved but channel access failed.",
          userId,
          partial: true,
        }, 500);
      }
    }

    return jsonResponse({
      ok: true,
      userId,
      email,
      message: "User created in Supabase Auth with entitlements. They can log in immediately.",
    }, 200);
  } catch (error) {
    console.error("admin-create-member error", error);
    const message = error instanceof Error ? error.message : String(error || "Server error");
    return jsonResponse({ error: message }, 400);
  }
});
