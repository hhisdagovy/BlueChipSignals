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

async function sendFulfillmentEmail({
  toEmail,
  purchasedPlan,
  allowedTickers,
  pendingChannelSelection,
}: {
  toEmail: string;
  purchasedPlan: string;
  allowedTickers: string[];
  pendingChannelSelection: boolean;
}) {
  const normalizedEmail = normalizeEmail(toEmail);

  if (!normalizedEmail) {
    return;
  }

  const loginUrl = requireEnv("APP_LOGIN_URL");
  const fromEmail = requireEnv("FULFILLMENT_FROM_EMAIL");
  const subject = "Your Blue Chip Signals access";
  const tickerSummary = allowedTickers.length
    ? allowedTickers.join(", ")
    : "Ticker selection still required";
  const nextSteps = pendingChannelSelection
    ? "Reply to support or complete onboarding to choose your single ticker before access activates."
    : "Log in with the same email address you used at checkout to access your member area.";
  const text = [
    "Thanks for your Blue Chip Signals purchase.",
    "",
    `Purchased plan: ${purchasedPlan}`,
    `Allowed ticker(s): ${tickerSummary}`,
    `Login URL: ${loginUrl}`,
    "",
    "Next steps:",
    nextSteps,
    pendingChannelSelection
      ? "Your order is saved as pending_channel_selection until your ticker is chosen."
      : "Your access is active now.",
    "",
    "Stripe will continue sending its separate payment receipt email.",
  ].join("\n");

  const html = [
    "<p>Thanks for your <strong>Blue Chip Signals</strong> purchase.</p>",
    `<p><strong>Purchased plan:</strong> ${purchasedPlan}<br />`,
    `<strong>Allowed ticker(s):</strong> ${tickerSummary}<br />`,
    `<strong>Login URL:</strong> <a href="${loginUrl}">${loginUrl}</a></p>`,
    "<p><strong>Next steps:</strong><br />",
    `${nextSteps}<br />`,
    pendingChannelSelection
      ? "Your order is saved as <code>pending_channel_selection</code> until your ticker is chosen."
      : "Your access is active now.",
    "</p>",
    "<p>Stripe will continue sending its separate payment receipt email.</p>",
  ].join("");

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
        expand: ["line_items.data.price.product", "customer"],
      },
    );

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
    const requestedTicker = normalizeTicker(
      metadata.ticker
      ?? metadata.allowed_ticker
      ?? metadata.allowedTicker
      ?? metadata.single_channel_ticker
      ?? lineItems[0]?.price?.metadata?.ticker
      ?? lineItems[0]?.price?.product?.metadata?.ticker
    )
    const entitlement = mapEntitlements({ productKey, ticker: requestedTicker })
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
      requested_ticker: requestedTicker || null,
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
        requestedTicker,
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

    await sendFulfillmentEmail({
      toEmail: customerEmail,
      purchasedPlan:
        productKey === PRODUCT_KEYS.FULL_BUNDLE
          ? "Full Bundle"
          : "Single Channel",
      allowedTickers: entitlement.allowedTickers,
      pendingChannelSelection: entitlement.pendingChannelSelection,
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
