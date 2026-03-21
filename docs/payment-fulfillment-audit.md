# Payment Fulfillment Audit and Phase 1 Design

## Root-cause summary
- `pricing.html` sends buyers to static Stripe payment links, so the repo had no canonical server-side order creation or fulfillment trigger.
- `functions/index.js` only supported manual admin account creation, which made post-payment provisioning a manual process.
- `dashboard.html` embedded every Telegram invite link directly in page source and depended on frontend row locking for single-plan restrictions.
- `assets/js/firebase-user-profile.js` treated `plan + allowedTicker` on the user document as the only entitlement source, so single-channel purchases without a known ticker could not be represented safely.
- Because Telegram access was not derived from server-side entitlements, page source / DOM inspection exposed links that a non-entitled user should never receive.

## Canonical data model
### `users/{uid}`
- `email`
- `displayName`, `firstName`, `lastName`
- `plan`: `single | bundle`
- `allowedTicker`: legacy compatibility field for current frontend and signal gating
- `subscriptionStatus`: UX-facing status string
- `entitlementStatus`: `active | pending_channel_selection | provisioning_failed`
- `pendingChannelSelection`: boolean
- `setupCompleted`, `profileComplete`
- `lastFulfilledOrderId`, `lastStripeEventId`

### `orders/{checkoutSessionId}`
- `provider`: `stripe`
- `checkoutSessionId`, `paymentIntentId`, `customerId`
- `customerEmail`, `customerName`
- `productKey`: `single_channel | full_bundle`
- `requestedTicker`
- `paymentStatus`, `fulfillmentStatus`
- `metadata`, `lineItems`
- `userId`
- timestamps

### `entitlements/{uid}`
- `userId`, `email`
- `plan`
- `productKey`
- `allowedTicker` (compatibility)
- `allowedTickers`: canonical list of authorized channels
- `entitlementStatus`
- `sourceOrderId`
- timestamps

### `channel_access/{uid}`
- `userId`
- `entitlementStatus`
- `telegramChannels`: authorized ticker list for runtime access resolution
- timestamps

### `provisioning_events/{eventId}`
- `orderId`
- `userId`
- `eventType`
- `status`
- `payload`
- timestamps

## Recommended implementation path
1. Replace direct fulfillment assumptions with `stripeCheckoutFulfillment`, a Stripe webhook entrypoint that receives `checkout.session.completed`.
2. Configure Stripe products/prices to include canonical metadata:
   - `product_key=single_channel` or `product_key=full_bundle`
   - optional `ticker=SPY|TSLA|...` for single-channel checkout when known
3. On webhook receipt:
   - verify signature
   - retrieve expanded line items
   - upsert `orders/{sessionId}`
   - locate/create Firebase Auth + `users/{uid}` from Stripe customer email
   - compute entitlements
   - write `entitlements/{uid}`, `channel_access/{uid}`, and audit event rows
4. Keep manual admin provisioning as fallback; it should write the same entitlement documents so both paths converge on one model.
5. Deliver Telegram access only through a callable backend (`getDashboardAccessState`) that returns channels for the current authenticated user.
6. If a single-channel order lacks a ticker, persist `pending_channel_selection` and collect the selection during onboarding via `selectSingleChannelTicker`.

## Removal plan for hardcoded Telegram links
1. Remove invite URLs from `dashboard.html` HTML.
2. Store invite URLs in server-side runtime config / secrets only.
3. Have the dashboard call `getDashboardAccessState` after auth.
4. Render Telegram buttons only from returned entitled channels.
5. Return no unauthorized channel records, so forbidden invites never appear in page source or runtime payload.

## Phase 1 scaffolding included in this patch
- Stripe webhook function for auditable fulfillment.
- Shared order / entitlement / channel-access persistence.
- Dashboard callable for runtime Telegram access.
- Pending single-channel ticker selection callable.
- Welcome setup UI support for pending ticker selection.
- Frontend normalization changes so pending selection is a first-class entitlement state.

## Rollout notes
- Feature-flag webhook usage by only wiring the Stripe endpoint after secrets + metadata are configured.
- Existing manual admin provisioning remains available and now writes mirrored entitlement docs.
- Existing `users.plan` / `users.allowedTicker` fields are preserved for incremental rollout and rollback safety.

## Test plan
- Stripe CLI replay of `checkout.session.completed` for:
  - single-channel with `metadata.ticker`
  - single-channel without `metadata.ticker`
  - full bundle
- Confirm user record creation/linking by email.
- Confirm `orders`, `entitlements`, `channel_access`, and `provisioning_events` documents are written.
- Confirm welcome setup can finalize pending single-channel selection.
- Confirm dashboard only returns entitled Telegram channels from `getDashboardAccessState`.
