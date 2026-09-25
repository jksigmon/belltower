-- Lets a Managing Teacher chip in the field trip detail view filter the
-- Chaperones/Students tabs down to just that teacher's own homeroom,
-- instead of showing the whole grade.
--
-- The homeroom filter on the Students tab (and the new one being added to
-- Chaperones) matches on students.homeroom_teacher_id, which is an
-- employees.id. get_trip_managers only returns profile_id/display_name/
-- email today, and profiles.display_name is free text that isn't
-- guaranteed to match an employee's first/last name -- not safe to
-- string-match against. Return profiles.employee_id too so the frontend
-- can link a manager chip directly to the employee id used by the
-- homeroom filters.

DROP FUNCTION IF EXISTS public.get_trip_managers(uuid);

CREATE FUNCTION public.get_trip_managers(trip_id uuid)
RETURNS TABLE(profile_id uuid, display_name text, email text, employee_id uuid)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT m.profile_id, p.display_name, p.email, p.employee_id
  FROM public.field_trip_managers m
  LEFT JOIN public.profiles p ON p.id = m.profile_id
  WHERE m.field_trip_id = trip_id
    AND EXISTS (
      SELECT 1 FROM public.profiles v
      WHERE v.user_id = auth.uid()
        AND (
          v.is_superadmin = true
          OR v.school_id = public.ft_get_school_id(trip_id)
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.get_trip_managers(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_trip_managers(uuid) TO service_role;
