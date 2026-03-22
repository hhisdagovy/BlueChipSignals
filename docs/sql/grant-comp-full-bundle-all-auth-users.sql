-- Grant Full Bundle–style access to every Auth user with an email (comp / free accounts).
-- Run in Supabase SQL Editor. Adjust if your table has extra NOT NULL columns.
--
-- "Missing only": use ON CONFLICT DO NOTHING so existing paid rows are untouched.
-- To overwrite everyone with bundle, change DO NOTHING to DO UPDATE (see comment block below).

insert into public.bcs_entitlements (
  user_id,
  email,
  product_key,
  plan_key,
  plan,
  allowed_ticker,
  allowed_tickers,
  entitlement_status,
  fulfillment_status,
  updated_at
)
select
  u.id,
  lower(trim(u.email)),
  'full_bundle',
  'bundle',
  'bundle',
  null,
  array['SPY','TSLA','META','AAPL','NVDA','AMZN']::text[],
  'active',
  'active',
  now()
from auth.users u
where u.email is not null
  and length(trim(u.email)) > 0
on conflict (user_id) do nothing;

insert into public.bcs_channel_access (
  user_id,
  entitlement_status,
  telegram_channels,
  updated_at
)
select
  u.id,
  'active',
  array['SPY','TSLA','META','AAPL','NVDA','AMZN']::text[],
  now()
from auth.users u
where u.email is not null
  and length(trim(u.email)) > 0
on conflict (user_id) do nothing;

/*
-- Overwrite variant (forces bundle for all listed users):

insert into public.bcs_entitlements ( ...same columns... )
select ...same...
on conflict (user_id) do update set
  email = excluded.email,
  product_key = excluded.product_key,
  plan_key = excluded.plan_key,
  plan = excluded.plan,
  allowed_ticker = excluded.allowed_ticker,
  allowed_tickers = excluded.allowed_tickers,
  entitlement_status = excluded.entitlement_status,
  fulfillment_status = excluded.fulfillment_status,
  updated_at = excluded.updated_at;
*/
