create extension if not exists pgcrypto;

create or replace function public.crm_touch_calendar_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.crm_calendar_actor_is_active()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.active = true
  );
$$;

create or replace function public.crm_can_access_calendar_event(target_event_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.calendar_events event
    join public.profiles profile
      on profile.id = auth.uid()
    left join public.calendar_event_shares share
      on share.event_id = event.id
     and share.shared_with_user_id = auth.uid()
    where event.id = target_event_id
      and profile.active = true
      and (
        profile.role = 'admin'
        or event.owner_user_id = auth.uid()
        or share.shared_with_user_id is not null
      )
  );
$$;

create or replace function public.crm_can_manage_calendar_event(target_event_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.calendar_events event
    join public.profiles profile
      on profile.id = auth.uid()
    where event.id = target_event_id
      and profile.active = true
      and (
        profile.role = 'admin'
        or event.owner_user_id = auth.uid()
      )
  );
$$;

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  lead_id bigint not null references public.leads(id) on delete cascade,
  owner_user_id uuid not null references public.profiles(id),
  created_by_user_id uuid not null references public.profiles(id),
  title text not null,
  action_text text,
  notes text,
  start_at timestamptz not null,
  end_at timestamptz,
  event_time_zone text not null default 'Unknown',
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'canceled', 'missed')),
  visibility text not null default 'private' check (visibility in ('private', 'shared')),
  completed_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.calendar_event_shares (
  event_id uuid not null references public.calendar_events(id) on delete cascade,
  shared_with_user_id uuid not null references public.profiles(id) on delete cascade,
  shared_by_user_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (event_id, shared_with_user_id)
);

create index if not exists calendar_events_owner_start_idx
  on public.calendar_events (owner_user_id, start_at);

create index if not exists calendar_events_lead_start_idx
  on public.calendar_events (lead_id, start_at);

create index if not exists calendar_events_open_start_idx
  on public.calendar_events (start_at)
  where status in ('scheduled', 'missed');

create index if not exists calendar_event_shares_user_event_idx
  on public.calendar_event_shares (shared_with_user_id, event_id);

drop trigger if exists set_calendar_events_updated_at on public.calendar_events;

create trigger set_calendar_events_updated_at
before update on public.calendar_events
for each row
execute function public.crm_touch_calendar_updated_at();

alter table public.calendar_events enable row level security;
alter table public.calendar_event_shares enable row level security;

drop policy if exists calendar_events_select on public.calendar_events;
create policy calendar_events_select
on public.calendar_events
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.active = true
      and (
        profile.role = 'admin'
        or calendar_events.owner_user_id = auth.uid()
        or exists (
          select 1
          from public.calendar_event_shares share
          where share.event_id = calendar_events.id
            and share.shared_with_user_id = auth.uid()
        )
      )
  )
);

drop policy if exists calendar_events_insert on public.calendar_events;
create policy calendar_events_insert
on public.calendar_events
for insert
to authenticated
with check (
  public.crm_calendar_actor_is_active()
  and owner_user_id = auth.uid()
  and created_by_user_id = auth.uid()
);

drop policy if exists calendar_events_update on public.calendar_events;
create policy calendar_events_update
on public.calendar_events
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.active = true
      and (
        profile.role = 'admin'
        or calendar_events.owner_user_id = auth.uid()
      )
  )
)
with check (
  exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.active = true
      and (
        profile.role = 'admin'
        or calendar_events.owner_user_id = auth.uid()
      )
  )
);

drop policy if exists calendar_events_delete on public.calendar_events;
create policy calendar_events_delete
on public.calendar_events
for delete
to authenticated
using (
  exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.active = true
      and (
        profile.role = 'admin'
        or calendar_events.owner_user_id = auth.uid()
      )
  )
);

drop policy if exists calendar_event_shares_select on public.calendar_event_shares;
create policy calendar_event_shares_select
on public.calendar_event_shares
for select
to authenticated
using (
  public.crm_can_access_calendar_event(calendar_event_shares.event_id)
);

drop policy if exists calendar_event_shares_insert on public.calendar_event_shares;
create policy calendar_event_shares_insert
on public.calendar_event_shares
for insert
to authenticated
with check (
  public.crm_can_manage_calendar_event(calendar_event_shares.event_id)
  and shared_by_user_id = auth.uid()
);

drop policy if exists calendar_event_shares_delete on public.calendar_event_shares;
create policy calendar_event_shares_delete
on public.calendar_event_shares
for delete
to authenticated
using (
  public.crm_can_manage_calendar_event(calendar_event_shares.event_id)
);

insert into public.calendar_events (
  lead_id,
  owner_user_id,
  created_by_user_id,
  title,
  action_text,
  notes,
  start_at,
  end_at,
  event_time_zone,
  status,
  visibility,
  created_at,
  updated_at
)
select
  lead.id,
  lead.assigned_rep_id,
  lead.assigned_rep_id,
  concat(
    'Follow-up with ',
    coalesce(
      nullif(trim(lead.full_name), ''),
      nullif(trim(concat_ws(' ', lead.first_name, lead.last_name)), ''),
      'Client'
    )
  ),
  nullif(trim(lead.follow_up_action), ''),
  null,
  lead.follow_up_at,
  null,
  coalesce(nullif(trim(lead.timezone), ''), 'Unknown'),
  case
    when lead.follow_up_at < now() then 'missed'
    else 'scheduled'
  end,
  'private',
  coalesce(lead.updated_at, lead.created_at, now()),
  coalesce(lead.updated_at, lead.created_at, now())
from public.leads lead
where lead.follow_up_at is not null
  and lead.assigned_rep_id is not null
  and not exists (
    select 1
    from public.calendar_events event
    where event.lead_id = lead.id
      and event.owner_user_id = lead.assigned_rep_id
      and event.start_at = lead.follow_up_at
      and coalesce(event.action_text, '') = coalesce(lead.follow_up_action, '')
  );
