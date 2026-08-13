-- ============================================================
-- Follow-up to 20260812000001_fix_guardians_families_rls_perf.sql.
--
-- That migration found and fixed a statement-timeout bug on
-- guardians/families: their read policies used a raw inline
--   EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() ...)
-- which isn't SECURITY DEFINER, so it re-enters ALL of profiles'
-- own SELECT policies on every outer row.
--
-- students_read_same_school, employees_read_same_school, and
-- bus_groups_read_same_school have the identical pattern and were
-- missed. The admin Student Directory query joins students to
-- families, employees, and bus_groups in one request -- so even
-- with families fixed, the same per-row profiles re-lookup on
-- students/employees/bus_groups is enough on its own to blow the
-- statement timeout for schools with a few hundred students.
--
-- Fix: swap all three to the same current_user_is_active_in_school()
-- SECURITY DEFINER STABLE helper introduced in 20260812000001.
--
-- employees also carries a second permissive SELECT policy,
-- employees_sub_manager_read_school (grants read to holders of
-- can_manage_substitutes regardless of role). Postgres evaluates
-- every permissive policy on a table, so left as raw EXISTS this
-- would keep re-triggering the same profiles recursion even after
-- employees_read_same_school is fixed. Adds a matching
-- current_user_can_manage_substitutes() helper for it.
-- ============================================================

CREATE OR REPLACE FUNCTION public.current_user_can_manage_substitutes(target_school_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
    AS $$
  select coalesce(
    bool_or(school_id = target_school_id AND status = 'active' AND can_manage_substitutes = true),
    false
  )
  from profiles
  where user_id = auth.uid();
$$;

DROP POLICY IF EXISTS students_read_same_school ON public.students;
CREATE POLICY students_read_same_school ON public.students
  FOR SELECT USING (public.current_user_is_active_in_school(students.school_id));

DROP POLICY IF EXISTS employees_read_same_school ON public.employees;
CREATE POLICY employees_read_same_school ON public.employees
  FOR SELECT USING (public.current_user_is_active_in_school(employees.school_id));

DROP POLICY IF EXISTS employees_sub_manager_read_school ON public.employees;
CREATE POLICY employees_sub_manager_read_school ON public.employees
  FOR SELECT TO authenticated
  USING (public.current_user_can_manage_substitutes(employees.school_id));

DROP POLICY IF EXISTS bus_groups_read_same_school ON public.bus_groups;
CREATE POLICY bus_groups_read_same_school ON public.bus_groups
  FOR SELECT USING (public.current_user_is_active_in_school(bus_groups.school_id));
