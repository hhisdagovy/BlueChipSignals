# Supabase

## Migrations (`migrations/*.sql`)

**Do not delete** these files from the repo. They are the schema history for your project: new environments, `supabase db push`, and teammates all depend on them. Removing them does **not** change your hosted database, but it breaks reproducible setup.

If you need a clean slate locally, use `supabase db reset` (dev only), not deleting migration files from git.

## Edge Functions

Deploy from repo root, e.g.:

```bash
supabase functions deploy member-onboarding
supabase functions deploy stripe-checkout-fulfillment
supabase functions deploy admin-create-member
```

`admin-create-member` powers **Admin → Add New User** (`admin.html`): creates `auth.users`, `bcs_entitlements`, and `bcs_channel_access` (when status is active). Caller must be in `bcs_site_staff` **or** have CRM `profiles.role` in `admin` / `staff` / `owner` / `super_admin`.
