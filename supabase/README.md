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
supabase functions deploy admin-delete-member
```

`admin-create-member` powers **Admin → Add New User** (`admin.html`): creates `auth.users`, `bcs_entitlements`, and `bcs_channel_access` (when status is active). Caller must be in `bcs_site_staff` **or** have CRM `profiles.role` in `admin` / `staff` / `owner` / `super_admin`.

`admin-delete-member` powers **Admin → Delete user**: removes member rows (`bcs_entitlements`, `bcs_channel_access`, `bcs_member_app_state`, `bcs_orders`, `bcs_provisioning_events` when present), best-effort `profiles`, then **`auth.admin.deleteUser`**. Cannot delete yourself or a `bcs_site_staff` user.
