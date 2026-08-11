-- pto_ledger / pto_balances write policies only checked profiles.role IN
-- ('admin','hr'), while the frontend (app/pto.js) gates the "adjust
-- balance" UI on profiles.can_adjust_pto. Staff granted can_adjust_pto
-- without an admin/hr role could see the control but had every insert
-- silently rejected by RLS. Bring the policies in line with the granular
-- permission flag the UI already trusts.

DROP POLICY IF EXISTS pto_admin_insert_ledger ON public.pto_ledger;

CREATE POLICY pto_admin_insert_ledger ON public.pto_ledger FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.school_id = pto_ledger.school_id
      AND p.status = 'active'
      AND (p.role = ANY (ARRAY['admin'::text, 'hr'::text]) OR p.can_adjust_pto = true)
  )
);

DROP POLICY IF EXISTS pto_ledger_insert_admin ON public.pto_ledger;

CREATE POLICY pto_ledger_insert_admin ON public.pto_ledger FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (
        p.is_superadmin = true
        OR (p.school_id = pto_ledger.school_id AND p.role = ANY (ARRAY['admin'::text, 'hr'::text]))
        OR (p.school_id = pto_ledger.school_id AND p.can_adjust_pto = true)
      )
  )
);

DROP POLICY IF EXISTS pto_admin_write_balances ON public.pto_balances;

CREATE POLICY pto_admin_write_balances ON public.pto_balances USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.school_id = pto_balances.school_id
      AND (p.role = ANY (ARRAY['admin'::text, 'hr'::text]) OR p.can_adjust_pto = true)
  )
);
