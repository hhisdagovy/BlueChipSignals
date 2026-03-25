-- Saved email templates for CRM compose (per authenticated user).

create table if not exists public.crm_email_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  subject text not null default '',
  body_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_email_templates_name_len check (char_length(trim(name)) between 1 and 120),
  constraint crm_email_templates_subject_len check (char_length(subject) <= 160),
  constraint crm_email_templates_body_len check (char_length(body_text) <= 20000)
);

create unique index if not exists crm_email_templates_user_name_lower_idx
  on public.crm_email_templates (user_id, lower(trim(name)));

create index if not exists crm_email_templates_user_updated_idx
  on public.crm_email_templates (user_id, updated_at desc);

drop trigger if exists set_crm_email_templates_updated_at on public.crm_email_templates;

create trigger set_crm_email_templates_updated_at
before update on public.crm_email_templates
for each row
execute function public.crm_touch_mail_updated_at();

alter table public.crm_email_templates enable row level security;

create policy crm_email_templates_select
  on public.crm_email_templates
  for select
  to authenticated
  using (user_id = auth.uid());

create policy crm_email_templates_insert
  on public.crm_email_templates
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy crm_email_templates_update
  on public.crm_email_templates
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy crm_email_templates_delete
  on public.crm_email_templates
  for delete
  to authenticated
  using (user_id = auth.uid());

grant select, insert, update, delete on public.crm_email_templates to authenticated;
