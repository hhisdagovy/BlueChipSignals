# Railway backend → Supabase `bcs_signals`

The Flask app in `backend/main_flask.py` (deployed on Railway) used to mirror new signals to **Firestore**. That path is replaced by **`public.bcs_signals`** using the **Supabase service role key** (server-side only — never expose it in the browser).

## What was wired

| Piece | Behavior |
|--------|------------|
| **Telegram webhook** / **`POST /api/signals/new`** / **admin “Post signal”** | Still writes **SQLite** (`signals.db`) for local durability, then **inserts the same row into `bcs_signals`** when Supabase env vars are set. |
| **`GET /api/signals/latest`** | Reads from **`bcs_signals`** when Supabase is configured; otherwise falls back to SQLite (for local dev without env). |
| **Railway admin `/admin/manage-signals`** | Lists / edits / deletes rows in **`bcs_signals`** (UUID in URLs). |
| **Member site** | Already reads history via Supabase anon + user JWT (`bcs_signals` RLS). New rows from Railway appear there automatically. |

Each mirrored row sets **`external_id`** = `railway-sqlite:<sqlite_row_id>` so you can correlate SQLite and Postgres if needed.

## Railway environment variables

Add these in the Railway service (same project as your Supabase database):

1. **`SUPABASE_URL`** — Project URL, e.g. `https://xxxx.supabase.co`  
   (Settings → API → Project URL)

2. **`SUPABASE_SERVICE_ROLE_KEY`** — **service_role** secret (Settings → API → service_role).  
   - Used only on the server.  
   - Bypasses RLS — required for the backend to insert/update/delete without a user session.

3. **Remove (optional)** — `FIREBASE_SERVICE_ACCOUNT_JSON` is no longer used **for signals**. You can keep it only if you still use **Demo accounts** in Railway (`/admin/demo-accounts`), which still touch Firestore + Firebase Auth.

4. **Redeploy** after changing env vars so `pip install` picks up `supabase` from `backend/requirements.txt`.

## Local development

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export SUPABASE_URL="https://xxxx.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="eyJ..."
python main_flask.py
```

Without the two variables, the app behaves like before for SQLite-only testing; member-facing history should still target Supabase from the static site when users log in.

## Database

Table **`public.bcs_signals`** is defined in `supabase/migrations/20260324_bcs_public_site_tables.sql`. No extra migration is required for Railway writes: the **service role** bypasses RLS.

## Operational checklist

- [ ] Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` on Railway  
- [ ] Redeploy backend (`requirements.txt` includes `supabase`)  
- [ ] Send a test signal (Telegram or admin post) and confirm a new row in **Table Editor → bcs_signals**  
- [ ] Confirm the logged-in **dashboard** shows the signal via existing Supabase reads  

## Historical note

Legacy data that only existed in Firestore or old SQLite files is **not** auto-imported. One-time backfill: export CSV / script `INSERT` into `bcs_signals`, or run a small migration job.
