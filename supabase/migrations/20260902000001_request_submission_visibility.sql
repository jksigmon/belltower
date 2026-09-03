-- ============================================================
-- Separate request submission oversight from form configuration,
-- and add per-form confidentiality
-- ============================================================
-- 20260724000001_can_manage_requests.sql introduced can_manage_requests to
-- gate form *configuration*, and explicitly left submission visibility alone:
--
--   "sr_select/sr_update still allow any can_access_admin holder to see and
--    update all submissions for school-wide oversight ... Revisit if you
--    also want submission oversight scoped to this permission."
--
-- This is that revisit. Reviewing submissions and building forms turned out
-- to be genuinely different jobs — several people need to triage what comes
-- in without being able to restructure forms school-wide — so this adds a
-- third, independent tier rather than overloading can_manage_requests.
--
-- Three changes:
--
--   1. can_review_all_requests — see and action every submission in the
--      school. Independent of can_manage_requests (build/edit forms) and of
--      being listed as a form's manager (that form's submissions only). Any
--      combination is valid.
--
--   2. Submission oversight now requires is_superadmin or
--      can_review_all_requests. can_access_admin alone is no longer enough:
--      it's granted for unrelated reasons (carline, facilities, front desk),
--      and its holders could read and re-status every submission on every
--      form — including Incident Report — by visiting
--      /app/requests-manage.html directly, even with the nav link hidden.
--      role='admin' is also no longer sufficient on its own; the backfill
--      below grants those users the new flag explicitly instead.
--
--   3. request_categories.is_confidential — when true, ONLY the submitter,
--      that form's assigned managers, and superadmins can read its
--      submissions. can_review_all_requests does not apply. Intended for
--      forms carrying student discipline or other sensitive records (e.g.
--      Office Referral, Incident Report), where "whoever reviews the
--      facilities queue" is the wrong audience.
--
-- NOTE: is_restricted (20260810000003) is a different axis — it controls who
-- can SEE AND SUBMIT a form. is_confidential controls who can READ the
-- resulting submissions. A form can use either, both, or neither.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_review_all_requests boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.can_review_all_requests IS
  'See and action every request submission school-wide. Independent of '
  'can_manage_requests (create/edit forms). Does not grant access to '
  'submissions on forms marked is_confidential.';

-- Backfill: preserve current access for everyone who legitimately has
-- oversight today — superadmins, role='admin', and can_manage_requests
-- holders. Deliberately NOT backfilled for can_access_admin: that grant is
-- the accidental backdoor this migration is closing. If someone in that
-- group genuinely triages submissions, grant them this flag explicitly, or
-- add them as a manager on the specific forms they handle.
--
-- The NOT EXISTS guard makes this a true one-time backfill. Without it, a
-- re-run of this file would silently restore the flag for anyone it had
-- since been revoked from — worth guarding against given migrations here
-- get applied by hand.
UPDATE public.profiles
SET can_review_all_requests = true
WHERE (is_superadmin = true OR role = 'admin' OR can_manage_requests = true)
  AND NOT EXISTS (
    SELECT 1 FROM public.profiles px WHERE px.can_review_all_requests
  );

-- log_permission_changes() (20260727000001) tracks a hardcoded list of
-- permission columns; a new flag is invisible to the audit log until it's
-- added. Re-declared here in full rather than patched, since the function
-- body is the list.
CREATE OR REPLACE FUNCTION public.log_permission_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  old_json jsonb := to_jsonb(OLD);
  new_json jsonb := to_jsonb(NEW);
  tracked_fields text[] := ARRAY[
    'can_login', 'can_access_admin', 'can_manage_access',
    'can_manage_staff', 'can_manage_students', 'can_manage_placement',
    'can_manage_families', 'can_manage_guardians', 'can_manage_bus_groups',
    'can_manage_carpools', 'can_manage_substitutes',
    'can_view_carline', 'can_manage_carline',
    'can_manage_campuses', 'can_manage_calendar',
    'can_manage_resource_docs', 'can_manage_reservations', 'can_manage_inventory',
    'can_manage_licensure', 'can_manage_compliance', 'can_manage_field_trips',
    'can_manage_requests', 'can_review_all_requests',
    'can_bulk_upload', 'can_export_data',
    'can_view_pto_calendar', 'can_review_pto', 'can_approve_pto',
    'can_submit_on_behalf', 'is_fallback_approver',
    'can_adjust_pto', 'can_manage_pto_balances', 'can_generate_pto_reports'
  ];
  field text;
  changer_id uuid;
