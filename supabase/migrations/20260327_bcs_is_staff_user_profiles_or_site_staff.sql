-- Allow site admin RLS when staff is granted via CRM profiles OR bcs_site_staff
-- (covers DBs that only had profiles-based checks before bcs_site_staff existed).

create or replace function public.bcs_is_staff_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.bcs_site_staff s
    where s.user_id = auth.uid()
  )
  or coalesce(
    (
      select lower(coalesce(p.role::text, '')) in (
        'admin', 'staff', 'owner', 'super_admin', 'superadmin'
      )
      from public.profiles p
      where p.id = auth.uid()
    ),
    false
  );
$$;

grant execute on function public.bcs_is_staff_user() to authenticated, anon;
