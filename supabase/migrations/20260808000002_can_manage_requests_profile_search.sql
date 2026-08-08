-- ============================================================
-- Fix: can_manage_requests holders can't search staff to add as
-- request managers.
-- ============================================================
-- The can_manage_requests migration (20260724000001) gated the
-- request-manager-configuration UI/tables correctly, but the
-- underlying manager search (admin.requests.js searchManagers(),
-- which queries `profiles` directly by name/email) still requires
-- the unrelated can_manage_access permission via
-- current_user_can_manage_access(). A user with only
-- can_manage_requests can open the config screen but the search
-- silently returns zero rows under RLS.
--
-- Adds an OR branch for can_manage_requests to the existing
-- "Admins can read users in their school" policy. The inline EXISTS
-- subquery (rather than extending current_user_can_manage_access())
-- is safe from RLS recursion here because profiles_read_self /
-- "Users can read their own profile" already unconditionally grant
-- the current user visibility into their own row, independent of
-- this policy.
-- ============================================================

DROP POLICY IF EXISTS "Admins can read users in their school" ON public.profiles;
CREATE POLICY "Admins can read users in their school" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    school_id = public.current_user_school_id()
    AND (
      public.current_user_can_manage_access()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND p.can_manage_requests
      )
    )
  );
