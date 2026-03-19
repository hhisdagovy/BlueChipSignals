create extension if not exists pgcrypto;

create or replace function public.crm_touch_mail_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.crm_current_active_profile_role()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select case
    when profile.active = true then coalesce(nullif(trim(profile.role), ''), 'sales')
    else null
  end
  from public.profiles profile
  where profile.id = auth.uid()
  limit 1;
$$;

create or replace function public.crm_has_global_workspace_read_access()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(public.crm_current_active_profile_role() in ('admin', 'support'), false);
$$;

create or replace function public.crm_can_access_lead_record(target_lead_id bigint)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.leads lead
    join public.profiles profile
      on profile.id = auth.uid()
    where lead.id = target_lead_id
      and profile.active = true
      and (
        profile.role in ('admin', 'support')
        or lead.assigned_rep_id = auth.uid()
      )
  );
$$;

create or replace function public.crm_can_access_support_mailbox()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(public.crm_current_active_profile_role() in ('admin', 'support'), false);
$$;

create table if not exists public.mailbox_senders (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('personal', 'support')),
  owner_user_id uuid references public.profiles(id) on delete cascade,
  sender_email text not null,
  sender_name text not null,
  is_active boolean not null default true,
  last_verified_at timestamptz,
  created_by_user_id uuid references public.profiles(id),
  updated_by_user_id uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mailbox_senders_kind_owner_check check (
    (kind = 'personal' and owner_user_id is not null)
    or (kind = 'support' and owner_user_id is null)
  )
);

create unique index if not exists mailbox_senders_personal_owner_idx
  on public.mailbox_senders (owner_user_id)
  where kind = 'personal';

create unique index if not exists mailbox_senders_support_singleton_idx
  on public.mailbox_senders ((kind))
  where kind = 'support';

create index if not exists mailbox_senders_email_idx
  on public.mailbox_senders (sender_email);

drop trigger if exists set_mailbox_senders_updated_at on public.mailbox_senders;

create trigger set_mailbox_senders_updated_at
before update on public.mailbox_senders
for each row
execute function public.crm_touch_mail_updated_at();

create table if not exists public.mailbox_sender_secrets (
  sender_id uuid primary key references public.mailbox_senders(id) on delete cascade,
  smtp_username text not null,
  password_ciphertext text not null,
  password_iv text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_mailbox_sender_secrets_updated_at on public.mailbox_sender_secrets;

create trigger set_mailbox_sender_secrets_updated_at
before update on public.mailbox_sender_secrets
for each row
execute function public.crm_touch_mail_updated_at();

create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  lead_id bigint not null references public.leads(id) on delete cascade,
  sender_mailbox_id uuid not null references public.mailbox_senders(id) on delete restrict,
  sender_kind text not null check (sender_kind in ('personal', 'support')),
  created_by_user_id uuid not null references public.profiles(id),
  from_email text not null,
  from_name text not null,
  to_email text not null,
  subject text not null,
  body_text text not null,
  body_html text,
  provider text not null default 'smtp',
  provider_message_id text,
  status text not null check (status in ('sent', 'failed')),
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_messages_lead_created_idx
  on public.email_messages (lead_id, created_at desc);

create index if not exists email_messages_created_by_idx
  on public.email_messages (created_by_user_id, created_at desc);

create index if not exists email_messages_sender_idx
  on public.email_messages (sender_mailbox_id, created_at desc);

create index if not exists email_messages_status_idx
  on public.email_messages (status, created_at desc);

drop trigger if exists set_email_messages_updated_at on public.email_messages;

create trigger set_email_messages_updated_at
before update on public.email_messages
for each row
execute function public.crm_touch_mail_updated_at();

alter table public.mailbox_senders enable row level security;
alter table public.mailbox_sender_secrets enable row level security;
alter table public.email_messages enable row level security;

drop policy if exists mailbox_senders_select on public.mailbox_senders;
create policy mailbox_senders_select
on public.mailbox_senders
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.active = true
      and (
        (mailbox_senders.kind = 'personal' and mailbox_senders.owner_user_id = auth.uid())
        or (mailbox_senders.kind = 'support' and profile.role in ('admin', 'support'))
      )
  )
);

