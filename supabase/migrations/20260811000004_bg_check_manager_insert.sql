-- Compliance managers can add a bg_check_requests record directly (no
-- staff requestor behind it -- e.g. a walk-in check or historical data
-- entry). bg_check_staff_insert requires requestor_id to equal the
-- inserting user's own profile id, which fails for these manager-added,
-- requestor_id = NULL rows -- so a separate manager insert policy is
-- needed alongside it.

CREATE POLICY bg_check_manager_insert ON public.compliance_bg_check_requests
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = compliance_bg_check_requests.school_id
        AND (p.can_manage_compliance = true OR p.is_superadmin = true)
    )
  );
