-- pto_admin_update / pto_requests_admin_update only checked
-- role IN ('admin','hr') / is_superadmin, ignoring can_approve_pto even
-- though app/pto.js gates the Approve/Deny UI on can_approve_pto. A manager
-- with can_approve_pto=true but role not in ('admin','hr') would see the
-- buttons but every decision would be silently rejected by RLS. Same shape
-- of bug as carline_calls, fixed the same way (20260810000002).

DROP POLICY IF EXISTS pto_admin_update ON public.pto_requests;
CREATE POLICY pto_admin_update ON public.pto_requests
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = pto_requests.school_id
        AND (p.role = ANY (ARRAY['admin'::text, 'hr'::text]) OR p.can_approve_pto = true)
    )
  );

DROP POLICY IF EXISTS pto_requests_admin_update ON public.pto_requests;
CREATE POLICY pto_requests_admin_update ON public.pto_requests
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND p.school_id = pto_requests.school_id
        AND (p.role = 'admin' OR p.is_superadmin = true OR p.can_approve_pto = true)
    )
  );

-- pto_requests_admin_read (SELECT) has the same gap — the Pending queue
-- would render as empty rather than erroring for a can_approve_pto-only
-- user. Extend it too so loadPto() actually returns rows.
DROP POLICY IF EXISTS pto_requests_admin_read ON public.pto_requests;
CREATE POLICY pto_requests_admin_read ON public.pto_requests
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND p.school_id = pto_requests.school_id
        AND (p.role = 'admin' OR p.is_superadmin = true OR p.can_approve_pto = true)
    )
  );
