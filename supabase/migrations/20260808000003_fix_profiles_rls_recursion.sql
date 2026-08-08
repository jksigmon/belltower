-- ============================================================
-- Fix: infinite recursion in "Admins can read users in their
-- school" RLS policy on public.profiles.
-- ============================================================
-- 20260808000002 added an inline EXISTS subquery against
-- public.profiles from within a SELECT policy defined on
-- public.profiles itself. Every evaluation of that subquery
-- re-triggers all SELECT policies on profiles, including this
-- one, causing unbounded recursion ("infinite recursion detected
-- in policy for relation \"profiles\"") and 500s on any query
-- touching profiles (and anything whose policies reference
-- profiles, e.g. schools).
--
-- Fix: move the can_manage_requests check into a SECURITY DEFINER
-- function with row_security disabled, matching the existing
-- current_user_can_manage_access() / current_user_school_id()
-- pattern, so the check bypasses RLS instead of re-entering it.
-- ============================================================

CREATE OR REPLACE FUNCTION public.current_user_can_manage_requests() RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
    AS $$
  select
    coalesce(
      bool_or(can_manage_requests),
      false
    )
  from profiles
  where user_id = auth.uid();
$$;

DROP POLICY IF EXISTS "Admins can read users in their school" ON public.profiles;
CREATE POLICY "Admins can read users in their school" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    school_id = public.current_user_school_id()
    AND (
      public.current_user_can_manage_access()
      OR public.current_user_can_manage_requests()
    )
  );
