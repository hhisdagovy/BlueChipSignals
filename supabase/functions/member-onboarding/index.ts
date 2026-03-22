import { createClient } from "npm:@supabase/supabase-js@2.57.4";

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

async function getUserFromToken(supabase: ReturnType<typeof getSupabaseAdmin>, token: string) {
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    throw new Error(error?.message || "Invalid or expired session.");
  }
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

  if (email) {
    const { data: byEmail } = await supabase
      .from("bcs_entitlements")
      .select("*")
      .eq("email", email)
      .maybeSingle();

    return byEmail || null;
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

function mapProfileFromMetadata(metadata: Record<string, any> = {}) {
  return {
    firstName: String(metadata.first_name ?? metadata.firstName ?? "").trim(),
    lastName: String(metadata.last_name ?? metadata.lastName ?? "").trim(),
    phone: String(metadata.phone ?? "").trim(),
    tradingExperience: String(metadata.trading_experience ?? metadata.tradingExperience ?? "").trim(),
    primaryInterest: String(metadata.primary_interest ?? metadata.primaryInterest ?? "").trim(),
    setupCompleted: metadata.setup_completed === true,
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

Deno.serve(async (request) => {
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "content-type, authorization",
        },
      });
    }

    const authHeader = request.headers.get("authorization") || "";
    const token = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (!token) {
      return new Response(JSON.stringify({ error: "Missing Authorization header." }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const supabase = getSupabaseAdmin();
    const authUser = await getUserFromToken(supabase, token);
    const payload = await handleAction(supabase, authUser, body || {});

    return new Response(JSON.stringify({ data: payload }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.error("member-onboarding error", error);
    return new Response(JSON.stringify({ error: String(error?.message || error || "Server error") }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});
