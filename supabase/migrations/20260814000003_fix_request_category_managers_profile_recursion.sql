-- ======================================================================
-- Hotfix: "Category managers can read submitter profiles" (added in
-- 20260814000002) caused infinite recursion (42P17) on every query
-- against public.profiles, everywhere -- not just Request Manager.
--
-- Two problems, both variants of the same mistake this repo already hit
-- once in 20260808000003:
--
--   1. The policy's USING clause directly joined "public.profiles me"
--      from within a policy defined ON public.profiles. That inner scan
--      is itself subject to every SELECT policy on profiles, including
--      this one -- immediate self-recursion.
--
--   2. Less obviously: even after removing the direct self-join, the
--      policy still queries staff_requests and request_category_managers
--      to find the caller's managed categories -- and *those* tables'
--      own RLS policies (sr_select, rcm_select) each run their own
--      un-bypassed "FROM profiles WHERE profiles.user_id = auth.uid()"
--      subquery. So evaluating the profiles policy re-enters
--      staff_requests' policy, which re-enters profiles' policies
--      (including this one) again -- a cross-table cycle with the same
--      "infinite recursion detected in policy for relation profiles"
--      symptom.
--
-- Fix: wrap the entire check (the caller's own profile id lookup *and*
-- the staff_requests/request_category_managers lookups) in one
-- SECURITY DEFINER function with row_security disabled, so nothing it
-- touches re-enters RLS -- same pattern as current_user_school_id() /
-- current_user_can_manage_requests() from 20260808000003, just applied
-- to the whole check instead of one piece of it.
-- ======================================================================

CREATE OR REPLACE FUNCTION public.current_user_profile_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT id
  FROM public.profiles
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.current_user_profile_id() FROM public;
GRANT EXECUTE ON FUNCTION public.current_user_profile_id() TO authenticated;

CREATE OR REPLACE FUNCTION public.current_user_manages_submitter(p_submitter_profile_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff_requests sr
    JOIN public.request_category_managers rcm ON rcm.category_id = sr.category_id
    WHERE sr.submitted_by = p_submitter_profile_id
      AND rcm.profile_id = public.current_user_profile_id()
  );
$$;

REVOKE ALL ON FUNCTION public.current_user_manages_submitter(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.current_user_manages_submitter(uuid) TO authenticated;

DROP POLICY IF EXISTS "Category managers can read submitter profiles" ON public.profiles;
CREATE POLICY "Category managers can read submitter profiles" ON public.profiles
  FOR SELECT
  USING (public.current_user_manages_submitter(profiles.id));
