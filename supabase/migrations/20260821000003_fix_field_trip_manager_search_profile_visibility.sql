-- Bug: a teacher (no can_manage_field_trips / access-manage permission)
-- creating or editing a field trip cannot add co-teachers as trip
-- managers. searchStaffProfiles() in admin.field-trips.js finds the
-- matching employees fine (employees_read_same_school lets any active
-- staff member read the school's employee directory), but its second
-- query -- a plain `from('profiles').select(...).in('employee_id', ...)`
-- to resolve each employee's profile id / can_login flag -- goes
-- through RLS. profiles only has SELECT policies for admins/access
-- managers and "read your own row" (profiles_read_self); a plain
-- teacher's read of *other* staff's profiles rows comes back empty.
-- With no matching profile row, every candidate teacher silently
-- falls into the "noLogin" bucket and shows as "no portal access
-- yet, can't be assigned" in the typeahead -- even when they do have
-- login access. Admins hit the "Admins can read users in their
-- school" policy and never see this.
--
-- Fix: a SECURITY DEFINER lookup, same pattern as ft_is_manager /
-- get_trip_managers, that returns just the id/can_login fields needed
-- to populate the typeahead, scoped to the caller's own school.
CREATE OR REPLACE FUNCTION public.ft_staff_login_status(target_employee_ids uuid[])
RETURNS TABLE(employee_id uuid, profile_id uuid, email text, can_login boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.employee_id, p.id, p.email, p.can_login
  FROM public.profiles p
  WHERE p.employee_id = ANY(target_employee_ids)
    AND p.school_id = public.current_user_school_id()
    AND public.current_user_is_active_in_school(p.school_id);
$$;

GRANT EXECUTE ON FUNCTION public.ft_staff_login_status(uuid[]) TO authenticated;
