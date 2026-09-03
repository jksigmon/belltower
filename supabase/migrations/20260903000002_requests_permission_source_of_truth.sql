-- ============================================================
-- can_manage_requests is the single source of truth for form config
-- ============================================================
-- Two leftovers made the "Manage request forms" checkbox not actually
-- control form management:
--
--   1. role = 'admin' was accepted on its own by every form-config policy
--      (20260724000001). Unchecking the permission for a role='admin' user
--      removed their nav link but the database still let them create, edit,
--      and delete forms and reassign managers. The checkbox looked like it
--      did something it didn't.
--
--   2. The request_category_visibility policies (20260810000003) still keyed
--      off can_access_admin. That flag is granted for unrelated reasons
--      (carline, facilities, front desk), and it let its holders insert
--      themselves into any restricted form's visibility list — which makes
--      is_request_category_visible_to() true and hands back exactly the
--      access 20260903000001 had just removed. The front door was locked
--      and this window left open.
--
-- Both now test is_superadmin OR can_manage_requests, and nothing else.
-- Managing forms is a permission you grant, not something inherited from a
-- role or from general admin-panel access. is_superadmin is retained
-- throughout as cross-school platform access; it is not a school-level
-- permission and is not surfaced in the UI.
--
-- Submissions are unaffected — those are governed by can_review_all_requests
-- and form membership (20260902000001), and never accepted role='admin'.
--
-- BEFORE RUNNING: anyone who relied on role='admin' to manage forms needs
-- can_manage_requests granted explicitly, or they lose access. See the
-- audit query in the accompanying notes.
-- ============================================================

-- ── request_categories ──────────────────────────────────────

DROP POLICY IF EXISTS rc_insert ON public.request_categories;
CREATE POLICY rc_insert ON public.request_categories FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.is_superadmin OR p.can_manage_requests)
      AND p.school_id = request_categories.school_id
  )
);

DROP POLICY IF EXISTS rc_update ON public.request_categories;
CREATE POLICY rc_update ON public.request_categories FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.is_superadmin OR p.can_manage_requests)
      AND p.school_id = request_categories.school_id
  )
);

DROP POLICY IF EXISTS rc_delete ON public.request_categories;
CREATE POLICY rc_delete ON public.request_categories FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.is_superadmin OR p.can_manage_requests)
      AND p.school_id = request_categories.school_id
  )
);

-- Seeing a restricted form's definition: same builder set, minus role.
DROP POLICY IF EXISTS rc_select ON public.request_categories;
CREATE POLICY rc_select ON public.request_categories
  FOR SELECT USING (
    school_id = (
      SELECT p.school_id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1
    )
    AND (
      is_restricted = false
      OR public.is_request_category_manager(request_categories.id, auth.uid())
      OR public.is_request_category_visible_to(request_categories.id, auth.uid())
      OR public.has_submitted_to_request_category(request_categories.id, auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND (p.is_superadmin OR p.can_manage_requests)
      )
    )
  );


-- ── request_category_fields ─────────────────────────────────

DROP POLICY IF EXISTS rcf_insert ON public.request_category_fields;
CREATE POLICY rcf_insert ON public.request_category_fields FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.request_categories rc
    JOIN public.profiles p ON p.user_id = auth.uid()
    WHERE rc.id = request_category_fields.category_id
      AND rc.school_id = p.school_id
      AND (p.is_superadmin OR p.can_manage_requests)
  )
);

DROP POLICY IF EXISTS rcf_update ON public.request_category_fields;
CREATE POLICY rcf_update ON public.request_category_fields FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM public.request_categories rc
    JOIN public.profiles p ON p.user_id = auth.uid()
    WHERE rc.id = request_category_fields.category_id
      AND rc.school_id = p.school_id
      AND (p.is_superadmin OR p.can_manage_requests)
  )
);

DROP POLICY IF EXISTS rcf_delete ON public.request_category_fields;
CREATE POLICY rcf_delete ON public.request_category_fields FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.request_categories rc
    JOIN public.profiles p ON p.user_id = auth.uid()
    WHERE rc.id = request_category_fields.category_id
      AND rc.school_id = p.school_id
      AND (p.is_superadmin OR p.can_manage_requests)
  )
);


-- ── request_category_managers ───────────────────────────────

DROP POLICY IF EXISTS rcm_insert ON public.request_category_managers;
CREATE POLICY rcm_insert ON public.request_category_managers FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.request_categories rc
    JOIN public.profiles p ON p.user_id = auth.uid()
    WHERE rc.id = request_category_managers.category_id
      AND rc.school_id = p.school_id
      AND (p.is_superadmin OR p.can_manage_requests)
  )
);

DROP POLICY IF EXISTS rcm_delete ON public.request_category_managers;
CREATE POLICY rcm_delete ON public.request_category_managers FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.request_categories rc
    JOIN public.profiles p ON p.user_id = auth.uid()
    WHERE rc.id = request_category_managers.category_id
      AND rc.school_id = p.school_id
      AND (p.is_superadmin OR p.can_manage_requests)
  )
);

-- Builders see every manager row; everyone else sees only their own, which
-- is what the Request Manager page needs to list the forms it manages.
DROP POLICY IF EXISTS rcm_select ON public.request_category_managers;
CREATE POLICY rcm_select ON public.request_category_managers FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (
        p.is_superadmin
        OR p.can_manage_requests
        OR request_category_managers.profile_id = p.id
      )
  )
);


-- ── request_category_visibility ─────────────────────────────
-- Closes the self-add hole: can_access_admin no longer edits these lists.

DROP POLICY IF EXISTS rcv_insert ON public.request_category_visibility;
CREATE POLICY rcv_insert ON public.request_category_visibility FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.request_categories rc
    JOIN public.profiles p ON p.user_id = auth.uid()
    WHERE rc.id = request_category_visibility.category_id
      AND rc.school_id = p.school_id
      AND (p.is_superadmin OR p.can_manage_requests)
  )
);

DROP POLICY IF EXISTS rcv_delete ON public.request_category_visibility;
CREATE POLICY rcv_delete ON public.request_category_visibility FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.request_categories rc
    JOIN public.profiles p ON p.user_id = auth.uid()
    WHERE rc.id = request_category_visibility.category_id
      AND rc.school_id = p.school_id
      AND (p.is_superadmin OR p.can_manage_requests)
  )
);

DROP POLICY IF EXISTS rcv_select ON public.request_category_visibility;
CREATE POLICY rcv_select ON public.request_category_visibility FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (
        p.is_superadmin
        OR p.can_manage_requests
        OR request_category_visibility.profile_id = p.id
      )
  )
);
