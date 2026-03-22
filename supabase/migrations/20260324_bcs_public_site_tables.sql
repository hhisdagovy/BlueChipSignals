-- Blue Chip Signals: member-facing site data (Firestore parity)
-- Run after CRM profiles table exists (uses bcs_is_staff_user).

-- ---------------------------------------------------------------------------
-- Staff gate (same Supabase auth as CRM; profiles.role drives admin UI)
-- ---------------------------------------------------------------------------
create or replace function public.bcs_is_staff_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select lower(coalesce(p.role::text, '')) in (
        'admin', 'staff', 'owner', 'super_admin', 'superadmin'
      )
      from public.profiles p
      where p.id = auth.uid()
    ),
    false
  );
$$;

grant execute on function public.bcs_is_staff_user() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Site documents: maintenance, signal channel toggles, public stats (JSON)
-- Replaces Firestore: settings/site, settings/signals, site_config/stats
-- ---------------------------------------------------------------------------
create table if not exists public.bcs_site_documents (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.bcs_site_documents enable row level security;

drop policy if exists "bcs_site_documents_select_public" on public.bcs_site_documents;
create policy "bcs_site_documents_select_public"
  on public.bcs_site_documents for select
  using (true);

drop policy if exists "bcs_site_documents_write_staff" on public.bcs_site_documents;
create policy "bcs_site_documents_write_staff"
  on public.bcs_site_documents for all
  using (public.bcs_is_staff_user())
  with check (public.bcs_is_staff_user());

insert into public.bcs_site_documents (id, data)
values
  (
    'site',
    jsonb_build_object(
      'maintenanceMode', false,
      'maintenanceMessage', '',
      'announcementActive', false,
      'announcementText', '',
      'announcementType', 'info',
      'maintenancePages', '{}'::jsonb
    )
  ),
  (
    'signals',
    jsonb_build_object(
      'SPY', true, 'TSLA', true, 'META', true, 'AAPL', true, 'NVDA', true, 'AMZN', true
    )
  ),
  (
    'stats',
    jsonb_build_object(
      'signalChannels', 6,
      'educationalGuides', 18,
      'roadmapPhases', 4
    )
  )
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- FAQ (Firestore faq_items)
-- ---------------------------------------------------------------------------
create table if not exists public.bcs_faq_items (
  id uuid primary key default gen_random_uuid(),
  sort_order int not null default 0,
  category text not null default 'general',
  question text not null,
  answer text not null,
  created_at timestamptz not null default now()
);

create index if not exists bcs_faq_items_cat_order_idx
  on public.bcs_faq_items (category, sort_order);

alter table public.bcs_faq_items enable row level security;

drop policy if exists "bcs_faq_select_public" on public.bcs_faq_items;
create policy "bcs_faq_select_public"
  on public.bcs_faq_items for select
  using (true);

drop policy if exists "bcs_faq_write_staff" on public.bcs_faq_items;
create policy "bcs_faq_write_staff"
  on public.bcs_faq_items for all
  using (public.bcs_is_staff_user())
  with check (public.bcs_is_staff_user());

-- ---------------------------------------------------------------------------
-- Roadmap milestones (Firestore roadmap_milestones)
-- ---------------------------------------------------------------------------
create table if not exists public.bcs_roadmap_milestones (
  id uuid primary key default gen_random_uuid(),
  sort_order int not null default 0,
  label text not null,
  status text not null default 'planned',
  features jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists bcs_roadmap_milestones_order_idx
  on public.bcs_roadmap_milestones (sort_order);

alter table public.bcs_roadmap_milestones enable row level security;

drop policy if exists "bcs_roadmap_select_public" on public.bcs_roadmap_milestones;
create policy "bcs_roadmap_select_public"
  on public.bcs_roadmap_milestones for select
  using (true);

drop policy if exists "bcs_roadmap_write_staff" on public.bcs_roadmap_milestones;
create policy "bcs_roadmap_write_staff"
  on public.bcs_roadmap_milestones for all
  using (public.bcs_is_staff_user())
  with check (public.bcs_is_staff_user());

-- ---------------------------------------------------------------------------
-- Signals history (Firestore signals collection)
-- ---------------------------------------------------------------------------
create table if not exists public.bcs_signals (
  id uuid primary key default gen_random_uuid(),
  stock text not null,
  contract_type text,
  price numeric,
  premium numeric,
  strike numeric,
  expiration text,
  timestamp timestamptz not null default now(),
  vwap numeric,
  mfi numeric,
  volume numeric,
  external_id text unique,
  created_at timestamptz not null default now()
);

create index if not exists bcs_signals_stock_timestamp_idx
  on public.bcs_signals (stock, timestamp desc);

create index if not exists bcs_signals_timestamp_idx
  on public.bcs_signals (timestamp desc);

alter table public.bcs_signals enable row level security;

drop policy if exists "bcs_signals_select_authenticated" on public.bcs_signals;
create policy "bcs_signals_select_authenticated"
  on public.bcs_signals for select
  to authenticated
  using (true);

drop policy if exists "bcs_signals_write_staff" on public.bcs_signals;
create policy "bcs_signals_write_staff"
  on public.bcs_signals for all
  using (public.bcs_is_staff_user())
  with check (public.bcs_is_staff_user());

-- ---------------------------------------------------------------------------
-- Per-member planner + journal JSON (Firestore users.tradePlans / users.trades)
-- ---------------------------------------------------------------------------
create table if not exists public.bcs_member_app_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  trade_plans jsonb not null default '[]'::jsonb,
  trade_plans_updated timestamptz,
  journal_trades jsonb not null default '[]'::jsonb,
  journal_last_updated timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.bcs_member_app_state enable row level security;

drop policy if exists "bcs_member_app_state_own" on public.bcs_member_app_state;
create policy "bcs_member_app_state_own"
  on public.bcs_member_app_state for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "bcs_member_app_state_staff" on public.bcs_member_app_state;
create policy "bcs_member_app_state_staff"
  on public.bcs_member_app_state for all
  using (public.bcs_is_staff_user())
  with check (public.bcs_is_staff_user());

-- ---------------------------------------------------------------------------
-- Entitlements: member read own row; staff full access (table may already exist)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'bcs_entitlements'
  ) then
    execute 'alter table public.bcs_entitlements enable row level security';

    execute 'drop policy if exists "bcs_entitlements_select_own" on public.bcs_entitlements';
    execute $p$
      create policy "bcs_entitlements_select_own"
        on public.bcs_entitlements for select
        to authenticated
        using (user_id is not null and auth.uid() = user_id)
    $p$;

    execute 'drop policy if exists "bcs_entitlements_staff_all" on public.bcs_entitlements';
    execute $p$
      create policy "bcs_entitlements_staff_all"
        on public.bcs_entitlements for all
        using (public.bcs_is_staff_user())
        with check (public.bcs_is_staff_user())
    $p$;
  end if;
end $$;

comment on table public.bcs_site_documents is 'Replaces Firestore settings/* and site_config/*';
comment on table public.bcs_faq_items is 'Replaces Firestore faq_items';
comment on table public.bcs_roadmap_milestones is 'Replaces Firestore roadmap_milestones';
comment on table public.bcs_signals is 'Replaces Firestore signals';
comment on table public.bcs_member_app_state is 'Replaces Firestore users.tradePlans and users.trades';
