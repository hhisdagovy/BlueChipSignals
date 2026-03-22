-- Admin UI updates `updated_at` on roadmap milestones; tables only had `created_at`.

alter table public.bcs_roadmap_milestones
  add column if not exists updated_at timestamptz not null default now();

alter table public.bcs_faq_items
  add column if not exists updated_at timestamptz not null default now();

comment on column public.bcs_roadmap_milestones.updated_at is 'Set on edits from admin.html';
comment on column public.bcs_faq_items.updated_at is 'Optional; reserved for future admin updates';
