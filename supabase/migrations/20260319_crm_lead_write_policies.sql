create or replace function public.crm_can_create_lead_with_assignee(target_assigned_rep_id uuid)
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
      and (
        profile.role = 'admin'
        or (
          profile.role in ('sales', 'senior_rep')
          and target_assigned_rep_id = auth.uid()
        )
      )
  );
$$;

create or replace function public.crm_can_manage_lead_write(target_lead_id bigint)
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
        profile.role = 'admin'
        or (
          profile.role in ('sales', 'senior_rep')
          and lead.assigned_rep_id = auth.uid()
        )
      )
  );
$$;

drop policy if exists crm_leads_insert on public.leads;
create policy crm_leads_insert
on public.leads
for insert
to authenticated
with check (
  public.crm_can_create_lead_with_assignee(assigned_rep_id)
);

drop policy if exists crm_leads_update on public.leads;
create policy crm_leads_update
on public.leads
for update
to authenticated
using (
  public.crm_can_manage_lead_write(id)
)
with check (
  public.crm_can_create_lead_with_assignee(assigned_rep_id)
);

drop policy if exists crm_leads_delete on public.leads;
create policy crm_leads_delete
on public.leads
for delete
to authenticated
using (
  public.crm_current_active_profile_role() = 'admin'
);

drop policy if exists crm_lead_tags_insert on public.lead_tags;
create policy crm_lead_tags_insert
on public.lead_tags
for insert
to authenticated
with check (
  public.crm_can_manage_lead_write(lead_id)
);

drop policy if exists crm_lead_tags_delete on public.lead_tags;
create policy crm_lead_tags_delete
on public.lead_tags
for delete
to authenticated
using (
  public.crm_can_manage_lead_write(lead_id)
);

drop policy if exists crm_lead_history_insert on public.lead_history;
create policy crm_lead_history_insert
on public.lead_history
for insert
to authenticated
with check (
  public.crm_can_manage_lead_write(lead_id)
);

drop policy if exists crm_notes_insert on public.notes;
create policy crm_notes_insert
on public.notes
for insert
to authenticated
with check (
  public.crm_can_manage_lead_write(lead_id)
  and created_by = auth.uid()
);

drop policy if exists crm_notes_update on public.notes;
create policy crm_notes_update
on public.notes
for update
to authenticated
using (
  public.crm_can_manage_lead_write(lead_id)
  and (
    public.crm_current_active_profile_role() = 'admin'
    or created_by = auth.uid()
  )
)
with check (
  public.crm_can_manage_lead_write(lead_id)
  and (
    public.crm_current_active_profile_role() = 'admin'
    or created_by = auth.uid()
  )
);

drop policy if exists crm_note_versions_insert on public.note_versions;
create policy crm_note_versions_insert
on public.note_versions
for insert
to authenticated
with check (
  note_versions.edited_by = auth.uid()
  and exists (
    select 1
    from public.notes note
    where note.id = note_versions.note_id
      and public.crm_can_manage_lead_write(note.lead_id)
      and (
        public.crm_current_active_profile_role() = 'admin'
        or note.created_by = auth.uid()
      )
  )
);
