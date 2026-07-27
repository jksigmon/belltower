-- ============================================================
-- can_manage_requests permission
-- ============================================================
-- Previously, creating/editing request categories (forms), their
-- fields, and assigning category managers was gated purely by
-- (is_superadmin OR can_access_admin) — meaning anyone granted
-- admin-panel access for ANY reason (e.g. Carline-only front desk
-- staff) could also fully reconfigure request routing school-wide.
-- This adds a dedicated permission, matching the pattern already
-- used elsewhere (e.g. resource_docs_write: role = 'admin' OR a
-- specific can_manage_* flag).
--
-- Submission visibility/updates (staff_requests table) are NOT
-- changed here — sr_select/sr_update still allow any can_access_admin
-- holder to see and update all submissions for school-wide oversight,
-- separate from who can reconfigure the forms themselves. Revisit if
-- you also want submission oversight scoped to this permission.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_requests boolean NOT NULL DEFAULT false;

-- Backfill: preserve current access for everyone who has it today (anyone
-- who could already manage requests via can_access_admin keeps that ability).
-- Going forward, a NEW can_access_admin grant does NOT automatically include
-- this — it must be granted explicitly, which is the whole point of this
-- migration. If you'd rather immediately tighten this for existing users
-- too, skip this UPDATE (or change the WHERE clause) before running.
UPDATE public.profiles
SET can_manage_requests = true
WHERE is_superadmin = true OR can_access_admin = true;


-- ── request_categories ──────────────────────────────────────
DROP POLICY IF EXISTS rc_insert ON public.request_categories;
CREATE POLICY rc_insert ON public.request_categories FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.is_superadmin OR p.role = 'admin' OR p.can_manage_requests)
      AND p.school_id = request_categories.school_id
  )
);

DROP POLICY IF EXISTS rc_update ON public.request_categories;
CREATE POLICY rc_update ON public.request_categories FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.is_superadmin OR p.role = 'admin' OR p.can_manage_requests)
      AND p.school_id = request_categories.school_id
  )
);

DROP POLICY IF EXISTS rc_delete ON public.request_categories;
CREATE POLICY rc_delete ON public.request_categories FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.is_superadmin OR p.role = 'admin' OR p.can_manage_requests)
      AND p.school_id = request_categories.school_id
  )
);
-- rc_select is unchanged: any staff member in the school can see active
-- categories/forms in order to submit a request against them.


-- ── request_category_fields ─────────────────────────────────
DROP POLICY IF EXISTS rcf_insert ON public.request_category_fields;
CREATE POLICY rcf_insert ON public.request_category_fields FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.request_categories rc
    JOIN public.profiles p ON p.user_id = auth.uid()
    WHERE rc.id = request_category_fields.category_id
      AND rc.school_id = p.school_id
      AND (p.is_superadmin OR p.role = 'admin' OR p.can_manage_requests)
  )
);

DROP POLICY IF EXISTS rcf_update ON public.request_category_fields;
CREATE POLICY rcf_update ON public.request_category_fields FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM public.request_categories rc
    JOIN public.profiles p ON p.user_id = auth.uid()
    WHERE rc.id = request_category_fields.category_id
      AND rc.school_id = p.school_id
      AND (p.is_superadmin OR p.role = 'admin' OR p.can_manage_requests)
  )
);

DROP POLICY IF EXISTS rcf_delete ON public.request_category_fields;
CREATE POLICY rcf_delete ON public.request_category_fields FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.request_categories rc
    JOIN public.profiles p ON p.user_id = auth.uid()
    WHERE rc.id = request_category_fields.category_id
      AND rc.school_id = p.school_id
      AND (p.is_superadmin OR p.role = 'admin' OR p.can_manage_requests)
  )
);
-- rcf_select is unchanged, same reasoning as rc_select.


-- ── request_category_managers ───────────────────────────────
DROP POLICY IF EXISTS rcm_insert ON public.request_category_managers;
CREATE POLICY rcm_insert ON public.request_category_managers FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.request_categories rc
    JOIN public.profiles p ON p.user_id = auth.uid()
    WHERE rc.id = request_category_managers.category_id
      AND rc.school_id = p.school_id
      AND (p.is_superadmin OR p.role = 'admin' OR p.can_manage_requests)
  )
);

DROP POLICY IF EXISTS rcm_delete ON public.request_category_managers;
CREATE POLICY rcm_delete ON public.request_category_managers FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.request_categories rc
    JOIN public.profiles p ON p.user_id = auth.uid()
    WHERE rc.id = request_category_managers.category_id
      AND rc.school_id = p.school_id
      AND (p.is_superadmin OR p.role = 'admin' OR p.can_manage_requests)
  )
);

DROP POLICY IF EXISTS rcm_select ON public.request_category_managers;
CREATE POLICY rcm_select ON public.request_category_managers FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (
        p.is_superadmin OR p.role = 'admin' OR p.can_manage_requests
        OR request_category_managers.profile_id = p.id
      )
  )
);
