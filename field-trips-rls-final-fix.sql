-- ======================================================================
-- Field Trips RLS Final Fix
-- Run this in Supabase SQL editor.
--
-- Problems fixed:
--   1. ftm_select was requiring can_login=true — fails for some profiles
--      and has no superadmin bypass, so managers were invisible in the app.
--   2. ftm_insert had no "add yourself" escape hatch — a regular teacher
--      creating a trip couldn't bootstrap themselves as the first manager.
--   3. Simplified all four policies to be clear and maintainable.
-- ======================================================================

-- ── Ensure helper functions exist ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ft_get_school_id(trip_id uuid)
RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT school_id FROM public.field_trips WHERE id = trip_id;
$$;

CREATE OR REPLACE FUNCTION public.ft_is_manager(trip_id uuid, prof_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.field_trip_managers
    WHERE field_trip_id = trip_id AND profile_id = prof_id
  );
$$;

-- ── Drop and recreate all four policies ───────────────────────────────

DROP POLICY IF EXISTS ftm_select ON public.field_trip_managers;
DROP POLICY IF EXISTS ftm_insert ON public.field_trip_managers;
DROP POLICY IF EXISTS ftm_update ON public.field_trip_managers;
DROP POLICY IF EXISTS ftm_delete ON public.field_trip_managers;

-- SELECT: any authenticated user from the same school (or superadmin).
-- Removed can_login check — auth.uid() existing already proves authentication.
CREATE POLICY ftm_select ON public.field_trip_managers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.is_superadmin = true OR
          p.school_id = public.ft_get_school_id(field_trip_managers.field_trip_id)
        )
    )
  );

-- INSERT: school admin/superadmin, existing manager, OR inserting yourself
-- (self-insert bootstraps a teacher as the first manager on their own trip).
CREATE POLICY ftm_insert ON public.field_trip_managers
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.is_superadmin = true OR
          p.school_id = public.ft_get_school_id(field_trip_managers.field_trip_id)
        )
        AND (
          p.can_manage_field_trips = true
          OR p.is_superadmin = true
          OR public.ft_is_manager(field_trip_managers.field_trip_id, p.id)
          OR field_trip_managers.profile_id = p.id
        )
    )
  );

-- UPDATE: school admin/superadmin or existing manager.
CREATE POLICY ftm_update ON public.field_trip_managers
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.is_superadmin = true OR
          p.school_id = public.ft_get_school_id(field_trip_managers.field_trip_id)
        )
        AND (
          p.can_manage_field_trips = true
          OR p.is_superadmin = true
          OR public.ft_is_manager(field_trip_managers.field_trip_id, p.id)
        )
    )
  );

-- DELETE: school admin/superadmin or existing manager.
CREATE POLICY ftm_delete ON public.field_trip_managers
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.is_superadmin = true OR
          p.school_id = public.ft_get_school_id(field_trip_managers.field_trip_id)
        )
        AND (
          p.can_manage_field_trips = true
          OR p.is_superadmin = true
          OR public.ft_is_manager(field_trip_managers.field_trip_id, p.id)
        )
    )
  );
