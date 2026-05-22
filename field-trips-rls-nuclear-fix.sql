-- ======================================================================
-- Field Trips RLS Nuclear Fix
-- Eliminates ALL infinite recursion in field_trip_managers policies.
--
-- Root cause: ftm_insert/delete/update policies check whether the
-- current user is already a manager via a direct SELECT on
-- field_trip_managers. That SELECT triggers ftm_select, which (in the
-- original version) JOINs field_trips, which triggers ft_select, which
-- reads field_trip_managers → infinite recursion (42P17).
--
-- Fix: introduce ft_is_manager() SECURITY DEFINER function that reads
-- field_trip_managers WITHOUT triggering any RLS policy. Use it in
-- all ftm_* policies instead of the self-referential subquery.
-- ======================================================================

-- ── 1. Helper functions (both SECURITY DEFINER — bypass RLS) ──────────

CREATE OR REPLACE FUNCTION public.ft_get_school_id(trip_id uuid)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT school_id FROM public.field_trips WHERE id = trip_id;
$$;

CREATE OR REPLACE FUNCTION public.ft_is_manager(trip_id uuid, prof_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.field_trip_managers
    WHERE field_trip_id = trip_id AND profile_id = prof_id
  );
$$;

-- ── 2. Drop ALL existing policies on field_trip_managers ──────────────

DROP POLICY IF EXISTS ftm_select ON public.field_trip_managers;
DROP POLICY IF EXISTS ftm_insert ON public.field_trip_managers;
DROP POLICY IF EXISTS ftm_update ON public.field_trip_managers;
DROP POLICY IF EXISTS ftm_delete ON public.field_trip_managers;

-- ── 3. Recreate all policies using SECURITY DEFINER helpers only ──────

-- Any logged-in staff at the school can read
CREATE POLICY ftm_select ON public.field_trip_managers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = public.ft_get_school_id(field_trip_managers.field_trip_id)
        AND p.can_login = true
    )
  );

-- Admin/superadmin, or existing manager (ft_is_manager bypasses RLS)
CREATE POLICY ftm_insert ON public.field_trip_managers
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = public.ft_get_school_id(field_trip_managers.field_trip_id)
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          public.ft_is_manager(field_trip_managers.field_trip_id, p.id)
        )
    )
  );

CREATE POLICY ftm_update ON public.field_trip_managers
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = public.ft_get_school_id(field_trip_managers.field_trip_id)
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          public.ft_is_manager(field_trip_managers.field_trip_id, p.id)
        )
    )
  );

CREATE POLICY ftm_delete ON public.field_trip_managers
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = public.ft_get_school_id(field_trip_managers.field_trip_id)
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          public.ft_is_manager(field_trip_managers.field_trip_id, p.id)
        )
    )
  );
