-- Member-site admin / staff (separate from CRM `profiles`).
-- RLS policies on bcs_* tables use bcs_is_staff_user(); CRM continues to use profiles.role for CRM-only checks.

create table if not exists public.bcs_site_staff (
  user_id uuid primary key references auth.users (id) on delete cascade,
  note text,
  created_at timestamptz not null default now()
);

comment on table public.bcs_site_staff is 'Users allowed to use public-site admin.html; not tied to CRM profiles.';

create index if not exists bcs_site_staff_user_id_idx on public.bcs_site_staff (user_id);

alter table public.bcs_site_staff enable row level security;

drop policy if exists "bcs_site_staff_select_own" on public.bcs_site_staff;
create policy "bcs_site_staff_select_own"
  on public.bcs_site_staff for select
  to authenticated
  using (user_id = auth.uid());

-- No insert/update/delete for authenticated clients — add rows via SQL Editor (service role) or automation.

create or replace function public.bcs_is_staff_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.bcs_site_staff s
    where s.user_id = auth.uid()
  );
$$;

grant execute on function public.bcs_is_staff_user() to authenticated, anon;
