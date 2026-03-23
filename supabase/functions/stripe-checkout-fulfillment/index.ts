import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import Stripe from "npm:stripe@18.0.0";

import {
  deriveProductKey,
  ENTITLEMENT_STATUS,
  mapEntitlements,
  normalizeEmail,
  normalizeTicker,
  PRODUCT_KEYS,
} from "../_shared/stripe.ts";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type, stripe-signature",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

function requireEnv(name: string) {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getSupabaseAdminClient() {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}

function getStripeClient() {
  return new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
    apiVersion: "2024-06-20",
  });
}

function getOptionalEnv(name: string) {
  return String(Deno.env.get(name) ?? "").trim();
}

interface PricingInfo {
  originalPriceCents: number;
  amountPaidCents: number;
  discountAmountCents: number;
  couponName: string | null;
  hasDiscount: boolean;
}

function formatCents(cents: number): string {
  const dollars = Math.round(cents) / 100;
  return "$" + dollars.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function extractPricingInfo(session: Stripe.Checkout.Session): PricingInfo {
  const amountPaidCents = session.amount_total ?? 0;
  const discountAmountCents = session.total_details?.amount_discount ?? 0;
  const originalPriceCents = amountPaidCents + discountAmountCents;
  const discounts = session.discounts ?? [];
  let couponName: string | null = null;
  const first = discounts[0];
  if (first && typeof first === "object" && "coupon" in first) {
    const c = (first as { coupon?: unknown }).coupon;
    if (typeof c === "object" && c !== null && "name" in c) {
      const n = String((c as { name?: string }).name ?? "").trim();
      couponName = n || null;
    }
  }
  return {
    originalPriceCents,
    amountPaidCents,
    discountAmountCents,
    couponName,
    hasDiscount: discountAmountCents > 0,
  };
}

function deriveProductKeyFromPriceId(lineItems: Array<Record<string, any>>) {
  const singleChannelPriceId = getOptionalEnv("STRIPE_PRICE_SINGLE_CHANNEL");
  const fullBundlePriceId = getOptionalEnv("STRIPE_PRICE_FULL_BUNDLE");

  for (const item of lineItems) {
    const priceId = String(item?.price?.id ?? "").trim();

    if (!priceId) {
      continue;
    }

    if (singleChannelPriceId && priceId === singleChannelPriceId) {
      return PRODUCT_KEYS.SINGLE_CHANNEL;
    }

    if (fullBundlePriceId && priceId === fullBundlePriceId) {
      return PRODUCT_KEYS.FULL_BUNDLE;
    }
  }

  return "";
}

async function markProvisioningFailed({
  supabase,
  stripeEventId,
  session,
  userId,
  customerEmail,
  customerName,
  eventType,
  metadata,
  lineItems,
  errorCode,
  now,
}: {
  supabase: ReturnType<typeof getSupabaseAdminClient>;
  stripeEventId: string;
  session: Stripe.Checkout.Session;
  userId: string | null;
  customerEmail: string;
  customerName: string;
  eventType: string;
  metadata: Record<string, unknown>;
  lineItems: Array<Record<string, any>>;
  errorCode: string;
  now: string;
}) {
  const failureMetadata = {
    ...metadata,
    raw_session_metadata: session.metadata ?? {},
    line_item_prices: lineItems.map((item) => ({
      id: item?.price?.id ?? null,
      metadata: item?.price?.metadata ?? {},
      product_metadata: item?.price?.product?.metadata ?? {},
    })),
  };

  const { error: orderError } = await supabase.from("bcs_orders").upsert(
    {
      checkout_session_id: session.id,
      stripe_event_id: stripeEventId,
      payment_intent_id:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent?.id ?? null),
      stripe_customer_id:
        typeof session.customer === "string"
          ? session.customer
          : (session.customer?.id ?? null),
      user_id: userId,
      email: customerEmail || null,
      customer_name: customerName || null,
      fulfillment_status: ENTITLEMENT_STATUS.PROVISIONING_FAILED,
      provisioning_error: errorCode,
      stripe_metadata: failureMetadata,
      updated_at: now,
    },
    { onConflict: "checkout_session_id" },
  );

  if (orderError) {
    throw new Error(
      orderError.message || "Unable to upsert failed bcs_orders state.",
    );
  }

  const { error: provisioningError } = await supabase
    .from("bcs_provisioning_events")
    .insert({
      stripe_event_id: stripeEventId,
      checkout_session_id: session.id,
      user_id: userId,
      email: customerEmail || null,
      event_type: eventType,
      status: ENTITLEMENT_STATUS.PROVISIONING_FAILED,
      payload: {
        errorCode,
        customerName,
        rawMetadata: metadata,
        lineItemPriceIds: lineItems
          .map((item) => String(item?.price?.id ?? "").trim())
          .filter(Boolean),
      },
      processed_at: now,
    });

  if (provisioningError) {
    throw new Error(
      provisioningError.message ||
        "Unable to insert failed bcs_provisioning_events state.",
    );
  }
}

