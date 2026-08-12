-- ============================================================
-- Fix: guardians/families reads timing out in production.
--
-- Root cause (found via EXPLAIN ANALYZE against the authenticated role):
-- guardians_read/families_read policies use a raw inline
--   EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() ...)
-- Because that subquery isn't security-definer, it re-triggers ALL of
-- profiles' own SELECT policies -- including "Admins can read users in
-- their school" (added in 20260808000003), which calls
-- current_user_school_id() / current_user_can_manage_access() /
-- current_user_can_manage_requests(). None of those three helpers are
-- marked STABLE, so Postgres can't cache them and re-executes each one
-- (itself a full SELECT against profiles, bypassing RLS via
-- SECURITY DEFINER) on every single outer row. For a school with ~800
-- families and ~1400 guardians, that's thousands of redundant profiles
-- lookups per page load -- 2+ seconds, blowing past the 8s statement
-- timeout under any real load.
--
-- Fix, two parts:
--   1. Mark the three existing helpers STABLE so Postgres can evaluate
--      them once per query instead of once per row.
--   2. Replace guardians'/families' raw EXISTS-on-profiles policies with
--      a new SECURITY DEFINER helper (matching the same bypass-RLS
--      pattern already used elsewhere in this file), so reading
--      guardians/families no longer re-enters profiles' RLS at all.
--
-- Also collapses guardians' two overlapping SELECT policies ("Staff can
-- read guardians in their school" + "same_school_read") into one. Note:
-- the first of those had no `status = 'active'` check -- this closes
-- that (an inactive/suspended profile could previously still read
-- guardian PII via the other, laxer policy). Every other same-school
-- read policy in this schema already requires status = 'active', so
-- this brings guardians in line rather than changing intended behavior.
-- ============================================================

ALTER FUNCTION public.current_user_school_id() STABLE;
ALTER FUNCTION public.current_user_can_manage_access() STABLE;
ALTER FUNCTION public.current_user_can_manage_requests() STABLE;

CREATE OR REPLACE FUNCTION public.current_user_is_active_in_school(target_school_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
    AS $$
  select coalesce(
    bool_or(is_superadmin OR (school_id = target_school_id AND status = 'active')),
    false
  )
  from profiles
  where user_id = auth.uid();
$$;

DROP POLICY IF EXISTS "Staff can read guardians in their school" ON public.guardians;
DROP POLICY IF EXISTS same_school_read ON public.guardians;
CREATE POLICY guardians_read_same_school ON public.guardians
  FOR SELECT USING (public.current_user_is_active_in_school(guardians.school_id));

DROP POLICY IF EXISTS families_read_same_school ON public.families;
CREATE POLICY families_read_same_school ON public.families
  FOR SELECT USING (public.current_user_is_active_in_school(families.school_id));
