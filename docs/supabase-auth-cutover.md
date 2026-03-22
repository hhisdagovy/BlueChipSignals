# Supabase (production)

Member logins and entitlements use **Supabase Auth** + **`bcs_entitlements`** / **`bcs_channel_access`**. Stripe fulfillment runs in **Supabase Edge Functions** (`stripe-checkout-fulfillment`).

## Auth import (from Firebase, one-time)

Use **Supabase Dashboard → Authentication** (invite/import) or the **Supabase CLI / Management API** to create users. After import, users should use **password reset** to set a password.

## Link `user_id` on entitlement rows

If `bcs_entitlements.user_id` is **null** or still a **Firebase UID**, fix in **SQL Editor**:

```sql
-- Example: set user_id from Auth by email (run per user or generate from auth.users)
update public.bcs_entitlements e
set user_id = u.id, updated_at = now()
from auth.users u
where lower(trim(e.email)) = lower(trim(u.email))
  and (e.user_id is null or e.user_id::text not in (select id::text from auth.users));
```

Adjust the `where` clause if you only want to fix nulls. Resolve **duplicate** entitlements for the same email manually.

**Runtime fix:** deploy **`member-onboarding`** — it **auto-relinks** a row when the stored `user_id` is not a valid Auth user but **email** matches.

## Comp / free members (no Stripe)

Insert bundle-style rows from Auth users:

- Run **`docs/sql/grant-comp-full-bundle-all-auth-users.sql`** in SQL Editor (`ON CONFLICT DO NOTHING` keeps existing paid rows).

If `INSERT` fails on a **NOT NULL** column, add that column in the statement per your table definition.

## “Logged out” on History / Journal / Planner

Usually **no entitlement** for the session user. Deploy latest **`member-onboarding`** and ensure **`bcs_entitlements.user_id`** = **`auth.users.id`**.

## Member-site admin (`admin.html`)

1. Apply migration **`20260325_bcs_site_staff.sql`** if not already.
2. Insert your Auth UUID:

```sql
insert into public.bcs_site_staff (user_id, note)
values ('PASTE-YOUR-AUTH-USER-UUID', 'site admin')
on conflict (user_id) do nothing;
```

3. **`check-admin.html`** on the site shows your UUID.

## Deploy

```bash
supabase functions deploy stripe-checkout-fulfillment
supabase functions deploy member-onboarding
```

## Railway / Firestore (signals)

Live signals may still write to **Firestore** via **`backend/`** until you dual-write to **`bcs_signals`**. That does not affect Supabase Auth.
