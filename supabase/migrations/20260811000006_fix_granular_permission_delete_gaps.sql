-- Same bug class as 20260811000005 (pto_ledger/pto_balances honoring
-- can_adjust_pto): several tables have insert/update RLS policies that
-- correctly check a granular profiles.can_manage_x flag, but the DELETE
-- policy (and, for carline_calls, all three write policies) was never
-- updated to match and only checks role = 'admin' / is_superadmin. Users
-- granted the granular flag see the delete/action UI but get silently
-- rejected by RLS.

DROP POLICY IF EXISTS students_delete_admin ON public.students;

CREATE POLICY students_delete_admin ON public.students FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (
        p.is_superadmin = true
        OR (p.role = 'admin' AND p.school_id = students.school_id)
        OR (p.can_manage_students = true AND p.school_id = students.school_id)
      )
  )
);

DROP POLICY IF EXISTS families_delete_admin ON public.families;

CREATE POLICY families_delete_admin ON public.families FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (
        p.is_superadmin = true
        OR (p.role = 'admin' AND p.school_id = families.school_id)
        OR (p.can_manage_families = true AND p.school_id = families.school_id)
      )
  )
);

DROP POLICY IF EXISTS employees_delete_admin ON public.employees;

CREATE POLICY employees_delete_admin ON public.employees FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (
        p.is_superadmin = true
        OR (p.role = 'admin' AND p.school_id = employees.school_id)
        OR (p.can_manage_staff = true AND p.school_id = employees.school_id)
      )
  )
);

DROP POLICY IF EXISTS bus_groups_delete_admin ON public.bus_groups;

CREATE POLICY bus_groups_delete_admin ON public.bus_groups FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (
        p.is_superadmin = true
        OR (p.role = 'admin' AND p.school_id = bus_groups.school_id)
        OR (p.can_manage_bus_groups = true AND p.school_id = bus_groups.school_id)
      )
  )
);

DROP POLICY IF EXISTS carline_events_delete_admin ON public.carline_events;

CREATE POLICY carline_events_delete_admin ON public.carline_events FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (p.is_superadmin = true OR p.role = 'admin' OR p.can_manage_carline = true)
  )
);

-- carline_calls had no can_manage_carline check on any write policy at all
DROP POLICY IF EXISTS carline_calls_insert_admin ON public.carline_calls;

CREATE POLICY carline_calls_insert_admin ON public.carline_calls FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (p.is_superadmin = true OR p.role = 'admin' OR p.can_manage_carline = true)
  )
);

DROP POLICY IF EXISTS carline_calls_update_admin ON public.carline_calls;

CREATE POLICY carline_calls_update_admin ON public.carline_calls FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (p.is_superadmin = true OR p.role = 'admin' OR p.can_manage_carline = true)
  )
);

DROP POLICY IF EXISTS carline_calls_delete_admin ON public.carline_calls;

CREATE POLICY carline_calls_delete_admin ON public.carline_calls FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (p.is_superadmin = true OR p.role = 'admin' OR p.can_manage_carline = true)
  )
);