function deriveProductKeyWithFallback({
  metadata,
  lineItems
}: {
  metadata: Record<string, unknown>
  lineItems: Array<Record<string, any>>
}) {
  const fromMetadata = deriveProductKey({ metadata, lineItems })

  if (fromMetadata) {
    return { productKey: fromMetadata, source: 'metadata' }
  }

  const singlePriceId = String(Deno.env.get('STRIPE_PRICE_SINGLE_CHANNEL') ?? '').trim()
  const bundlePriceId = String(Deno.env.get('STRIPE_PRICE_FULL_BUNDLE') ?? '').trim()
  const sessionPriceIds = lineItems
    .map((item) => String(item?.price?.id ?? '').trim())
    .filter(Boolean)

  if (singlePriceId && sessionPriceIds.includes(singlePriceId)) {
    return { productKey: PRODUCT_KEYS.SINGLE_CHANNEL, source: 'price_id_fallback' }
  }

  if (bundlePriceId && sessionPriceIds.includes(bundlePriceId)) {
    return { productKey: PRODUCT_KEYS.FULL_BUNDLE, source: 'price_id_fallback' }
  }

  return { productKey: '', source: 'unknown' }
}

async function findAuthUserIdByEmail(supabase: ReturnType<typeof getSupabaseAdminClient>, email: string) {
  const normalizedEmail = normalizeEmail(email)

  if (!normalizedEmail) {
    return null;
  }

  let page = 1;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 200,
    });

    if (error) {
      throw new Error(error.message || "Unable to search auth users by email.");
    }

    const users = data?.users ?? [];
    const match = users.find(
      (user) => normalizeEmail(user.email) === normalizedEmail,
    );

    if (match?.id) {
      return match.id;
    }

    if (users.length < 200) {
      return null;
    }

    page += 1;
  }
}

async function ensureAuthUserForPurchase({
  supabase,
  email,
  customerName,
}: {
  supabase: ReturnType<typeof getSupabaseAdminClient>;
  email: string;
  customerName: string;
}) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw new Error("Customer email is required to create a member account.");
  }

  const existingUserId = await findAuthUserIdByEmail(supabase, normalizedEmail);

  if (existingUserId) {
    return existingUserId;
  }

  const fallbackPassword = crypto.randomUUID();
  const { data, error } = await supabase.auth.admin.createUser({
    email: normalizedEmail,
    email_confirm: true,
    password: fallbackPassword,
    user_metadata: {
      source: "stripe_checkout",
      full_name: String(customerName || "").trim() || null,
    },
  });

  if (error) {
    const message = String(error.message || "").toLowerCase();

    if (
      message.includes("already") ||
      message.includes("exists") ||
      message.includes("registered")
    ) {
      const retryUserId = await findAuthUserIdByEmail(supabase, normalizedEmail);

      if (retryUserId) {
        return retryUserId;
      }
    }

    throw new Error(error.message || "Unable to create Supabase auth user.");
  }

  if (!data?.user?.id) {
    throw new Error("Supabase auth user creation returned no user id.");
  }

  return data.user.id;
}

async function generateSetPasswordLink({
  supabase,
  email,
}: {
  supabase: ReturnType<typeof getSupabaseAdminClient>;
  email: string;
}) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return '';
  }

  const redirectTo = getOptionalEnv('APP_SET_PASSWORD_REDIRECT_URL') || requireEnv('APP_LOGIN_URL');

  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'recovery',
    email: normalizedEmail,
    options: { redirectTo },
  });

  if (error) {
    throw new Error(error.message || 'Unable to generate set-password link.');
  }

  return String(data?.properties?.action_link || '').trim();
}

