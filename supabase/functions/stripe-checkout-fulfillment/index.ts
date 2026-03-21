import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import Stripe from 'npm:stripe@18.0.0'

import {
  deriveProductKey,
  ENTITLEMENT_STATUS,
  mapEntitlements,
  normalizeEmail,
  normalizeTicker,
  PRODUCT_KEYS
} from '../_shared/stripe.ts'

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, stripe-signature',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    }
  })
}

function requireEnv(name: string) {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

function getSupabaseAdminClient() {
  return createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  )
}

function getStripeClient() {
  return new Stripe(requireEnv('STRIPE_SECRET_KEY'), {
    apiVersion: '2024-06-20'
  })
}

async function findAuthUserIdByEmail(supabase: ReturnType<typeof getSupabaseAdminClient>, email: string) {
  const normalizedEmail = normalizeEmail(email)

  if (!normalizedEmail) {
    return null
  }

  let page = 1

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 200
    })

    if (error) {
      throw new Error(error.message || 'Unable to search auth users by email.')
    }

    const users = data?.users ?? []
    const match = users.find((user) => normalizeEmail(user.email) === normalizedEmail)

    if (match?.id) {
      return match.id
    }

    if (users.length < 200) {
      return null
    }

    page += 1
  }
}

async function sendFulfillmentEmail({
  toEmail,
  purchasedPlan,
  allowedTickers,
  pendingChannelSelection
}: {
  toEmail: string
  purchasedPlan: string
  allowedTickers: string[]
  pendingChannelSelection: boolean
}) {
  const normalizedEmail = normalizeEmail(toEmail)

  if (!normalizedEmail) {
    return
  }

  const loginUrl = requireEnv('APP_LOGIN_URL')
  const fromEmail = requireEnv('FULFILLMENT_FROM_EMAIL')
  const subject = 'Your Blue Chip Signals access'
  const tickerSummary = allowedTickers.length ? allowedTickers.join(', ') : 'Ticker selection still required'
  const nextSteps = pendingChannelSelection
    ? 'Reply to support or complete onboarding to choose your single ticker before access activates.'
    : 'Log in with the same email address you used at checkout to access your member area.'
  const text = [
    'Thanks for your Blue Chip Signals purchase.',
    '',
    `Purchased plan: ${purchasedPlan}`,
    `Allowed ticker(s): ${tickerSummary}`,
    `Login URL: ${loginUrl}`,
    '',
    'Next steps:',
    nextSteps,
    pendingChannelSelection
      ? 'Your order is saved as pending_channel_selection until your ticker is chosen.'
      : 'Your access is active now.',
    '',
    'Stripe will continue sending its separate payment receipt email.'
  ].join('\n')

  const html = [
    '<p>Thanks for your <strong>Blue Chip Signals</strong> purchase.</p>',
    `<p><strong>Purchased plan:</strong> ${purchasedPlan}<br />`,
    `<strong>Allowed ticker(s):</strong> ${tickerSummary}<br />`,
    `<strong>Login URL:</strong> <a href="${loginUrl}">${loginUrl}</a></p>`,
    '<p><strong>Next steps:</strong><br />',
    `${nextSteps}<br />`,
    pendingChannelSelection
      ? 'Your order is saved as <code>pending_channel_selection</code> until your ticker is chosen.'
      : 'Your access is active now.',
    '</p>',
    '<p>Stripe will continue sending its separate payment receipt email.</p>'
  ].join('')

  const postmarkToken = Deno.env.get('POSTMARK_SERVER_TOKEN')
  const resendApiKey = Deno.env.get('RESEND_API_KEY')

  if (postmarkToken) {
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': postmarkToken
      },
      body: JSON.stringify({
        From: fromEmail,
        To: normalizedEmail,
        Subject: subject,
        TextBody: text,
        HtmlBody: html
      })
    })

    if (!response.ok) {
      throw new Error(`Postmark send failed with ${response.status}.`)
    }

    return
  }

  if (resendApiKey) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [normalizedEmail],
        subject,
        text,
        html
      })
    })

    if (!response.ok) {
      throw new Error(`Resend send failed with ${response.status}.`)
    }

    return
  }

  throw new Error('Missing POSTMARK_SERVER_TOKEN or RESEND_API_KEY for fulfillment email delivery.')
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return jsonResponse({ ok: true })
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405)
  }

  const rawBody = await request.text()

  try {
    const signature = request.headers.get('stripe-signature') || ''
    const stripe = getStripeClient()
    const event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      requireEnv('STRIPE_WEBHOOK_SECRET')
    )

    if (event.type !== 'checkout.session.completed') {
      return jsonResponse({ received: true, ignored: true, type: event.type })
    }

    const supabase = getSupabaseAdminClient()
    const stripeEventId = String(event.id || '').trim()

    const { data: existingEvent, error: existingEventError } = await supabase
      .from('bcs_provisioning_events')
      .select('id, stripe_event_id')
      .eq('stripe_event_id', stripeEventId)
      .maybeSingle()

    if (existingEventError) {
      throw new Error(existingEventError.message || 'Unable to check provisioning event idempotency.')
    }

    if (existingEvent) {
      return jsonResponse({ received: true, duplicate: true, stripeEventId })
    }

    const session = await stripe.checkout.sessions.retrieve(
      String(event.data.object.id),
      {
        expand: ['line_items.data.price.product', 'customer']
      }
    )

    const metadata = session.metadata ?? {}
    const lineItems = session.line_items?.data ?? []
    const productKey = deriveProductKey({ metadata, lineItems })

    if (!productKey) {
      throw new Error('Unable to derive product key from Stripe session metadata or line items.')
    }

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
    const userId = await findAuthUserIdByEmail(supabase, customerEmail)
    const now = new Date().toISOString()

    if (!customerEmail) {
      throw new Error('Customer email is required for fulfillment.')
    }

    const orderRow = {
      checkout_session_id: session.id,
      stripe_event_id: stripeEventId,
      payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null,
      stripe_customer_id: typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null,
      user_id: userId,
      email: customerEmail,
      customer_name: customerName || null,
      product_key: productKey,
      plan_key: entitlement.plan,
      requested_ticker: requestedTicker || null,
      allowed_tickers: entitlement.allowedTickers,
      amount_total: session.amount_total ?? 0,
      currency: session.currency ?? 'usd',
      payment_status: session.payment_status ?? null,
      fulfillment_status: entitlement.fulfillmentStatus,
      stripe_metadata: metadata,
      updated_at: now
    }

    const entitlementRow = {
      user_id: userId,
      email: customerEmail,
      product_key: productKey,
      plan_key: entitlement.plan,
      allowed_ticker: entitlement.allowedTicker || null,
      allowed_tickers: entitlement.allowedTickers,
      fulfillment_status: entitlement.fulfillmentStatus,
      checkout_session_id: session.id,
      updated_at: now
    }

    const accessRow = {
      user_id: userId,
      email: customerEmail,
      product_key: productKey,
      allowed_tickers: entitlement.allowedTickers,
      fulfillment_status: entitlement.fulfillmentStatus,
      updated_at: now
    }

    const { error: orderError } = await supabase
      .from('bcs_orders')
      .upsert(orderRow, { onConflict: 'checkout_session_id' })

    if (orderError) {
      throw new Error(orderError.message || 'Unable to upsert bcs_orders.')
    }

    const { error: entitlementError } = await supabase
      .from('bcs_entitlements')
      .upsert(entitlementRow, { onConflict: userId ? 'user_id' : 'email' })

    if (entitlementError) {
      throw new Error(entitlementError.message || 'Unable to upsert bcs_entitlements.')
    }

    const { error: accessError } = await supabase
      .from('bcs_channel_access')
      .upsert(accessRow, { onConflict: userId ? 'user_id' : 'email' })

    if (accessError) {
      throw new Error(accessError.message || 'Unable to upsert bcs_channel_access.')
    }

    const eventRow = {
      stripe_event_id: stripeEventId,
      checkout_session_id: session.id,
      user_id: userId,
      email: customerEmail,
      event_type: event.type,
      status: entitlement.fulfillmentStatus,
      payload: {
        customerName,
        productKey,
        requestedTicker,
        allowedTickers: entitlement.allowedTickers,
        pendingChannelSelection: entitlement.pendingChannelSelection
      },
      processed_at: now
    }

    const { error: provisioningError } = await supabase
      .from('bcs_provisioning_events')
      .insert(eventRow)

    if (provisioningError) {
      throw new Error(provisioningError.message || 'Unable to insert bcs_provisioning_events.')
    }

    await sendFulfillmentEmail({
      toEmail: customerEmail,
      purchasedPlan: productKey === PRODUCT_KEYS.FULL_BUNDLE ? 'Full Bundle' : 'Single Channel',
      allowedTickers: entitlement.allowedTickers,
      pendingChannelSelection: entitlement.pendingChannelSelection
    })

    return jsonResponse({
      received: true,
      fulfilled: true,
      stripeEventId,
      fulfillmentStatus: entitlement.fulfillmentStatus
    })
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error || 'Stripe fulfillment failed.')
    console.error('stripe-checkout-fulfillment failed', { error: message, rawBody })

    try {
      const parsed = JSON.parse(rawBody)
      const sessionId = String(parsed?.data?.object?.id ?? '').trim()
      const eventId = String(parsed?.id ?? '').trim()

      if (sessionId) {
        const supabase = getSupabaseAdminClient()

        await supabase.from('bcs_orders').upsert({
          checkout_session_id: sessionId,
          stripe_event_id: eventId || null,
          fulfillment_status: ENTITLEMENT_STATUS.PROVISIONING_FAILED,
          provisioning_error: message,
          updated_at: new Date().toISOString()
        }, { onConflict: 'checkout_session_id' })
      }
    } catch {
      // Best-effort failure state only; signature verification errors may not contain JSON.
    }

    return jsonResponse({ received: true, error: message }, 500)
  }
})
