-- Bug: on the Compliance > Requests inbox, the "Requested by" column came
-- back empty for staff-submitted background check requests. The list query
-- in admin.compliance.requests.js embeds the requester as
-- `requestor:profiles!requestor_id(display_name, email)`, and that embed is
-- evaluated under RLS on public.profiles. The compliance page gates on
-- can_manage_compliance (admin.compliance.main.js initPage), but profiles
-- had no SELECT policy keyed to that permission:
--
--   "Admins can read users in their school" -> can_manage_access
--                                              OR can_manage_requests
--   "Category managers can read submitter profiles" -> only people who
--       submitted a staff_request in a category the caller manages
--   profiles_read_self / "Users can read their own profile" -> own row
--
-- So a compliance manager who is not also an access manager or a request
-- manager reads back nothing for other staff's profiles rows, the embed
-- silently drops to null, and every requester renders as missing. The
-- confusing part in practice is that it looks selective rather than total:
-- requesters who happen to have filed a staff request in a category the
-- caller manages resolve fine via the category-manager policy, so a few
-- names show and the rest do not.
--
-- Fix: OR can_manage_compliance into the existing school-scoped admin read
-- policy, exactly as 20260808000002 / 20260808000003 did for
-- can_manage_requests when the Requests module hit this same wall.
--
-- The permission check has to live in a SECURITY DEFINER function with
-- row_security off. Every other can_manage_compliance policy in this schema
-- inlines an `EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid()
-- AND p.can_manage_compliance)` subquery, which is safe on other tables but
-- would be immediate self-recursion here: this policy is defined ON profiles,
-- so an inner scan of profiles re-triggers every SELECT policy on profiles
-- including this one. That is the 42P17 "infinite recursion detected in
-- policy for relation profiles" failure mode of 20260808000003 and
-- 20260814000003, and it takes down every query touching profiles, not just
-- this screen.
--
-- Scope note: this grants compliance managers SELECT on all profiles rows in
-- their own school, all columns, which includes the permission flags. That
-- matches what access managers and request managers already have and is
-- school-scoped by current_user_school_id(), so it does not cross schools.
CREATE OR REPLACE FUNCTION public.current_user_can_manage_compliance()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT coalesce(bool_or(can_manage_compliance), false)
  FROM public.profiles
  WHERE user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.current_user_can_manage_compliance() FROM public;
GRANT EXECUTE ON FUNCTION public.current_user_can_manage_compliance() TO authenticated;

DROP POLICY IF EXISTS "Admins can read users in their school" ON public.profiles;
CREATE POLICY "Admins can read users in their school" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    school_id = public.current_user_school_id()
    AND (
      public.current_user_can_manage_access()
      OR public.current_user_can_manage_requests()
      OR public.current_user_can_manage_compliance()
    )
  );