BEGIN
  SELECT id INTO changer_id FROM public.profiles WHERE user_id = auth.uid();

  FOREACH field IN ARRAY tracked_fields LOOP
    IF old_json -> field IS DISTINCT FROM new_json -> field THEN
      INSERT INTO public.permission_audit_log
        (school_id, target_profile_id, changed_by_profile_id, field_name, old_value, new_value)
      VALUES (
        NEW.school_id, NEW.id, changer_id, field,
        (old_json ->> field)::boolean, (new_json ->> field)::boolean
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

ALTER TABLE public.request_categories
  ADD COLUMN IF NOT EXISTS is_confidential boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.request_categories.is_confidential IS
  'When true, only the submitter, this form''s assigned managers, and '
  'superadmins can read its submissions; can_review_all_requests does '
  'not apply.';


-- ── RLS-bypassing lookup ────────────────────────────────────
-- Reading request_categories from inside staff_requests' policy would
-- re-enter rc_select (and through it, profiles) — the recursion class fixed
-- in 20260808000003 and 20260814000003. SECURITY DEFINER avoids it, matching
-- is_request_category_manager()'s existing pattern.
CREATE OR REPLACE FUNCTION public.is_request_category_confidential(p_category_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(
    (SELECT rc.is_confidential FROM public.request_categories rc WHERE rc.id = p_category_id),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.is_request_category_confidential(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_request_category_confidential(uuid) TO authenticated;

-- The admin panel blocks deleting a form that has submissions. That guard
-- counts staff_requests under RLS, which is now no longer a reliable count:
-- someone with can_manage_requests but not can_review_all_requests reads 0
-- on a confidential form that actually has submissions, so the Delete button
-- appears. The FK on staff_requests.category_id is NO ACTION, so the delete
-- is refused by the database and no data is lost — but the user gets a raw
-- FK error instead of the intended message. This returns the true count
-- without exposing any submission content.
CREATE OR REPLACE FUNCTION public.request_category_submission_count(p_category_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COUNT(*)::integer
  FROM public.staff_requests sr
  WHERE sr.category_id = p_category_id;
$$;

REVOKE ALL ON FUNCTION public.request_category_submission_count(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.request_category_submission_count(uuid) TO authenticated;


-- ── staff_requests ──────────────────────────────────────────

DROP POLICY IF EXISTS sr_select ON public.staff_requests;
CREATE POLICY sr_select ON public.staff_requests FOR SELECT USING (
  school_id = (
    SELECT p.school_id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1
  )
  AND (
    -- your own submission
    submitted_by = (
      SELECT p.id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1
    )
    -- a manager of this specific form
    OR public.is_request_category_manager(category_id, auth.uid())
    -- superadmins see everything, including confidential forms
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.is_superadmin
    )
    -- school-wide reviewers, except on confidential forms
    OR (
      NOT public.is_request_category_confidential(category_id)
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND p.can_review_all_requests
      )
    )
  )
);

DROP POLICY IF EXISTS sr_update ON public.staff_requests;
CREATE POLICY sr_update ON public.staff_requests FOR UPDATE USING (
  school_id = (
    SELECT p.school_id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1
  )
  AND (
    public.is_request_category_manager(category_id, auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.is_superadmin
    )
    OR (
      NOT public.is_request_category_confidential(category_id)
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND p.can_review_all_requests
      )
    )
  )
);
-- Submitters still cannot update their own request (unchanged) — status and
-- manager_notes belong to the reviewer.


-- ── staff_request_responses ─────────────────────────────────
-- The answers themselves. Mirrors sr_select via the parent row, so a
-- confidential form's field values stay unreadable even if someone queries
-- this table directly.

DROP POLICY IF EXISTS srr_select ON public.staff_request_responses;
CREATE POLICY srr_select ON public.staff_request_responses FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.staff_requests sr
    WHERE sr.id = staff_request_responses.request_id
      AND sr.school_id = (
        SELECT p.school_id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1
      )
      AND (
        sr.submitted_by = (
          SELECT p.id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1
        )
        OR public.is_request_category_manager(sr.category_id, auth.uid())
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.user_id = auth.uid() AND p.is_superadmin
        )
        OR (
          NOT public.is_request_category_confidential(sr.category_id)
          AND EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = auth.uid() AND p.can_review_all_requests
          )
        )
      )
  )
);
