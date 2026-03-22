# Firestore → Supabase (member site)

## Schema (SQL migrations)

Apply in order via **Supabase SQL Editor** or CLI — files live in **`supabase/migrations/`**, including:

- **`20260324_bcs_public_site_tables.sql`** — `bcs_site_documents`, FAQ, roadmap, signals, member state, RLS, `bcs_is_staff_user()` (staff = **`bcs_site_staff`** after `20260325`).
- **`20260325_bcs_site_staff.sql`** — member-site admin table + staff function.

| Supabase | Replaces Firestore |
|----------|-------------------|
| `bcs_site_documents` (`site`, `signals`, `stats`) | `settings/*`, `site_config/stats` |
| `bcs_faq_items` | `faq_items` |
| `bcs_roadmap_milestones` | `roadmap_milestones` |
| `bcs_signals` | `signals` |
| `bcs_member_app_state` | optional user journal/planner JSON |

## Copying old Firestore data

There is **no** repo script anymore. Options:

1. **Supabase Table Editor** — import CSV.
2. **Firebase export** + transform (Console, `gcloud firestore export`, or a one-off script **outside** this repo).
3. **SQL** — insert rows using the field mapping below.

### Field mapping

| Firestore | Supabase | Notes |
|-----------|----------|--------|
| `faq_items.order` | `bcs_faq_items.sort_order` | |
| `roadmap_milestones.order` | `bcs_roadmap_milestones.sort_order` | `features` → jsonb |
| `settings/site` | `bcs_site_documents` id `site` | `data` jsonb |
| `settings/signals` | id `signals` | |
| `site_config/stats` | id `stats` | |
| `signals.contractType` | `bcs_signals.contract_type` | doc id → `external_id` unique |
| `signals.timestamp` | `timestamp` | timestamptz |

Example signal insert:

```sql
insert into public.bcs_signals (
  stock, contract_type, price, premium, strike, expiration,
  timestamp, vwap, mfi, volume, external_id
) values (
  'NVDA', 'Call', 142.50, 3.20, 145, '2026-03-28',
  '2026-03-15T14:30:00Z', 141.00, 55.0, 0, 'firestore_DOC_ID'
)
on conflict (external_id) do nothing;
```

## Member-site admin

See **`docs/supabase-auth-cutover.md`** (`bcs_site_staff`, not CRM `profiles`).

## Signal pipeline

**Today:** `backend/main_flask.py` (Railway) may still write **Firestore**; the site can read **`bcs_signals`** from Supabase for history.

**Later:** dual-write or only Supabase from Railway; see comments in `backend/main_flask.py`.

## Auth / entitlements

All member auth is **Supabase**. Entitlements and comp users: **`docs/supabase-auth-cutover.md`** and **`docs/sql/grant-comp-full-bundle-all-auth-users.sql`**.
