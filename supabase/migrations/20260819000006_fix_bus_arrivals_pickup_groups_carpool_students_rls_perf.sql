-- ============================================================
-- Perf-only -- all seven confirmed correctly scoped by school_id via
-- pg_policies (these three tables are missing from schema.sql
-- entirely, so this couldn't be checked from the file). Same bare
-- auth.uid() re-evaluated-per-row bug as everything else tonight.
-- ============================================================

DROP POLICY IF EXISTS carline_bus_arrivals_insert ON public.carline_bus_arrivals;
CREATE POLICY carline_bus_arrivals_insert ON public.carline_bus_arrivals FOR INSERT WITH CHECK (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.school_id = carline_bus_arrivals.school_id
      AND p.status = 'active'
      AND (p.is_superadmin = true OR p.can_manage_carline = true)
  )
);

DROP POLICY IF EXISTS carline_bus_arrivals_select ON public.carline_bus_arrivals;
CREATE POLICY carline_bus_arrivals_select ON public.carline_bus_arrivals FOR SELECT USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.school_id = carline_bus_arrivals.school_id
      AND p.status = 'active'
      AND (p.is_superadmin = true OR p.can_view_carline = true)
  )
);

DROP POLICY IF EXISTS carline_bus_arrivals_update ON public.carline_bus_arrivals;
CREATE POLICY carline_bus_arrivals_update ON public.carline_bus_arrivals FOR UPDATE USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND p.school_id = carline_bus_arrivals.school_id
      AND (p.is_superadmin = true OR p.can_manage_carline = true)
  )
);

DROP POLICY IF EXISTS carline_pickup_groups_manage ON public.carline_pickup_groups;
CREATE POLICY carline_pickup_groups_manage ON public.carline_pickup_groups FOR ALL USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND p.school_id = carline_pickup_groups.school_id
      AND (p.can_manage_carline OR p.is_superadmin)
  )
);

DROP POLICY IF EXISTS carline_pickup_groups_read ON public.carline_pickup_groups;
CREATE POLICY carline_pickup_groups_read ON public.carline_pickup_groups FOR SELECT USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND p.school_id = carline_pickup_groups.school_id
      AND (p.can_view_carline OR p.can_manage_carline OR p.is_superadmin)
  )
);

DROP POLICY IF EXISTS carpool_students_admin_write ON public.carpool_students;
CREATE POLICY carpool_students_admin_write ON public.carpool_students FOR ALL USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    JOIN public.carpools c ON c.id = carpool_students.carpool_id
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND (p.is_superadmin = true OR (p.can_manage_carpools = true AND p.school_id = c.school_id))
  )
);

DROP POLICY IF EXISTS carpool_students_read ON public.carpool_students;
CREATE POLICY carpool_students_read ON public.carpool_students FOR SELECT USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    JOIN public.carpools c ON c.id = carpool_students.carpool_id
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND p.school_id = c.school_id
      AND (p.can_view_carline = true OR p.can_manage_carline = true
           OR p.can_manage_carpools = true OR p.is_superadmin = true)
  )
);
