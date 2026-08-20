-- ============================================================
-- Perf-only -- all five already correctly scoped (school_id, via a
-- direct column or a join through carpools where carline_tags has
-- none of its own). Same bare auth.uid() re-evaluated-per-row bug as
-- every other fix tonight.
-- ============================================================

DROP POLICY IF EXISTS carpools_read ON public.carpools;
CREATE POLICY carpools_read ON public.carpools
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = (select auth.uid())
              AND p.status = 'active'
              AND p.school_id = carpools.school_id
              AND (p.can_view_carline = true OR p.can_manage_carline = true
                   OR p.can_manage_carpools = true OR p.is_superadmin = true)
        )
    );

DROP POLICY IF EXISTS carpools_admin_write ON public.carpools;
CREATE POLICY carpools_admin_write ON public.carpools
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = (select auth.uid())
              AND p.status = 'active'
              AND (p.is_superadmin = true
                   OR (p.can_manage_carpools = true AND p.school_id = carpools.school_id))
        )
    );

DROP POLICY IF EXISTS carline_tags_read ON public.carline_tags;
CREATE POLICY carline_tags_read ON public.carline_tags
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            JOIN public.carpools c ON c.id = carline_tags.carpool_id
            WHERE p.user_id = (select auth.uid())
              AND p.status = 'active'
              AND p.school_id = c.school_id
              AND (p.can_view_carline = true OR p.can_manage_carline = true
                   OR p.can_manage_carpools = true OR p.is_superadmin = true)
        )
    );

DROP POLICY IF EXISTS carline_tags_admin_write ON public.carline_tags;
CREATE POLICY carline_tags_admin_write ON public.carline_tags
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            JOIN public.carpools c ON c.id = carline_tags.carpool_id
            WHERE p.user_id = (select auth.uid())
              AND p.status = 'active'
              AND (p.is_superadmin = true
                   OR (p.can_manage_carpools = true AND p.school_id = c.school_id))
        )
    );

DROP POLICY IF EXISTS bus_groups_read_same_school ON public.bus_groups;
CREATE POLICY bus_groups_read_same_school ON public.bus_groups FOR SELECT USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND (p.is_superadmin = true OR p.school_id = bus_groups.school_id)
  )
);
