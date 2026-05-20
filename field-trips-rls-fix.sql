-- ======================================================================
-- Field Trips RLS Infinite Recursion Fix
-- Run AFTER field-trips-teachers-migration.sql.
--
-- Problem: ft_select (on field_trips) reads field_trip_managers.
--          ftm_select (on field_trip_managers) joins back to field_trips.
--          → PostgreSQL detects infinite recursion.
--
-- Fix: replace the direct join in ftm_* policies with a SECURITY DEFINER
--      helper function that reads field_trips.school_id without RLS,
--      breaking the cycle.
-- ======================================================================

-- ── Helper function (bypasses RLS on field_trips) ─────────────────────
CREATE OR REPLACE FUNCTION public.ft_get_school_id(trip_id uuid)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT school_id FROM public.field_trips WHERE id = trip_id;
$$;

-- ── Rebuild field_trip_managers policies ──────────────────────────────

DROP POLICY IF EXISTS ftm_select ON public.field_trip_managers;
CREATE POLICY ftm_select ON public.field_trip_managers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = public.ft_get_school_id(field_trip_managers.field_trip_id)
        AND p.can_login = true
    )
  );

DROP POLICY IF EXISTS ftm_insert ON public.field_trip_managers;
CREATE POLICY ftm_insert ON public.field_trip_managers
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = public.ft_get_school_id(field_trip_managers.field_trip_id)
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          EXISTS (
            SELECT 1 FROM public.field_trip_managers m2
            WHERE m2.field_trip_id = field_trip_managers.field_trip_id
              AND m2.profile_id = p.id
          )
        )
    )
  );

DROP POLICY IF EXISTS ftm_delete ON public.field_trip_managers;
CREATE POLICY ftm_delete ON public.field_trip_managers
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = public.ft_get_school_id(field_trip_managers.field_trip_id)
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          EXISTS (
            SELECT 1 FROM public.field_trip_managers m2
            WHERE m2.field_trip_id = field_trip_managers.field_trip_id
              AND m2.profile_id = p.id
          )
        )
    )
  );
