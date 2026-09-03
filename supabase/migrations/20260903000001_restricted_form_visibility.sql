-- ============================================================
-- Make "Restrict to specific people" actually mean that
-- ============================================================
-- 20260810000003 gave restricted forms a bypass for anyone with
-- is_superadmin OR can_access_admin. can_access_admin is granted for
-- unrelated reasons (carline, facilities, front desk), so in practice a
-- restricted form was still visible and submittable to a broad group who
-- were never on its list — the same over-broad flag that
-- 20260902000001 moved submission visibility away from.
--
-- The intent of the toggle is narrower: a restricted form should be hidden
-- from the staff Form Requests page entirely, visible and submittable only
-- to the form's managers and the people explicitly listed on it.
--
-- The complication is that rc_select answers two different questions with
-- one policy:
--
--   1. "can this person SUBMIT this form?"  — staff Form Requests page
--   2. "can this person EDIT this form?"    — admin panel Requests tab
--
-- Dropping the admin bypass outright would satisfy (1) and break (2):
-- admins would lose the ability to see, open, or edit the restricted forms
-- they created, since the forms list reads through this same policy.
--
-- So the two are split:
--
--   * rc_select keeps a bypass, but only for people who administer forms
--     (is_superadmin / role='admin' / can_manage_requests) — matching
--     rc_insert/rc_update/rc_delete from 20260724000001. Plain
--     can_access_admin no longer qualifies.
--
--   * sr_insert drops the admin bypass entirely. Submitting to a restricted
--     form requires being a manager of it or on its list, full stop — so an
--     admin can't submit to a form they aren't part of even by posting the
--     category id directly.
--
--   * get_submittable_request_categories() is the staff Form Requests page's
--     list. It applies only the submit rule, with no builder bypass, so a
--     restricted form is hidden there even from admins who can edit it.
--
-- Net effect: managing a form and being able to submit to it are now
-- independent, which is what the toggle's description promises.
-- ============================================================

-- Lets a submitter keep seeing the form's name in their own request history
-- even if they're later removed from the visibility list. Without this, the
-- embedded request_categories join in "My Requests" is filtered out by
-- rc_select and the form name renders as an em dash. SECURITY DEFINER to
-- avoid re-entering staff_requests' policies from inside rc_select.
CREATE OR REPLACE FUNCTION public.has_submitted_to_request_category(p_category_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff_requests sr
    JOIN public.profiles p ON p.id = sr.submitted_by
    WHERE sr.category_id = p_category_id AND p.user_id = p_user_id
  );
$$;

REVOKE ALL ON FUNCTION public.has_submitted_to_request_category(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.has_submitted_to_request_category(uuid, uuid) TO authenticated;


-- ── request_categories: who can see the form definition ─────
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
      -- Form builders, so the admin panel can still list and edit restricted
      -- forms. Deliberately NOT can_access_admin.
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND (p.is_superadmin OR p.role = 'admin' OR p.can_manage_requests)
      )
    )
  );


-- ── staff_requests: who can submit ──────────────────────────
-- No builder bypass. Being able to edit a restricted form does not imply
-- being able to submit to it.
DROP POLICY IF EXISTS sr_insert ON public.staff_requests;
CREATE POLICY sr_insert ON public.staff_requests
  FOR INSERT WITH CHECK (
    school_id = (
      SELECT p.school_id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1
    )
    AND submitted_by = (
      SELECT p.id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1
    )
    AND EXISTS (
      SELECT 1 FROM public.request_categories rc
      WHERE rc.id = staff_requests.category_id
        AND rc.school_id = staff_requests.school_id
        AND rc.is_active
        AND (
          rc.is_restricted = false
          OR public.is_request_category_manager(rc.id, auth.uid())
          OR public.is_request_category_visible_to(rc.id, auth.uid())
        )
    )
  );


-- ── staff Form Requests page list ───────────────────────────
-- Applies the submit rule only. A restricted form is absent here for
-- everyone except its managers and listed people — including admins, who
-- can still edit it from the admin panel.
CREATE OR REPLACE FUNCTION public.get_submittable_request_categories()
RETURNS TABLE (id uuid, name text, description text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT rc.id, rc.name, rc.description
  FROM public.request_categories rc
  WHERE rc.school_id = (
      SELECT p.school_id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1
    )
    AND rc.is_active
    AND (
      rc.is_restricted = false
      OR public.is_request_category_manager(rc.id, auth.uid())
      OR public.is_request_category_visible_to(rc.id, auth.uid())
    )
  ORDER BY rc.name;
$$;

REVOKE ALL ON FUNCTION public.get_submittable_request_categories() FROM public;
GRANT EXECUTE ON FUNCTION public.get_submittable_request_categories() TO authenticated;
