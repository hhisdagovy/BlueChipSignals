alter table public.profiles
  add column if not exists call_preference text;

update public.profiles
set call_preference = 'system_default'
where coalesce(nullif(trim(call_preference), ''), '') = '';

alter table public.profiles
  alter column call_preference set default 'system_default';

alter table public.profiles
  drop constraint if exists profiles_call_preference_check;

alter table public.profiles
  add constraint profiles_call_preference_check
  check (call_preference in ('system_default', 'google_voice'));

alter table public.profiles
  alter column call_preference set not null;
