-- compliance_bg_check_lookup previously stopped at the first
-- compliance_volunteers match and never checked for an in-flight request,
-- so a volunteer who's on the roster but not yet cleared (bg_cleared_at
-- IS NULL) always got the generic "already in the volunteer roster, but
-- not yet cleared" message, even when they have an actual pending or
-- submitted request sitting in compliance_bg_check_requests (commonly
-- true, since a volunteer row is usually created by linking a request
-- before it's cleared). Staff asked for the popup to say pending,
-- submitted, or cleared specifically, not a vague roster status.
--
-- Fix: when the volunteer's bg_cleared_at is null, also look for their
-- most recent open request (by volunteer_id link first, falling back to
-- email/name match same as the standalone-request branch) and report
-- that status instead.

DROP FUNCTION IF EXISTS public.compliance_bg_check_lookup(text, text, text);

CREATE FUNCTION public.compliance_bg_check_lookup(
  p_first_name text,
  p_last_name  text,
  p_email      text
)
RETURNS TABLE (
  match_source        text,
  match_basis         text,
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
  v_volunteer public.compliance_volunteers%ROWTYPE;
  v_bg_status text;
  v_mvr_status text;
  v_match_source text;
  v_open_status text;
  v_open_requested_at timestamptz;
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
  SELECT v.* INTO v_volunteer
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
    v_bg_status := CASE
      WHEN v_volunteer.bg_cleared_at IS NULL THEN 'none'
      WHEN v_volunteer.bg_expires_at IS NOT NULL AND v_volunteer.bg_expires_at < CURRENT_DATE THEN 'expired'
      ELSE 'cleared'
    END;
    v_mvr_status := CASE
      WHEN v_volunteer.mvr_cleared_at IS NULL THEN 'none'
      WHEN v_volunteer.mvr_expires_at IS NOT NULL AND v_volunteer.mvr_expires_at < CURRENT_DATE THEN 'expired'
      ELSE 'cleared'
    END;
    v_open_requested_at := NULL;
    v_match_source := 'volunteer';

    -- Not cleared/expired -- there's nothing informative to report from
    -- the roster row alone, so check whether an actual request is
    -- already in flight for this person before falling back to a vague
    -- "not yet cleared" message. Reporting it as match_source = 'request'
    -- (rather than 'volunteer') reuses the caller's existing "A
    -- pending/submitted background check request ... already exists"
    -- message, which spells out the status in plain words -- the
    -- 'volunteer' branch's message only ever handles cleared/expired.
    IF v_bg_status = 'none' THEN
      SELECT r.status, r.requested_at INTO v_open_status, v_open_requested_at
      FROM public.compliance_bg_check_requests r
      WHERE r.school_id = v_school_id
        AND r.archived_at IS NULL
        AND r.status IN ('pending', 'submitted')
        AND (
          r.volunteer_id = v_volunteer.id
          OR (v_email IS NOT NULL AND lower(r.subject_email) = v_email)
          OR public.compliance_volunteer_match_key(r.subject_first_name, r.subject_last_name) = v_match_key
        )
      ORDER BY r.requested_at DESC
      LIMIT 1;

      IF FOUND THEN
        v_bg_status := v_open_status;
        v_match_source := 'request';
      END IF;
    END IF;

    RETURN QUERY
    SELECT
      v_match_source,
      CASE WHEN v_email IS NOT NULL AND lower(v_volunteer.email) = v_email THEN 'email' ELSE 'name' END,
      v_volunteer.first_name,
      v_volunteer.last_name,
      v_bg_status,
      v_volunteer.bg_expires_at,
      v_mvr_status,
      v_volunteer.mvr_expires_at,
      v_open_requested_at;
    RETURN;
  END IF;

  -- No roster record -- fall back to an in-flight request from anyone
  -- (pending/submitted only; resolved/declined/cancelled ones don't
  -- represent a live duplicate).
  RETURN QUERY
  SELECT
    'request'::text,
    CASE WHEN v_email IS NOT NULL AND lower(r.subject_email) = v_email THEN 'email' ELSE 'name' END,
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
  'SECURITY DEFINER: lets any staff member check for an existing cleared volunteer or in-flight request by name/email before submitting a duplicate BG check request. Returns only status/expiry fields -- never admin_note, notes, or contact info. match_basis (''email''|''name'') distinguishes an exact-email hit from a name-only match so the caller can hard-block only on the stronger signal. A volunteer roster match with no clearance yet is reported as match_source = ''request'' (not ''volunteer'') if an open pending/submitted request is found for them, so the caller can surface that status by name instead of a generic "not yet cleared" message.';

REVOKE ALL ON FUNCTION public.compliance_bg_check_lookup(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compliance_bg_check_lookup(text, text, text) TO authenticated;
