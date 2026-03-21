alter table public.mailbox_senders
  add column if not exists signature_mode text not null default 'plain_text',
  add column if not exists signature_template jsonb not null default '{}'::jsonb,
  add column if not exists signature_html_override text;

alter table public.mailbox_senders
  drop constraint if exists mailbox_senders_signature_mode_check;

alter table public.mailbox_senders
  add constraint mailbox_senders_signature_mode_check
  check (signature_mode in ('plain_text', 'template', 'html_override'));

update public.mailbox_senders
set
  signature_mode = case
    when coalesce(nullif(trim(signature_html_override), ''), '') <> '' then 'html_override'
    when jsonb_typeof(signature_template) = 'object' and signature_template <> '{}'::jsonb then 'template'
    else 'plain_text'
  end,
  signature_template = case
    when jsonb_typeof(signature_template) = 'object' then signature_template
    else '{}'::jsonb
  end,
  signature_html_override = nullif(trim(signature_html_override), ''),
  signature_text = nullif(trim(signature_text), '');

insert into storage.buckets (id, name, public)
values ('email-signatures', 'email-signatures', true)
on conflict (id) do update
set public = excluded.public;

drop policy if exists email_signature_assets_public_read on storage.objects;
create policy email_signature_assets_public_read
on storage.objects
for select
to public
using (bucket_id = 'email-signatures');

drop policy if exists email_signature_assets_authenticated_insert on storage.objects;
create policy email_signature_assets_authenticated_insert
on storage.objects
for insert
to authenticated
with check (bucket_id = 'email-signatures');

drop policy if exists email_signature_assets_authenticated_update on storage.objects;
create policy email_signature_assets_authenticated_update
on storage.objects
for update
to authenticated
using (bucket_id = 'email-signatures')
with check (bucket_id = 'email-signatures');

drop policy if exists email_signature_assets_authenticated_delete on storage.objects;
create policy email_signature_assets_authenticated_delete
on storage.objects
for delete
to authenticated
using (bucket_id = 'email-signatures');