function buildFulfillmentEmailHtml({
  purchasedPlan,
  allowedTickers,
  pendingChannelSelection,
  setPasswordLink,
  loginUrl,
  pricingInfo,
}: {
  purchasedPlan: string;
  allowedTickers: string[];
  pendingChannelSelection: boolean;
  setPasswordLink: string;
  loginUrl: string;
  pricingInfo: PricingInfo;
}): string {
  const isBundle = purchasedPlan.toLowerCase().includes("bundle");
  const planDisplayName = isBundle ? "Full Bundle" : "Single Channel";
  const tickerHtml = allowedTickers.length
    ? allowedTickers.map((t) =>
      `<span style="display:inline-block;padding:2px 10px;margin:2px;border:1px solid #b3a17d;color:#E2CFB5;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:1px;">${t}</span>`
    ).join(" ")
    : '<span style="color:#b3a17d;font-style:italic;">Pending selection</span>';

  const priceCellHtml = pricingInfo.hasDiscount
    ? `<s style="color:#A0A0A0;font-size:13px;text-decoration:line-through;">${formatCents(pricingInfo.originalPriceCents)}</s> &nbsp;<strong>${formatCents(pricingInfo.amountPaidCents)}</strong>`
    : `<strong>${formatCents(pricingInfo.amountPaidCents)}</strong>`;

  const discountBlockHtml = pricingInfo.hasDiscount
    ? `<tr><td colspan="2" style="border-bottom:1px solid #1a1f2e;font-size:1px;line-height:1px;">&nbsp;</td></tr>
<tr>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#A0A0A0;padding:8px 0;vertical-align:top;width:90px;">Discount</td>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#4ade80;padding:8px 0;text-align:right;vertical-align:top;font-weight:600;">${pricingInfo.couponName ? pricingInfo.couponName + ": " : ""}-${formatCents(pricingInfo.discountAmountCents)}</td>
</tr>`
    : "";

  const passwordCta = setPasswordLink
    ? `<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${setPasswordLink}" style="height:36px;v-text-anchor:middle;width:180px;" arcsize="10%" fillcolor="#b3a17d" stroke="f">
<center style="color:#080B0F;font-family:sans-serif;font-size:13px;font-weight:bold;letter-spacing:0.5px;">Set Your Password</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!--><a href="${setPasswordLink}" style="background-color:#b3a17d;color:#080B0F;display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.5px;line-height:36px;text-align:center;text-decoration:none;width:180px;border-radius:4px;mso-hide:all;">Set Your Password</a><!--<![endif]-->`
    : '<span style="color:#A0A0A0;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">Use the <strong style="color:#FFFFFF;">Forgot Password</strong> link on the login page to set your password.</span>';

  const loginCta = `<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${loginUrl}" style="height:36px;v-text-anchor:middle;width:180px;" arcsize="10%" fillcolor="none" strokecolor="#b3a17d" strokeweight="1px">
<center style="color:#b3a17d;font-family:sans-serif;font-size:13px;font-weight:bold;letter-spacing:0.5px;">Log In to Dashboard</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!--><a href="${loginUrl}" style="background-color:transparent;border:1px solid #b3a17d;color:#b3a17d;display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.5px;line-height:34px;text-align:center;text-decoration:none;width:180px;border-radius:4px;mso-hide:all;">Log In to Dashboard</a><!--<![endif]-->`;

  const step3Text = pendingChannelSelection
    ? "Select your ticker first from the member dashboard, then your Telegram channel access will be activated."
    : "Access your Telegram signal channels directly from the member dashboard.";

  const pendingNotice = pendingChannelSelection
    ? `<tr><td style="padding:16px 24px 0 24px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border:1px solid #b3a17d;padding:12px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#E2CFB5;line-height:1.5;">
Your ticker selection is pending &mdash; log in to your dashboard to choose your channel and activate access.
</td></tr></table>
</td></tr>`
    : "";

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<meta name="format-detection" content="telephone=no" />
<title>Welcome to Blue Chip Signals</title>
<!--[if gte mso 9]>
<xml>
<o:OfficeDocumentSettings>
<o:AllowPNG/>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
<![endif]-->
<!--[if !mso]><!-->
<style>
:root{color-scheme:light dark;}
@media (prefers-color-scheme:dark){.email-body{background-color:#050810 !important;}}
</style>
<!--<![endif]-->
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#050810;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#050810;">
<tr><td align="center" style="padding:0;">

<!--[if (gte mso 9)|(IE)]>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td>
<![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">

<!-- HEADER -->
<tr><td style="background-color:#080B0F;padding:28px 0;text-align:center;border-bottom:1px solid #b3a17d;">
<img src="https://bluechipsignals.online/assets/images/logo.png" alt="Blue Chip Signals" width="140" style="display:block;margin:0 auto;width:140px;height:auto;border:0;" />
</td></tr>

<!-- HERO -->
<tr><td style="background-color:#080B0F;padding:32px 24px 24px 24px;text-align:center;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td style="width:40px;height:2px;background-color:#b3a17d;font-size:1px;line-height:1px;">&nbsp;</td></tr></table>
<h1 style="margin:16px 0 6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:24px;font-weight:600;color:#FFFFFF;letter-spacing:1px;line-height:1.3;mso-line-height-rule:exactly;">Welcome to Blue Chip Signals</h1>
<p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#A0A0A0;line-height:1.5;">Your membership is confirmed.</p>
</td></tr>

<!-- ORDER SUMMARY CARD -->
<tr><td style="background-color:#080B0F;padding:0 24px 24px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0d1117;border:1px solid #1a1f2e;">

<tr><td style="padding:24px 24px 12px 24px;">
<p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;color:#b3a17d;letter-spacing:2px;text-transform:uppercase;">Order Summary</p>
</td></tr>
<tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:1px;background-color:#b3a17d;font-size:1px;line-height:1px;opacity:0.4;">&nbsp;</td></tr></table></td></tr>

<tr><td style="padding:16px 24px 0 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#A0A0A0;padding:8px 0;vertical-align:top;width:90px;">Plan</td>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#FFFFFF;padding:8px 0;text-align:right;vertical-align:top;">${planDisplayName}</td>
</tr>
<tr><td colspan="2" style="border-bottom:1px solid #1a1f2e;font-size:1px;line-height:1px;">&nbsp;</td></tr>
<tr>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#A0A0A0;padding:8px 0;vertical-align:top;width:90px;">Access</td>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#FFFFFF;padding:8px 0;text-align:right;vertical-align:top;"><strong>Lifetime Access</strong> <span style="color:#A0A0A0;font-size:12px;">&mdash; no monthly or annual fees</span></td>
</tr>
<tr><td colspan="2" style="border-bottom:1px solid #1a1f2e;font-size:1px;line-height:1px;">&nbsp;</td></tr>
<tr>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#A0A0A0;padding:8px 0;vertical-align:top;width:90px;">Price</td>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#FFFFFF;padding:8px 0;text-align:right;vertical-align:top;">${priceCellHtml}</td>
</tr>
${discountBlockHtml}
<tr><td colspan="2" style="border-bottom:1px solid #1a1f2e;font-size:1px;line-height:1px;">&nbsp;</td></tr>
<tr>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#A0A0A0;padding:8px 0;vertical-align:top;width:90px;">Total Paid</td>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:17px;color:#FFFFFF;padding:8px 0;text-align:right;vertical-align:top;font-weight:700;">${formatCents(pricingInfo.amountPaidCents)}</td>
</tr>
<tr><td colspan="2" style="font-size:1px;line-height:1px;">&nbsp;</td></tr>
<tr>
<td colspan="2" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#A0A0A0;padding:4px 0 0 0;text-align:center;line-height:1.5;">Less than half the cost of a $10,000/yr annual membership</td>
</tr>
<tr><td colspan="2" style="border-bottom:1px solid #1a1f2e;font-size:1px;line-height:1px;padding-top:12px;">&nbsp;</td></tr>
<tr>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#A0A0A0;padding:8px 0;vertical-align:top;width:90px;">Tickers</td>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#FFFFFF;padding:8px 0;text-align:right;vertical-align:top;">${tickerHtml}</td>
</tr>
</table>
</td></tr>
${pendingNotice}
<tr><td style="padding:12px;">&nbsp;</td></tr>

</table>
</td></tr>

<!-- GETTING STARTED -->
<tr><td style="background-color:#080B0F;padding:8px 24px 32px 24px;">
<p style="margin:0 0 24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;color:#b3a17d;letter-spacing:2px;text-transform:uppercase;text-align:center;">Getting Started</p>

<!-- Step 1 -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
<tr>
<td style="width:36px;vertical-align:top;padding-top:2px;">
<span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#b3a17d;">1.</span>
</td>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<p style="margin:0 0 12px 0;font-size:16px;font-weight:600;color:#FFFFFF;line-height:1.4;">Set Your Password</p>
${passwordCta}
</td>
</tr>
</table>

<!-- Step 2 -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
<tr>
<td style="width:36px;vertical-align:top;padding-top:2px;">
<span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#b3a17d;">2.</span>
</td>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<p style="margin:0 0 12px 0;font-size:16px;font-weight:600;color:#FFFFFF;line-height:1.4;">Log In to Your Dashboard</p>
${loginCta}
</td>
</tr>
</table>

<!-- Step 3 -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="width:36px;vertical-align:top;padding-top:2px;">
<span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#b3a17d;">3.</span>
</td>
<td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<p style="margin:0 0 4px 0;font-size:16px;font-weight:600;color:#FFFFFF;line-height:1.4;">Join Your Telegram Channels</p>
<p style="margin:0;font-size:14px;color:#A0A0A0;line-height:1.5;">${step3Text}</p>
</td>
</tr>
</table>

</td></tr>

<!-- WHAT TO EXPECT CARD -->
<tr><td style="background-color:#080B0F;padding:0 24px 24px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0d1117;border:1px solid #1a1f2e;">
<tr><td style="padding:24px 24px 12px 24px;">
<p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;color:#b3a17d;letter-spacing:2px;text-transform:uppercase;">Your First Week</p>
</td></tr>
<tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:1px;background-color:#b3a17d;font-size:1px;line-height:1px;opacity:0.4;">&nbsp;</td></tr></table></td></tr>
<tr><td style="padding:16px 24px 24px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#A0A0A0;line-height:1.8;">
<span style="color:#b3a17d;">&#x2022;</span>&nbsp; 2&#x2013;4 algorithmic signals delivered daily via Telegram<br />
<span style="color:#b3a17d;">&#x2022;</span>&nbsp; Each signal includes entry price, stop loss, and take profit levels<br />
<span style="color:#b3a17d;">&#x2022;</span>&nbsp; Signals are generated during market hours (9:30 AM &#x2013; 4:00 PM ET)<br />
<span style="color:#b3a17d;">&#x2022;</span>&nbsp; Real-time alerts so you never miss a move
</td></tr>
</table>
</td></tr>

<!-- SUPPORT -->
<tr><td style="background-color:#080B0F;padding:8px 24px 32px 24px;text-align:center;">
<p style="margin:0 0 4px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;color:#FFFFFF;font-weight:600;">Need Help?</p>
<p style="margin:0 0 12px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#A0A0A0;">Our team is here for you.</p>
<a href="mailto:support@bluechipsignals.online" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#b3a17d;text-decoration:none;">support@bluechipsignals.online</a>
</td></tr>

<!-- FOOTER -->
<tr><td style="background-color:#050810;border-top:1px solid #b3a17d;padding:20px 24px;text-align:center;">
<p style="margin:0 0 4px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#A0A0A0;">Blue Chip Signals</p>
<a href="https://bluechipsignals.online" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#b3a17d;text-decoration:none;">bluechipsignals.online</a>
<p style="margin:16px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#666;line-height:1.5;">This email confirms your purchase. Trading involves risk.<br />Past performance does not guarantee future results.</p>
<p style="margin:12px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#666;line-height:1.5;">Stripe will continue sending its separate payment receipt email.</p>
<p style="margin:8px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#666;">&copy; 2026 Blue Chip Signals. All rights reserved.</p>
</td></tr>

</table>
<!--[if (gte mso 9)|(IE)]>
</td></tr></table>
<![endif]-->

</td></tr>
</table>
</body>
</html>`;
}

function buildFulfillmentEmailText({
  purchasedPlan,
  allowedTickers,
  pendingChannelSelection,
  setPasswordLink,
  loginUrl,
  pricingInfo,
}: {
  purchasedPlan: string;
  allowedTickers: string[];
  pendingChannelSelection: boolean;
  setPasswordLink: string;
  loginUrl: string;
  pricingInfo: PricingInfo;
}): string {
  const isBundle = purchasedPlan.toLowerCase().includes("bundle");
  const planDisplayName = isBundle ? "Full Bundle" : "Single Channel";
  const tickerSummary = allowedTickers.length
    ? allowedTickers.join(" | ")
    : "Pending selection";
  const passwordLine = setPasswordLink
    ? `   Set password: ${setPasswordLink}`
    : "   Use the Forgot Password link on the login page.";
  const step3Text = pendingChannelSelection
    ? "   Select your ticker first, then your channel access will be activated."
    : "   Access your signal channels from the member dashboard.";
  const statusLine = pendingChannelSelection
    ? "\nNote: Your ticker selection is pending. Log in to choose your channel."
    : "";

  const orderSummaryLines: string[] = [
    `Plan: ${planDisplayName}`,
    "Access: Lifetime Access — no monthly or annual fees",
  ];
  if (pricingInfo.hasDiscount) {
    orderSummaryLines.push(
      `Original Price: ${formatCents(pricingInfo.originalPriceCents)}`,
      `Discount${pricingInfo.couponName ? ` (${pricingInfo.couponName})` : ""}: -${formatCents(pricingInfo.discountAmountCents)}`,
    );
  }
  orderSummaryLines.push(
    `Amount Paid: ${formatCents(pricingInfo.amountPaidCents)}`,
    "",
    "Less than half the cost of a $10,000/yr annual membership.",
    "",
    `Tickers: ${tickerSummary}`,
  );

  return [
    "═══════════════════════════════════════",
    "  BLUE CHIP SIGNALS",
    "  Purchase Confirmation",
    "═══════════════════════════════════════",
    "",
    "Welcome to Blue Chip Signals.",
    "Your membership is confirmed.",
    "",
    "ORDER SUMMARY",
    "─────────────",
    ...orderSummaryLines,
    statusLine,
    "",
    "GETTING STARTED",
    "─────────────",
    "1. Set Your Password",
    passwordLine,
    "",
    "2. Log In to Your Dashboard",
    `   ${loginUrl}`,
    "",
    "3. Join Your Telegram Channels",
    step3Text,
    "",
    "WHAT TO EXPECT THIS WEEK",
    "─────────────",
    "- 2-4 algorithmic signals delivered daily via Telegram",
    "- Each signal includes entry price, stop loss, and take profit levels",
    "- Signals during market hours (9:30 AM - 4:00 PM ET)",
    "- Real-time alerts so you never miss a move",
    "",
    "NEED HELP?",
    "─────────────",
    "Email: support@bluechipsignals.online",
    "We typically respond within a few hours on market days.",
    "",
    "─────────────",
    "Blue Chip Signals | bluechipsignals.online",
    "Trading involves risk. Past performance does not guarantee future results.",
    "Stripe will continue sending its separate payment receipt email.",
    "(c) 2026 Blue Chip Signals. All rights reserved.",
  ].join("\n");
}

async function sendFulfillmentEmail({
  toEmail,
  purchasedPlan,
  allowedTickers,
  pendingChannelSelection,
  setPasswordLink,
  pricingInfo,
}: {
  toEmail: string;
  purchasedPlan: string;
  allowedTickers: string[];
  pendingChannelSelection: boolean;
  setPasswordLink: string;
  pricingInfo: PricingInfo;
}) {
  const normalizedEmail = normalizeEmail(toEmail);

  if (!normalizedEmail) {
    return;
  }

  const loginUrl = requireEnv("APP_LOGIN_URL");
  const fromEmail = requireEnv("FULFILLMENT_FROM_EMAIL");
  const subject = "Welcome to Blue Chip Signals";

  const text = buildFulfillmentEmailText({
    purchasedPlan,
    allowedTickers,
    pendingChannelSelection,
    setPasswordLink,
    loginUrl,
    pricingInfo,
  });

  const html = buildFulfillmentEmailHtml({
    purchasedPlan,
    allowedTickers,
    pendingChannelSelection,
    setPasswordLink,
    loginUrl,
    pricingInfo,
  });

  const postmarkToken = Deno.env.get("POSTMARK_SERVER_TOKEN");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");

  if (postmarkToken) {
    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": postmarkToken,
      },
      body: JSON.stringify({
        From: fromEmail,
        To: normalizedEmail,
        Subject: subject,
        TextBody: text,
        HtmlBody: html,
      }),
    });

    if (!response.ok) {
      throw new Error(`Postmark send failed with ${response.status}.`);
    }

    return;
  }

  if (resendApiKey) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [normalizedEmail],
        subject,
        text,
        html,
      }),
    });

    if (!response.ok) {
      throw new Error(`Resend send failed with ${response.status}.`);
    }

    return;
  }

  throw new Error(
    "Missing POSTMARK_SERVER_TOKEN or RESEND_API_KEY for fulfillment email delivery.",
  );
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return jsonResponse({ ok: true });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const rawBody = await request.text();

  try {
    const signature = request.headers.get("stripe-signature") || "";
    const stripe = getStripeClient();
    const event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      requireEnv("STRIPE_WEBHOOK_SECRET"),
    );

    if (event.type !== "checkout.session.completed") {
      return jsonResponse({ received: true, ignored: true, type: event.type });
    }

    const supabase = getSupabaseAdminClient();
    const stripeEventId = String(event.id || "").trim();

    const { data: existingEvent, error: existingEventError } = await supabase
      .from("bcs_provisioning_events")
      .select("id, stripe_event_id")
      .eq("stripe_event_id", stripeEventId)
      .maybeSingle();

    if (existingEventError) {
      throw new Error(
        existingEventError.message ||
          "Unable to check provisioning event idempotency.",
      );
    }

    if (existingEvent) {
      return jsonResponse({ received: true, duplicate: true, stripeEventId });
    }

    const session = await stripe.checkout.sessions.retrieve(
      String(event.data.object.id),
      {
        expand: [
          "line_items.data.price.product",
          "customer",
          "discounts",
          "discounts.coupon",
        ],
      },
    );

    const pricingInfo = extractPricingInfo(session);

    const metadata = session.metadata ?? {}
    const lineItems = session.line_items?.data ?? []
    const { productKey, source: productSource } = deriveProductKeyWithFallback({ metadata, lineItems })

    if (!productKey) {
      const now = new Date().toISOString()
      await supabase.from('bcs_orders').upsert({
        checkout_session_id: session.id,
        stripe_event_id: stripeEventId,
        payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null,
        stripe_customer_id: typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null,
        customer_email: normalizeEmail(session.customer_details?.email ?? session.customer_email ?? ''),
        customer_name: String(session.customer_details?.name ?? session.customer?.name ?? '').trim() || null,
        fulfillment_status: ENTITLEMENT_STATUS.PROVISIONING_FAILED,
        provisioning_error: 'unknown_product_key',
        stripe_metadata: {
          metadata,
          lineItems: lineItems.map((item) => ({
            priceId: item?.price?.id ?? null,
            description: item?.description ?? null
          }))
        },
        updated_at: now
      }, { onConflict: 'checkout_session_id' })

      await supabase.from('bcs_provisioning_events').insert({
        stripe_event_id: stripeEventId,
        checkout_session_id: session.id,
        event_type: event.type,
        status: ENTITLEMENT_STATUS.PROVISIONING_FAILED,
        payload: {
          error: 'unknown_product_key',
          metadata,
          lineItems: lineItems.map((item) => ({
            priceId: item?.price?.id ?? null,
            description: item?.description ?? null
          }))
        }
      })

      return jsonResponse({
        received: true,
        status: 'provisioning_failed_unknown_product',
        stripeEventId
      })
    }

    console.log('stripe-checkout-fulfillment product derived', { stripeEventId, productKey, productSource })

    // Edit the product metadata lookup in _shared/stripe.ts if Stripe price/product metadata changes.
    const requestedTickerFromStripe = normalizeTicker(
      metadata.ticker
      ?? metadata.allowed_ticker
      ?? metadata.allowedTicker
      ?? metadata.single_channel_ticker
      ?? lineItems[0]?.price?.metadata?.ticker
      ?? lineItems[0]?.price?.product?.metadata?.ticker
    )
    // Single-channel: always require ticker on welcome-setup (ignore Stripe metadata).
    // Otherwise a default ticker on the Price/Product activates access before the user chooses.
    const tickerForEntitlement = productKey === PRODUCT_KEYS.SINGLE_CHANNEL
      ? ""
      : requestedTickerFromStripe;
    const entitlement = mapEntitlements({ productKey, ticker: tickerForEntitlement })
    const customerEmail = normalizeEmail(session.customer_details?.email ?? session.customer_email ?? '')
    const customerName = String(session.customer_details?.name ?? session.customer?.name ?? '').trim()
    const userId = await ensureAuthUserForPurchase({
      supabase,
      email: customerEmail,
      customerName,
    })
    const now = new Date().toISOString()

    if (!entitlement.plan || !entitlement.fulfillmentStatus || !productKey) {
      console.warn("stripe-checkout-fulfillment invalid entitlement payload", {
        stripeEventId,
        checkoutSessionId: session.id,
        productKey,
        entitlement,
      });

      await markProvisioningFailed({
        supabase,
        stripeEventId,
        session,
        userId,
        customerEmail,
        customerName,
        eventType: event.type,
        metadata,
        lineItems,
        errorCode: "unknown_product_key",
        now,
      });

      return jsonResponse({
        received: true,
        status: "provisioning_failed_unknown_product",
      });
    }

    const orderRow = {
      checkout_session_id: session.id,
      stripe_event_id: stripeEventId,
      payment_intent_id:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent?.id ?? null),
      stripe_customer_id:
        typeof session.customer === "string"
          ? session.customer
          : (session.customer?.id ?? null),
      user_id: userId,
      email: customerEmail,
      customer_email: customerEmail,
      customer_name: customerName || null,
      product_key: productKey,
      plan_key: entitlement.plan,
      requested_ticker: requestedTickerFromStripe || null,
      allowed_tickers: entitlement.allowedTickers,
      amount_total: session.amount_total ?? 0,
      currency: session.currency ?? "usd",
      payment_status: session.payment_status ?? null,
      fulfillment_status: entitlement.fulfillmentStatus,
      stripe_metadata: metadata,
      updated_at: now,
    };

    const entitlementRow = {
      user_id: userId,
      email: customerEmail,
      product_key: productKey,
      plan_key: entitlement.plan,
      plan: entitlement.plan,
      allowed_ticker: entitlement.allowedTicker || null,
      allowed_tickers: entitlement.allowedTickers,
      fulfillment_status: entitlement.fulfillmentStatus,
      entitlement_status: entitlement.fulfillmentStatus,
      checkout_session_id: session.id,
      updated_at: now,
    };

    const accessRow = {
      user_id: userId,
      entitlement_status: entitlement.fulfillmentStatus,
      telegram_channels: entitlement.allowedTickers,
      updated_at: now
    }

    const { error: orderError } = await supabase
      .from("bcs_orders")
      .upsert(orderRow, { onConflict: "checkout_session_id" });

    if (orderError) {
      throw new Error(orderError.message || "Unable to upsert bcs_orders.");
    }

    const { error: entitlementError } = await supabase
      .from("bcs_entitlements")
      .upsert(entitlementRow, { onConflict: userId ? "user_id" : "email" });

    if (entitlementError) {
      throw new Error(
        entitlementError.message || "Unable to upsert bcs_entitlements.",
      );
    }

    if (userId) {
      const { error: accessError } = await supabase
        .from('bcs_channel_access')
        .upsert(accessRow, { onConflict: 'user_id' })

      if (accessError) {
        throw new Error(accessError.message || 'Unable to upsert bcs_channel_access.')
      }
    }

    const eventRow = {
      stripe_event_id: stripeEventId,
      checkout_session_id: session.id,
      user_id: userId,
      event_type: event.type,
      status: entitlement.fulfillmentStatus,
      payload: {
        customerEmail,
        customerName,
        productKey,
        requestedTickerFromStripe,
        allowedTickers: entitlement.allowedTickers,
        pendingChannelSelection: entitlement.pendingChannelSelection
      }
    }

    const { error: provisioningError } = await supabase
      .from("bcs_provisioning_events")
      .insert(eventRow);

    if (provisioningError) {
      throw new Error(
        provisioningError.message ||
          "Unable to insert bcs_provisioning_events.",
      );
    }

    const setPasswordLink = await generateSetPasswordLink({
      supabase,
      email: customerEmail,
    });

    await sendFulfillmentEmail({
      toEmail: customerEmail,
      purchasedPlan:
        productKey === PRODUCT_KEYS.FULL_BUNDLE
          ? "Full Bundle"
          : "Single Channel",
      allowedTickers: entitlement.allowedTickers,
      pendingChannelSelection: entitlement.pendingChannelSelection,
      setPasswordLink,
      pricingInfo,
    });

    return jsonResponse({
      received: true,
      fulfilled: true,
      stripeEventId,
      fulfillmentStatus: entitlement.fulfillmentStatus,
    });
  } catch (error) {
    const message = String(
      error instanceof Error
        ? error.message
        : error || "Stripe fulfillment failed.",
    );
    console.error("stripe-checkout-fulfillment failed", {
      error: message,
      rawBody,
    });

    try {
      const parsed = JSON.parse(rawBody);
      const sessionId = String(parsed?.data?.object?.id ?? "").trim();
      const eventId = String(parsed?.id ?? "").trim();

      if (sessionId) {
        const supabase = getSupabaseAdminClient();

        await supabase.from("bcs_orders").upsert(
          {
            checkout_session_id: sessionId,
            stripe_event_id: eventId || null,
            fulfillment_status: ENTITLEMENT_STATUS.PROVISIONING_FAILED,
            provisioning_error: message,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "checkout_session_id" },
        );
      }
    } catch {
      // Best-effort failure state only; signature verification errors may not contain JSON.
    }

    return jsonResponse({ received: true, error: message }, 500);
  }
});
