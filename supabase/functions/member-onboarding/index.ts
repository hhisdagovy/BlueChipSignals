import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeaders, mergeCors } from "../_shared/cors.ts";

const ENTITLEMENT_STATUS = {
  ACTIVE: "active",
  PENDING: "pending_channel_selection",
  FAILED: "provisioning_failed",
};

const SUPPORTED_TICKERS = ["SPY", "TSLA", "META", "AAPL", "NVDA", "AMZN"];
const DEFAULT_BUNDLE_TICKERS = [...SUPPORTED_TICKERS];

function requireEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required env ${name}`);
  }
  return value;
}

function getSupabaseAdmin() {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/** Prefer anon key for getUser(JWT); service-role client can mis-validate user tokens on some setups. */
function createJwtValidationClient(): ReturnType<typeof createClient> {
  const url = requireEnv("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const key = (anonKey && anonKey.trim()) || requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function getTelegramConfig() {
  return {
    SPY: Deno.env.get("TELEGRAM_INVITE_SPY") ?? "",
    TSLA: Deno.env.get("TELEGRAM_INVITE_TSLA") ?? "",
    META: Deno.env.get("TELEGRAM_INVITE_META") ?? "",
    AAPL: Deno.env.get("TELEGRAM_INVITE_AAPL") ?? "",
    NVDA: Deno.env.get("TELEGRAM_INVITE_NVDA") ?? "",
    AMZN: Deno.env.get("TELEGRAM_INVITE_AMZN") ?? "",
  };
}

function normalizeTicker(value: string) {
  const ticker = String(value || "").trim().toUpperCase();
  return SUPPORTED_TICKERS.includes(ticker) ? ticker : "";
}

function normalizeEmail(value: string) {
  return String(value || "").trim().toLowerCase();
}

async function fetchUserFromAdminWithRetries(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
) {
  const waitMs = [0, 150, 400];
  for (let i = 0; i < waitMs.length; i++) {
    if (waitMs[i] > 0) {
      await new Promise((r) => setTimeout(r, waitMs[i]));
    }
    try {
      const { data: adminData, error: adminError } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (!adminError && adminData?.user) {
        return adminData.user;
      }
      console.warn(`member-onboarding: getUserById attempt ${i + 1}`, adminError?.message);
    } catch (err) {
      console.warn(`member-onboarding: getUserById threw attempt ${i + 1}`, err);
    }
  }
  return null;
}

/**
 * Validate JWT, then load user from Auth admin API so user_metadata is always
 * current. auth.getUser(jwt) often reflects stale JWT claims right after
 * admin.updateUserById — which caused dashboard to think setup is incomplete.
 */
async function getValidatedUserWithFreshMetadata(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  token: string,
) {
  const jwtClient = createJwtValidationClient();
  const { data, error } = await jwtClient.auth.getUser(token);
  if (error || !data?.user) {
    throw new Error(error?.message || "Invalid or expired session.");
  }
  const userId = data.user.id;
  const fromAdmin = await fetchUserFromAdminWithRetries(supabaseAdmin, userId);
  if (fromAdmin) {
    return fromAdmin;
  }
  console.warn("member-onboarding: all admin.getUserById attempts failed; using JWT user (metadata may be stale)");
  return data.user;
}

async function loadEntitlementState(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
  email: string,
) {
  const { data: entitlement } = await supabase
    .from("bcs_entitlements")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (entitlement) {
    return entitlement;
  }

  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) {
    const { data: byEmail } = await supabase
      .from("bcs_entitlements")
      .select("*")
      .ilike("email", normalizedEmail)
      .maybeSingle();

    if (!byEmail) {
      return null;
    }

    if (byEmail.user_id == null || String(byEmail.user_id) === String(userId)) {
      return byEmail;
    }

    /* Row belongs to a user_id that no longer exists in Auth (e.g. Firebase UID after migration). Re-link to this session's user. */
    const staleId = String(byEmail.user_id || "").trim();
    const otherStillInAuth = staleId
      ? await fetchUserFromAdminWithRetries(supabase, staleId)
      : null;
    if (otherStillInAuth) {
      return null;
    }

    const now = new Date().toISOString();
    const { error: upErr } = await supabase
      .from("bcs_entitlements")
      .update({
        user_id: userId,
        email: normalizedEmail,
        updated_at: now,
      })
      .eq("id", byEmail.id);
    if (upErr) {
      console.warn("member-onboarding: relink entitlement failed", upErr.message);
      return null;
    }

    const tickers = Array.isArray(byEmail.allowed_tickers) && byEmail.allowed_tickers.length
      ? byEmail.allowed_tickers
      : DEFAULT_BUNDLE_TICKERS;
    const { error: caErr } = await supabase.from("bcs_channel_access").upsert(
      {
        user_id: userId,
        entitlement_status: String(byEmail.entitlement_status || ENTITLEMENT_STATUS.ACTIVE),
        telegram_channels: tickers,
        updated_at: now,
      },
      { onConflict: "user_id" },
    );
    if (caErr) {
      console.warn("member-onboarding: relink channel_access failed", caErr.message);
    }

    return { ...byEmail, user_id: userId, email: normalizedEmail };
  }

  return null;
}

async function loadChannelAccess(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
): Promise<{ telegram_channels: string[] } | null> {
  const { data } = await supabase
    .from("bcs_channel_access")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return data || null;
}

function buildTelegramChannels(allowedTickers: string[]) {
  const config = getTelegramConfig();
  return allowedTickers
    .map((ticker) => ({
      ticker,
      label: `${ticker} Telegram`,
      inviteUrl: config[ticker as keyof typeof config] || "",
    }))
    .filter((channel) => Boolean(channel.inviteUrl));
}

function isTruthySetupCompleted(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function mapProfileFromMetadata(metadata: Record<string, any> = {}) {
  return {
    firstName: String(metadata.first_name ?? metadata.firstName ?? "").trim(),
    lastName: String(metadata.last_name ?? metadata.lastName ?? "").trim(),
    phone: String(metadata.phone ?? "").trim(),
    tradingExperience: String(metadata.trading_experience ?? metadata.tradingExperience ?? "").trim(),
    primaryInterest: String(metadata.primary_interest ?? metadata.primaryInterest ?? "").trim(),
    setupCompleted: isTruthySetupCompleted(metadata.setup_completed),
  };
}

function mergeMetadata(existing: Record<string, any>, updates: Record<string, any>) {
  return {
    ...existing,
    ...updates,
  };
}

async function updateSingleChannelSelection(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  params: {
    userId: string;
    email: string;
    selectedTicker: string;
    entitlement: Record<string, any> | null;
  },
) {
  const ticker = normalizeTicker(params.selectedTicker);
  if (!ticker) {
    throw new Error("A supported ticker is required to unlock single-channel access.");
  }

  const now = new Date().toISOString();
  const allowedTickers = [ticker];

  const entitlementPayload = {
    allowed_ticker: ticker,
    allowed_tickers: allowedTickers,
    entitlement_status: ENTITLEMENT_STATUS.ACTIVE,
    plan: "single",
    plan_key: "single",
    updated_at: now,
  };

  if (params.entitlement?.id) {
    const { error } = await supabase
      .from("bcs_entitlements")
      .update(entitlementPayload)
      .eq("id", params.entitlement.id);
    if (error) {
      throw new Error(error.message || "Unable to update entitlement.");
    }
  } else {
    const insertPayload = {
      user_id: params.userId,
      email: params.email,
      product_key: "single_channel",
      plan: "single",
      plan_key: "single",
      allowed_ticker: ticker,
      allowed_tickers: allowedTickers,
      entitlement_status: ENTITLEMENT_STATUS.ACTIVE,
      updated_at: now,
    };
    const { error } = await supabase.from("bcs_entitlements").upsert(insertPayload, { onConflict: "user_id" });
    if (error) {
      throw new Error(error.message || "Unable to upsert entitlement.");
    }
  }

  const { error: accessError } = await supabase.from("bcs_channel_access").upsert({
    user_id: params.userId,
    entitlement_status: ENTITLEMENT_STATUS.ACTIVE,
    telegram_channels: allowedTickers,
    updated_at: now,
  }, { onConflict: "user_id" });

  if (accessError) {
    throw new Error(accessError.message || "Unable to update channel access.");
  }
}

function buildStateResponse({
  authUser,
  entitlement,
  channelAccess,
}: {
  authUser: any;
  entitlement: Record<string, any> | null;
  channelAccess: Record<string, any> | null;
}) {
  const metadataProfile = mapProfileFromMetadata(authUser.user_metadata || {});
  const entitlementStatus = String(entitlement?.entitlement_status || "").toLowerCase();
  const plan = String(entitlement?.plan || entitlement?.plan_key || "").toLowerCase();
  const allowedTicker = normalizeTicker(entitlement?.allowed_ticker || "");
  let allowedTickers = Array.isArray(entitlement?.allowed_tickers)
    ? entitlement!.allowed_tickers.map((t: string) => normalizeTicker(t)).filter(Boolean)
    : (allowedTicker ? [allowedTicker] : []);

  if (!allowedTickers.length && plan === "bundle") {
    allowedTickers = DEFAULT_BUNDLE_TICKERS;
  }

  const telegramChannels = channelAccess?.telegram_channels?.length
    ? buildTelegramChannels((channelAccess.telegram_channels as string[]).map(normalizeTicker).filter(Boolean))
    : buildTelegramChannels(allowedTickers);

  const pendingTickerSelection = plan === "single" && (entitlementStatus === ENTITLEMENT_STATUS.PENDING || (!allowedTicker && !allowedTickers.length));

  return {
    profile: {
      ...metadataProfile,
      email: authUser.email,
    },
    entitlement: entitlement || null,
    plan,
    allowedTicker,
    allowedTickers,
    entitlementStatus,
    pendingTickerSelection,
    setupCompleted: metadataProfile.setupCompleted,
    telegramChannels,
  };
}

async function handleAction(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  authUser: any,
  body: Record<string, any>,
) {
  const action = String(body?.action || "fetch_state").toLowerCase();
  const entitlement = await loadEntitlementState(supabase, authUser.id, authUser.email || "");
  const channelAccess = entitlement ? await loadChannelAccess(supabase, entitlement.user_id || authUser.id) : null;

  if (action === "complete_setup") {
    const profileInput = body?.profile || {};
    const firstName = String(profileInput.firstName || profileInput.first_name || "").trim();
    const lastName = String(profileInput.lastName || profileInput.last_name || "").trim();
    if (!firstName || !lastName) {
      throw new Error("First and last name are required.");
    }

    const metadata = mergeMetadata(authUser.user_metadata || {}, {
      first_name: firstName,
      last_name: lastName,
      phone: String(profileInput.phone || "").trim(),
      trading_experience: String(profileInput.tradingExperience || "").trim(),
      primary_interest: String(profileInput.primaryInterest || "").trim(),
      setup_completed: true,
      terms_accepted: true,
      terms_accepted_date: new Date().toISOString(),
    });

    const { error: updateError } = await supabase.auth.admin.updateUserById(authUser.id, {
      user_metadata: metadata,
    });
    if (updateError) {
      throw new Error(updateError.message || "Unable to save profile.");
    }

    if (body.selectedTicker && (entitlement?.plan === "single" || entitlement?.plan_key === "single")) {
      await updateSingleChannelSelection(supabase, {
        userId: authUser.id,
        email: authUser.email || "",
        selectedTicker: body.selectedTicker,
        entitlement,
      });
    }

    const refreshedEntitlement = await loadEntitlementState(supabase, authUser.id, authUser.email || "");
    const refreshedAccess = await loadChannelAccess(supabase, authUser.id);

    return buildStateResponse({
      authUser: { ...authUser, user_metadata: metadata },
      entitlement: refreshedEntitlement,
      channelAccess: refreshedAccess,
    });
  }

  return buildStateResponse({ authUser, entitlement, channelAccess });
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

  try {
    const authHeader = request.headers.get("authorization") || "";
    const token = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (!token) {
      return jsonResponse({ error: "Missing Authorization header." }, 401);
    }

    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const supabase = getSupabaseAdmin();
    const authUser = await getValidatedUserWithFreshMetadata(supabase, token);
    const payload = await handleAction(supabase, authUser, body || {});

    return jsonResponse({ data: payload }, 200);
  } catch (error) {
    console.error("member-onboarding error", error);
    const message = error instanceof Error ? error.message : String(error || "Server error");
    return jsonResponse({ error: message }, 400);
  }
});
