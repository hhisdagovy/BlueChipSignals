-- HTML body for saved CRM email templates (plain text remains for fallback / snippets).

alter table public.crm_email_templates
  add column if not exists body_html text not null default '';

alter table public.crm_email_templates
  drop constraint if exists crm_email_templates_body_html_len;

alter table public.crm_email_templates
  add constraint crm_email_templates_body_html_len check (char_length(body_html) <= 20000);
