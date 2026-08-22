-- ============================================================
-- Advisor: "Licenses: admin delete" re-evaluates auth.uid() per
-- row. Same bare auth.uid() re-evaluated-per-row bug as the
-- substitutes fix (20260822000001). All five staff_licenses
-- policies share the pattern, so fixing them together rather
-- than waiting for the advisor to flag each separately.
-- ============================================================

DROP POLICY IF EXISTS "Licenses: admin delete" ON public.staff_licenses;
CREATE POLICY "Licenses: admin delete" ON public.staff_licenses FOR DELETE USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.school_id = staff_licenses.school_id
      AND (p.is_superadmin OR p.can_manage_licensure) )
);

DROP POLICY IF EXISTS "Licenses: admin insert" ON public.staff_licenses;
CREATE POLICY "Licenses: admin insert" ON public.staff_licenses FOR INSERT WITH CHECK (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.school_id = staff_licenses.school_id
      AND (p.is_superadmin OR p.can_manage_licensure) )
);

DROP POLICY IF EXISTS "Licenses: admin select" ON public.staff_licenses;
CREATE POLICY "Licenses: admin select" ON public.staff_licenses FOR SELECT USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.school_id = staff_licenses.school_id
      AND (p.is_superadmin OR p.can_manage_licensure) )
);

DROP POLICY IF EXISTS "Licenses: admin update" ON public.staff_licenses;
CREATE POLICY "Licenses: admin update" ON public.staff_licenses FOR UPDATE USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.school_id = staff_licenses.school_id
      AND (p.is_superadmin OR p.can_manage_licensure) )
);

DROP POLICY IF EXISTS "Licenses: staff own select" ON public.staff_licenses;
CREATE POLICY "Licenses: staff own select" ON public.staff_licenses FOR SELECT USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.employee_id = staff_licenses.employee_id )
);
