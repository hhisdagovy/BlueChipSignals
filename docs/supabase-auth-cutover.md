# Supabase Auth Cutover (Firebase -> Supabase)

## Execute order (today)

1. Export Firebase Auth users
2. Import users into Supabase Auth
3. Backfill `user_id` across BCS tables
4. Deploy Stripe fulfillment function
5. Smoke test checkout + login + reset password
6. Disable Firebase auth entrypoints

## Commands

```bash
# 1) Export Firebase users
firebase auth:export users.json --format=json

# 2) Import to Supabase Auth (dry run first)
export SUPABASE_URL="https://<project>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<service-role>"
export FIREBASE_AUTH_EXPORT_PATH="./users.json"
export DRY_RUN=true
node scripts/migrate-firebase-auth-to-supabase.mjs

# 3) Real import
export DRY_RUN=false
node scripts/migrate-firebase-auth-to-supabase.mjs

# 4) Backfill user_id (dry run then real)
export DRY_RUN=true
node scripts/backfill-bcs-user-ids.mjs
export DRY_RUN=false
node scripts/backfill-bcs-user-ids.mjs

# 5) Deploy webhook
supabase functions deploy stripe-checkout-fulfillment
```

## Notes

- Imported users are created with random passwords. Use your existing reset-password flow to set real passwords.
- This avoids split auth immediately and unblocks checkout provisioning.
- Keep Firebase auth available for 24-48h rollback only, then remove it from member pages.