drop policy if exists email_messages_select on public.email_messages;
create policy email_messages_select
on public.email_messages
for select
to authenticated
using (
  public.crm_can_access_lead_record(email_messages.lead_id)
);

drop policy if exists support_leads_select on public.leads;
create policy support_leads_select
on public.leads
for select
to authenticated
using (
  public.crm_has_global_workspace_read_access()
);

drop policy if exists support_lead_tags_select on public.lead_tags;
create policy support_lead_tags_select
on public.lead_tags
for select
to authenticated
using (
  public.crm_can_access_lead_record(lead_tags.lead_id)
);

drop policy if exists support_notes_select on public.notes;
create policy support_notes_select
on public.notes
for select
to authenticated
using (
  public.crm_can_access_lead_record(notes.lead_id)
);

drop policy if exists support_note_versions_select on public.note_versions;
create policy support_note_versions_select
on public.note_versions
for select
to authenticated
using (
  exists (
    select 1
    from public.notes note
    where note.id = note_versions.note_id
      and public.crm_can_access_lead_record(note.lead_id)
  )
);

drop policy if exists support_lead_history_select on public.lead_history;
create policy support_lead_history_select
on public.lead_history
for select
to authenticated
using (
  public.crm_can_access_lead_record(lead_history.lead_id)
);

drop policy if exists support_calendar_events_select on public.calendar_events;
create policy support_calendar_events_select
on public.calendar_events
for select
to authenticated
using (
  public.crm_has_global_workspace_read_access()
);

drop policy if exists support_calendar_event_shares_select on public.calendar_event_shares;
create policy support_calendar_event_shares_select
on public.calendar_event_shares
for select
to authenticated
using (
  public.crm_has_global_workspace_read_access()
);

create or replace function public.crm_record_email_send(
  target_lead_id bigint,
  target_sender_mailbox_id uuid,
  target_sender_kind text,
  target_created_by_user_id uuid,
  target_from_email text,
  target_from_name text,
  target_to_email text,
  target_subject text,
  target_body_text text,
  target_body_html text,
  target_provider text,
  target_provider_message_id text,
  target_status text,
  target_error_message text,
  target_sent_at timestamptz default now()
)
returns public.email_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_record public.email_messages;
begin
  insert into public.email_messages (
    lead_id,
    sender_mailbox_id,
    sender_kind,
    created_by_user_id,
    from_email,
    from_name,
    to_email,
    subject,
    body_text,
    body_html,
    provider,
    provider_message_id,
    status,
    error_message,
    sent_at
  )
  values (
    target_lead_id,
    target_sender_mailbox_id,
    target_sender_kind,
    target_created_by_user_id,
    target_from_email,
    target_from_name,
    target_to_email,
    target_subject,
    target_body_text,
    target_body_html,
    coalesce(nullif(target_provider, ''), 'smtp'),
    nullif(target_provider_message_id, ''),
    target_status,
    nullif(target_error_message, ''),
    target_sent_at
  )
  returning * into inserted_record;

  update public.leads
  set updated_at = coalesce(target_sent_at, now())
  where id = target_lead_id;

  if target_status = 'sent' then
    insert into public.lead_history (
      lead_id,
      field_name,
      old_value,
      new_value
    )
    values (
      target_lead_id,
      'email',
      null,
      concat('Sent to ', target_to_email, ' - ', target_subject)
    );
  end if;

  return inserted_record;
end;
$$;

revoke all on function public.crm_record_email_send(
  bigint,
  uuid,
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz
) from public, anon, authenticated;

grant execute on function public.crm_record_email_send(
  bigint,
  uuid,
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz
) to service_role;
