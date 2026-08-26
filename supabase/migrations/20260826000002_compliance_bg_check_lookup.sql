-- Lets any authenticated staff member check whether a background-check
-- subject is already cleared or already has an in-flight request before
-- submitting a new one, so duplicate requests stop landing in the admin
-- inbox. A plain teacher has no RLS read access to compliance_volunteers
-- (manager/field-trip-manager only) or to other staff's rows in
-- compliance_bg_check_requests (bg_check_staff_read is requestor-scoped),
-- and broadening either policy directly would expose admin_note/contact
-- fields meant for compliance managers only. SECURITY DEFINER + a
-- narrow, hand-picked return shape solves this without widening RLS.

CREATE OR REPLACE FUNCTION public.compliance_bg_check_lookup(
  p_first_name text,
  p_last_name  text,
  p_email      text
)
RETURNS TABLE (
  match_source        text,
  subject_first_name  text,
  subject_last_name   text,
  bg_status            text,
  bg_expires_at       date,
  mvr_status           text,
  mvr_expires_at      date,
  requested_at        timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $$
DECLARE
  v_school_id uuid;
  v_match_key text := public.compliance_volunteer_match_key(p_first_name, p_last_name);
  v_email     text := nullif(lower(trim(p_email)), '');
BEGIN
  SELECT p.school_id INTO v_school_id
  FROM public.profiles p
  WHERE p.user_id = auth.uid() AND p.status = 'active'
  LIMIT 1;

  IF v_school_id IS NULL THEN
    RETURN;
  END IF;

  -- Roster match first -- compliance_volunteers is the authoritative,
  -- most complete record for anyone who has ever cleared BG/MVR.
  RETURN QUERY
  SELECT
    'volunteer'::text,
    v.first_name,
    v.last_name,
    CASE
      WHEN v.bg_cleared_at IS NULL THEN 'none'
      WHEN v.bg_expires_at IS NOT NULL AND v.bg_expires_at < CURRENT_DATE THEN 'expired'
      ELSE 'cleared'
    END,
    v.bg_expires_at,
    CASE
      WHEN v.mvr_cleared_at IS NULL THEN 'none'
      WHEN v.mvr_expires_at IS NOT NULL AND v.mvr_expires_at < CURRENT_DATE THEN 'expired'
      ELSE 'cleared'
    END,
    v.mvr_expires_at,
    NULL::timestamptz
  FROM public.compliance_volunteers v
  WHERE v.school_id = v_school_id
    AND v.archived_at IS NULL
    AND (
      (v_email IS NOT NULL AND lower(v.email) = v_email)
      OR public.compliance_volunteer_match_key(v.first_name, v.last_name) = v_match_key
    )
  ORDER BY (v_email IS NOT NULL AND lower(v.email) = v_email) DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  -- No roster record -- fall back to an in-flight request from anyone
  -- (pending/submitted only; resolved/declined/cancelled ones don't
  -- represent a live duplicate).
  RETURN QUERY
  SELECT
    'request'::text,
    r.subject_first_name,
    r.subject_last_name,
    r.status,
    r.expires_at,
    NULL::text,
    NULL::date,
    r.requested_at
  FROM public.compliance_bg_check_requests r
  WHERE r.school_id = v_school_id
    AND r.archived_at IS NULL
    AND r.status IN ('pending', 'submitted')
    AND (
      (v_email IS NOT NULL AND lower(r.subject_email) = v_email)
      OR public.compliance_volunteer_match_key(r.subject_first_name, r.subject_last_name) = v_match_key
    )
  ORDER BY (v_email IS NOT NULL AND lower(r.subject_email) = v_email) DESC, r.requested_at DESC
  LIMIT 1;
END;
$$;

ALTER FUNCTION public.compliance_bg_check_lookup(text, text, text) OWNER TO postgres;

COMMENT ON FUNCTION public.compliance_bg_check_lookup(text, text, text) IS
  'SECURITY DEFINER: lets any staff member check for an existing cleared volunteer or in-flight request by name/email before submitting a duplicate BG check request. Returns only status/expiry fields -- never admin_note, notes, or contact info.';

REVOKE ALL ON FUNCTION public.compliance_bg_check_lookup(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compliance_bg_check_lookup(text, text, text) TO authenticated;
