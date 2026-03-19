create extension if not exists pgcrypto;

create or replace function public.crm_can_access_mailbox(target_mailbox_sender_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.mailbox_senders sender
    join public.profiles profile
      on profile.id = auth.uid()
    where sender.id = target_mailbox_sender_id
      and profile.active = true
      and (
        (sender.kind = 'personal' and sender.owner_user_id = auth.uid())
        or (sender.kind = 'support' and profile.role in ('admin', 'support'))
      )
  );
$$;

alter table public.mailbox_senders
  add column if not exists imap_inbox_folder text not null default 'INBOX',
  add column if not exists imap_sent_folder text not null default 'Sent';

update public.mailbox_senders
set
  imap_inbox_folder = coalesce(nullif(trim(imap_inbox_folder), ''), 'INBOX'),
  imap_sent_folder = coalesce(nullif(trim(imap_sent_folder), ''), 'Sent');

create table if not exists public.email_threads (
  id uuid primary key default gen_random_uuid(),
  mailbox_sender_id uuid not null references public.mailbox_senders(id) on delete cascade,
  lead_id bigint references public.leads(id) on delete set null,
  subject text not null default '',
  snippet text,
  participants jsonb not null default '[]'::jsonb,
  folder_presence text[] not null default '{}'::text[],
  latest_message_id uuid,
  latest_message_at timestamptz not null default now(),
  unread_count integer not null default 0,
  is_starred boolean not null default false,
  last_message_direction text check (last_message_direction in ('incoming', 'outgoing')),
  last_message_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_threads_mailbox_latest_idx
  on public.email_threads (mailbox_sender_id, latest_message_at desc);

create index if not exists email_threads_lead_idx
  on public.email_threads (lead_id, latest_message_at desc);

drop trigger if exists set_email_threads_updated_at on public.email_threads;

create trigger set_email_threads_updated_at
before update on public.email_threads
for each row
execute function public.crm_touch_mail_updated_at();

create table if not exists public.mailbox_sync_state (
  mailbox_sender_id uuid not null references public.mailbox_senders(id) on delete cascade,
  folder text not null,
  last_synced_at timestamptz,
  last_uid bigint,
  last_error text,
  sync_status text not null default 'idle',
  synced_message_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (mailbox_sender_id, folder),
  constraint mailbox_sync_state_status_check check (sync_status in ('idle', 'syncing', 'ready', 'error'))
);

create index if not exists mailbox_sync_state_status_idx
  on public.mailbox_sync_state (sync_status, updated_at desc);

drop trigger if exists set_mailbox_sync_state_updated_at on public.mailbox_sync_state;

create trigger set_mailbox_sync_state_updated_at
before update on public.mailbox_sync_state
for each row
execute function public.crm_touch_mail_updated_at();

alter table public.email_messages
  alter column lead_id drop not null;

alter table public.email_messages
  add column if not exists thread_id uuid references public.email_threads(id) on delete set null,
  add column if not exists direction text not null default 'outgoing',
  add column if not exists folder text not null default 'Sent',
  add column if not exists is_read boolean not null default true,
  add column if not exists is_starred boolean not null default false,
  add column if not exists received_at timestamptz,
  add column if not exists message_id_header text,
  add column if not exists in_reply_to text,
  add column if not exists references_header text,
  add column if not exists snippet text,
  add column if not exists participants jsonb not null default '[]'::jsonb,
  add column if not exists to_emails jsonb not null default '[]'::jsonb,
  add column if not exists source text not null default 'crm';

update public.email_messages
set
  direction = coalesce(nullif(direction, ''), 'outgoing'),
  folder = coalesce(nullif(folder, ''), 'Sent'),
  is_read = coalesce(is_read, true),
  is_starred = coalesce(is_starred, false),
  received_at = coalesce(received_at, sent_at, created_at),
  message_id_header = nullif(trim(message_id_header), ''),
  in_reply_to = nullif(trim(in_reply_to), ''),
  references_header = nullif(trim(references_header), ''),
  snippet = coalesce(
    nullif(trim(snippet), ''),
    left(regexp_replace(coalesce(body_text, ''), '\s+', ' ', 'g'), 220)
  ),
  participants = case
    when jsonb_typeof(participants) = 'array' and jsonb_array_length(participants) > 0 then participants
    else jsonb_build_array(
      jsonb_build_object('email', lower(coalesce(from_email, '')), 'name', nullif(trim(coalesce(from_name, '')), ''), 'role', 'from'),
      jsonb_build_object('email', lower(coalesce(to_email, '')), 'name', null, 'role', 'to')
    )
  end,
  to_emails = case
    when jsonb_typeof(to_emails) = 'array' and jsonb_array_length(to_emails) > 0 then to_emails
    else jsonb_build_array(lower(coalesce(to_email, '')))
  end,
  source = coalesce(nullif(trim(source), ''), 'crm');

create index if not exists email_messages_thread_time_idx
  on public.email_messages (thread_id, received_at desc, created_at desc);

create index if not exists email_messages_mailbox_folder_idx
  on public.email_messages (sender_mailbox_id, folder, received_at desc, created_at desc);

create unique index if not exists email_messages_message_id_idx
  on public.email_messages (sender_mailbox_id, message_id_header)
  where message_id_header is not null;

create unique index if not exists email_messages_provider_id_idx
  on public.email_messages (sender_mailbox_id, provider, provider_message_id)
  where provider_message_id is not null;

with seeded_threads as (
  select
    message.id as message_id,
    gen_random_uuid() as thread_id,
    coalesce(message.received_at, message.sent_at, message.created_at) as latest_message_at
  from public.email_messages message
  where message.thread_id is null
),
inserted_threads as (
  insert into public.email_threads (
    id,
    mailbox_sender_id,
    lead_id,
    subject,
    snippet,
    participants,
    folder_presence,
    latest_message_id,
    latest_message_at,
    unread_count,
    is_starred,
    last_message_direction,
    last_message_status
  )
  select
    seeded.thread_id,
    message.sender_mailbox_id,
    message.lead_id,
    coalesce(nullif(trim(message.subject), ''), 'No subject'),
    message.snippet,
    coalesce(message.participants, '[]'::jsonb),
    array[coalesce(nullif(message.folder, ''), 'Sent')],
    message.id,
    seeded.latest_message_at,
    case when message.direction = 'incoming' and coalesce(message.is_read, false) = false then 1 else 0 end,
    coalesce(message.is_starred, false),
    message.direction,
    message.status
  from seeded_threads seeded
  join public.email_messages message
    on message.id = seeded.message_id
  returning id
)
update public.email_messages message
set thread_id = seeded.thread_id
from seeded_threads seeded
where message.id = seeded.message_id;

alter table public.email_threads enable row level security;
alter table public.mailbox_sync_state enable row level security;

drop policy if exists email_messages_select on public.email_messages;
create policy email_messages_select
on public.email_messages
for select
to authenticated
using (
  public.crm_can_access_mailbox(email_messages.sender_mailbox_id)
);

drop policy if exists email_messages_update on public.email_messages;
create policy email_messages_update
on public.email_messages
for update
to authenticated
using (
  public.crm_can_access_mailbox(email_messages.sender_mailbox_id)
)
with check (
  public.crm_can_access_mailbox(email_messages.sender_mailbox_id)
);

drop policy if exists email_threads_select on public.email_threads;
create policy email_threads_select
on public.email_threads
for select
to authenticated
using (
  public.crm_can_access_mailbox(email_threads.mailbox_sender_id)
);

drop policy if exists email_threads_update on public.email_threads;
create policy email_threads_update
on public.email_threads
for update
to authenticated
using (
  public.crm_can_access_mailbox(email_threads.mailbox_sender_id)
)
with check (
  public.crm_can_access_mailbox(email_threads.mailbox_sender_id)
);

drop policy if exists mailbox_sync_state_select on public.mailbox_sync_state;
create policy mailbox_sync_state_select
on public.mailbox_sync_state
for select
to authenticated
using (
  public.crm_can_access_mailbox(mailbox_sync_state.mailbox_sender_id)
);

grant select on public.email_threads to authenticated;
grant select, update on public.email_messages to authenticated;
grant select, update on public.email_threads to authenticated;
grant select on public.mailbox_sync_state to authenticated;
grant select on public.mailbox_senders to authenticated;
