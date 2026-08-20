-- ============================================================
-- Follow-up to 20260819000002. That migration fixed
-- carline_calls_update_admin and carline_events_delete_admin, but a
-- full sweep of every "role = 'admin'" occurrence in the schema found
-- FOUR more policies on the same two tables with the identical bug --
-- missed because the Performance Advisor only surfaced them one
-- screenshot at a time and these four hadn't been shown yet:
--
--   carline_calls_delete_admin   -- bare, no school_id check
--   carline_calls_insert_admin   -- bare, no school_id check
--   carline_events_insert_admin  -- bare, no school_id check
--   carline_events_update_admin  -- bare, no school_id check
--
-- Same vulnerability as before: any admin or carline manager at ANY
-- school could delete/insert/update another school's carline_calls or
-- carline_events rows. Also fixes bus_groups_insert_admin, which has
-- the same bare pattern (any admin at any school could insert a bus
-- group tagged to a different school), plus the perf-only wrap on the
-- three remaining correctly-scoped bus_groups policies flagged by the
-- advisor (update_admin, insert_manage_bus_groups,
-- update_manage_bus_groups).
--
-- NOTE: employees_insert_admin, families_insert_admin, and
-- students_insert_admin have this exact same bare pattern too --
-- left out of this migration deliberately, out of tonight's carline/
-- bus_groups scope. Still open.
-- ============================================================

DROP POLICY IF EXISTS carline_calls_delete_admin ON public.carline_calls;
CREATE POLICY carline_calls_delete_admin ON public.carline_calls FOR DELETE USING (
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

DROP POLICY IF EXISTS carline_calls_insert_admin ON public.carline_calls;
CREATE POLICY carline_calls_insert_admin ON public.carline_calls FOR INSERT WITH CHECK (
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

DROP POLICY IF EXISTS carline_events_insert_admin ON public.carline_events;
CREATE POLICY carline_events_insert_admin ON public.carline_events FOR INSERT WITH CHECK (
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

DROP POLICY IF EXISTS carline_events_update_admin ON public.carline_events;
CREATE POLICY carline_events_update_admin ON public.carline_events FOR UPDATE USING (
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

DROP POLICY IF EXISTS bus_groups_insert_admin ON public.bus_groups;
CREATE POLICY bus_groups_insert_admin ON public.bus_groups FOR INSERT WITH CHECK (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND (
        p.is_superadmin = true
        OR (p.role = 'admin' AND p.school_id = bus_groups.school_id)
      )
  )
);

DROP POLICY IF EXISTS bus_groups_update_admin ON public.bus_groups;
CREATE POLICY bus_groups_update_admin ON public.bus_groups FOR UPDATE USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND (
        p.is_superadmin = true
        OR (p.role = 'admin' AND p.school_id = bus_groups.school_id)
      )
  )
) WITH CHECK (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND (
        p.is_superadmin = true
        OR (p.role = 'admin' AND p.school_id = bus_groups.school_id)
      )
  )
);

DROP POLICY IF EXISTS bus_groups_insert_manage_bus_groups ON public.bus_groups;
CREATE POLICY bus_groups_insert_manage_bus_groups ON public.bus_groups FOR INSERT WITH CHECK (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND p.school_id = bus_groups.school_id
      AND p.can_manage_bus_groups = true
  )
);

DROP POLICY IF EXISTS bus_groups_update_manage_bus_groups ON public.bus_groups;
CREATE POLICY bus_groups_update_manage_bus_groups ON public.bus_groups FOR UPDATE USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND p.school_id = bus_groups.school_id
      AND p.can_manage_bus_groups = true
  )
) WITH CHECK (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND p.school_id = bus_groups.school_id
      AND p.can_manage_bus_groups = true
  )
);
