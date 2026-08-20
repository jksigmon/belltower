-- ============================================================
-- Two separate bugs found via Performance Advisor's "Auth RLS
-- Initialization Plan" warnings on carline_calls_update_admin,
-- carline_events_delete_admin, bus_groups_delete_admin, and
-- employee_pto_policies' admin-manage policy.
--
-- 1. PERFORMANCE (all four): each calls auth.uid() raw inside the
--    policy, which re-evaluates it per row instead of once per query.
--    Same bug class already fixed for several read policies in
--    20260812000001/20260812000004 (guardians/families/students/
--    employees/bus_groups reads) -- these four write-side policies
--    were missed. Fix: wrap in (select auth.uid()).
--
-- 2. SECURITY (carline_calls_update_admin, carline_events_delete_admin
--    only): these two are missing the school_id scope entirely on
--    their role='admin' and can_manage_carline branches --
--    bus_groups_delete_admin (same table family) has the correct
--    shape for comparison: (role='admin' AND school_id=...) OR
--    (can_manage_bus_groups=true AND school_id=...). As written, any
--    admin or carline manager at ANY school could UPDATE another
--    school's carline_calls or DELETE another school's carline_events
--    -- is_superadmin is meant to be the only cross-school bypass.
-- ============================================================

DROP POLICY IF EXISTS carline_calls_update_admin ON public.carline_calls;
CREATE POLICY carline_calls_update_admin ON public.carline_calls FOR UPDATE USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND (
        p.is_superadmin = true
        OR (p.role = 'admin' AND p.school_id = carline_calls.school_id)
        OR (p.can_manage_carline = true AND p.school_id = carline_calls.school_id)
      )
  )
);

DROP POLICY IF EXISTS carline_events_delete_admin ON public.carline_events;
CREATE POLICY carline_events_delete_admin ON public.carline_events FOR DELETE USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND (
        p.is_superadmin = true
        OR (p.role = 'admin' AND p.school_id = carline_events.school_id)
        OR (p.can_manage_carline = true AND p.school_id = carline_events.school_id)
      )
  )
);

DROP POLICY IF EXISTS bus_groups_delete_admin ON public.bus_groups;
CREATE POLICY bus_groups_delete_admin ON public.bus_groups FOR DELETE USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND (
        p.is_superadmin = true
        OR (p.role = 'admin' AND p.school_id = bus_groups.school_id)
        OR (p.can_manage_bus_groups = true AND p.school_id = bus_groups.school_id)
      )
  )
);

DROP POLICY IF EXISTS "Admins can manage PTO policies for their school" ON public.employee_pto_policies;
CREATE POLICY "Admins can manage PTO policies for their school" ON public.employee_pto_policies
  USING (
    EXISTS ( SELECT 1 FROM public.employees e
      JOIN public.profiles p ON p.user_id = (select auth.uid())
      WHERE e.id = employee_pto_policies.employee_id
        AND e.school_id = p.school_id
        AND p.can_adjust_pto = true
    )
  )
  WITH CHECK (
    EXISTS ( SELECT 1 FROM public.employees e
      JOIN public.profiles p ON p.user_id = (select auth.uid())
      WHERE e.id = employee_pto_policies.employee_id
        AND e.school_id = p.school_id
        AND p.can_adjust_pto = true
    )
  );
