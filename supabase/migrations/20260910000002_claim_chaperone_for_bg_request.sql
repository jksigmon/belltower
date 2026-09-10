-- Lets a teacher claim a field trip chaperone slot for someone whose BG
-- check request is still pending/submitted -- before a compliance manager
-- resolves it. The teacher gets an immediate placeholder chaperone row
-- (no BG/MVR clearance yet, so it reads as Blocked/Pending in the
-- Chaperones tab, same as any other unresolved volunteer) instead of
-- having no way to reserve the spot or see status until someone with
-- can_manage_compliance gets around to Mark Cleared.
--
-- compliance_volunteers has no write policy for can_manage_field_trips
-- (only compliance_volunteers_manager, gated on can_manage_compliance --
-- see 20260812000002_compliance_volunteers.sql), and
-- compliance_bg_check_requests write policies are similarly gated on
-- can_manage_compliance or the original requestor. Rather than widen
-- either of those RLS policies (which would let any field trip manager
-- write arbitrary BG/MVR clearance data), this is a narrow SECURITY
-- DEFINER function -- same pattern as list_chaperone_credentials /
-- update_chaperone_credentials (20260909000004) -- that only ever creates
-- a name/email placeholder with no clearance dates, and only links the
-- request's volunteer_id (idempotent -- never overwrites an existing
-- link, never edits BG/MVR fields).
CREATE OR REPLACE FUNCTION public.claim_chaperone_for_bg_request(
  p_request_id    uuid,
  p_field_trip_id uuid
)
RETURNS TABLE (volunteer_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $$
DECLARE
  v_school_id  uuid;
  v_allowed    boolean;
  v_req        record;
  v_vol_id     uuid;
BEGIN
  -- Single query so v_allowed can never come back NULL (and silently skip
  -- the "IF NOT v_allowed" check below) unless v_school_id is also NULL --
  -- the flags being OR'd are all boolean NOT NULL columns, so the
  -- expression is only NULL when the row itself doesn't match.
  --
  -- Same authorization shape as field_trip_chaperones' own ftc_all RLS
  -- policy: a manager of this specific trip, a blanket field-trip manager,
  -- or a superadmin.
  SELECT p.school_id,
         (p.can_manage_field_trips OR p.is_superadmin OR EXISTS (
           SELECT 1 FROM public.field_trip_managers m
           WHERE m.field_trip_id = p_field_trip_id AND m.profile_id = p.id
         ))
    INTO v_school_id, v_allowed
  FROM public.profiles p
  WHERE p.user_id = auth.uid() AND p.status = 'active'
  LIMIT 1;

  IF v_school_id IS NULL OR NOT v_allowed THEN
    RAISE EXCEPTION 'Not authorized to manage this trip''s chaperones';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.field_trips ft
    WHERE ft.id = p_field_trip_id AND ft.school_id = v_school_id
  ) THEN
    RAISE EXCEPTION 'Trip not found';
  END IF;

  -- FOR UPDATE: two teachers racing to claim the same request (same
  -- grandparent added to two trips at once, say) must not each create
  -- their own compliance_volunteers row -- the second caller blocks here
  -- until the first's UPDATE below commits, then sees volunteer_id already
  -- set and reuses it instead of double-inserting.
  SELECT * INTO v_req
  FROM public.compliance_bg_check_requests r
  WHERE r.id = p_request_id AND r.school_id = v_school_id AND r.archived_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  IF v_req.status NOT IN ('pending', 'submitted') THEN
    RAISE EXCEPTION 'Request is no longer pending';
  END IF;

  IF v_req.volunteer_id IS NOT NULL THEN
    RETURN QUERY SELECT v_req.volunteer_id;
    RETURN;
  END IF;

  -- Mirrors ensureResolvedVolunteerId()'s conflict handling in
  -- admin.compliance.requests.js: uq_compliance_volunteers_match_key can
  -- still collide if a matching roster row was created independently
  -- (e.g. by compliance resolving a different request for the same
  -- person) between the FOR UPDATE read above and this insert -- fall
  -- back to that row instead of failing the claim outright.
  BEGIN
    INSERT INTO public.compliance_volunteers (school_id, first_name, last_name, email, volunteer_roles)
    VALUES (v_school_id, v_req.subject_first_name, v_req.subject_last_name, v_req.subject_email, v_req.volunteer_roles)
    RETURNING id INTO v_vol_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_vol_id
    FROM public.compliance_volunteers
    WHERE school_id = v_school_id
      AND match_key = public.compliance_volunteer_match_key(v_req.subject_first_name, v_req.subject_last_name)
      AND archived_at IS NULL
    LIMIT 1;
    IF v_vol_id IS NULL THEN
      RAISE;
    END IF;
  END;

  UPDATE public.compliance_bg_check_requests
  SET volunteer_id = v_vol_id
  WHERE id = p_request_id;

  RETURN QUERY SELECT v_vol_id;
END;
$$;

ALTER FUNCTION public.claim_chaperone_for_bg_request(uuid, uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.claim_chaperone_for_bg_request(uuid, uuid) IS
  'SECURITY DEFINER: lets a field trip manager turn a still-pending/submitted BG check request into a chaperone-eligible compliance_volunteers placeholder (name/email only, no BG/MVR dates), and links it back onto the request so compliance''s later Resolve flow reuses the same roster row instead of creating a duplicate. Idempotent on requests that already have a volunteer_id; row-locked to avoid a double-claim race.';

REVOKE ALL ON FUNCTION public.claim_chaperone_for_bg_request(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_chaperone_for_bg_request(uuid, uuid) TO authenticated;
