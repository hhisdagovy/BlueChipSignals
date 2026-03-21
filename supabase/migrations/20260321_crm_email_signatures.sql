alter table public.mailbox_senders
  add column if not exists signature_text text;

update public.mailbox_senders
set signature_text = nullif(trim(signature_text), '');
