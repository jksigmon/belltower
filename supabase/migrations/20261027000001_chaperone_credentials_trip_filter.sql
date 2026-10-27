-- Chaperone Credentials: filter the volunteer list by field trip.
--
-- A teacher picks an upcoming trip and sees only the people chaperoning it,
-- instead of searching the whole roster one name at a time.
--
-- Chaperones on a trip can be a guardian, a staff employee, or a volunteer
-- record, but this page lists compliance_volunteers. The helper below maps
-- each chaperone to a volunteer row the same way the Field Trips page does
-- (admin.field-trips.js getVolunteer / getStaffVolunteer):
--   1. direct volunteer_id
--   2. guardian: volunteer.guardian_id, then the first-name/last-name match key
--   3. staff: email only (a name guess could attach the wrong person's DL)
-- Chaperones with no match are counted so the page can say so.

-- Internal helper. Not granted to any API role; only the SECURITY DEFINER
-- functions below call it.
CREATE OR REPLACE FUNCTION public.trip_chaperone_volunteer_matches(p_school_id uuid, p_trip_id uuid)
RETURNS TABLE (chaperone_id uuid, volunteer_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $$
  SELECT c.id,
         COALESCE(d.id, g.id, e.id)
  FROM public.field_trip_chaperones c
  JOIN public.field_trips t
    ON t.id = c.field_trip_id AND t.school_id = p_school_id
  LEFT JOIN public.guardians gd ON gd.id = c.guardian_id
  LEFT JOIN public.employees emp ON emp.id = c.employee_id
  LEFT JOIN LATERAL (
    SELECT v.id FROM public.compliance_volunteers v
    WHERE v.id = c.volunteer_id AND v.school_id = p_school_id AND v.archived_at IS NULL
  ) d ON c.volunteer_id IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT v.id FROM public.compliance_volunteers v
    WHERE gd.id IS NOT NULL
      AND v.school_id = p_school_id
      AND v.archived_at IS NULL
      AND (
        v.guardian_id = gd.id
        OR v.match_key = public.compliance_volunteer_match_key(gd.first_name, gd.last_name)
      )
    ORDER BY (v.guardian_id = gd.id) DESC NULLS LAST, v.id
    LIMIT 1
  ) g ON true
  LEFT JOIN LATERAL (
    SELECT v.id FROM public.compliance_volunteers v
    WHERE emp.id IS NOT NULL
      AND nullif(trim(emp.email), '') IS NOT NULL
      AND v.school_id = p_school_id
      AND v.archived_at IS NULL
      AND lower(trim(v.email)) = lower(trim(emp.email))
    ORDER BY v.id
    LIMIT 1
  ) e ON true
  WHERE c.removed_at IS NULL
    AND c.school_id = p_school_id
    AND (p_trip_id IS NULL OR c.field_trip_id = p_trip_id);
$$;

REVOKE ALL ON FUNCTION public.trip_chaperone_volunteer_matches(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trip_chaperone_volunteer_matches(uuid, uuid) FROM anon, authenticated;

-- Replace list_chaperone_credentials with a version that takes a trip.
-- Drop the old signature first so PostgREST doesn't see two overloads.
DROP FUNCTION IF EXISTS public.list_chaperone_credentials(text);

CREATE OR REPLACE FUNCTION public.list_chaperone_credentials(p_search text DEFAULT NULL, p_trip_id uuid DEFAULT NULL)
RETURNS TABLE (
  id                    uuid,
  first_name            text,
  last_name             text,
  email                 text,
  volunteer_roles       text[],
  dl_expires_at         date,
  insurance_expires_at  date,
  dl_file_path          text,
  dl_file_name          text,
  insurance_file_path   text,
  insurance_file_name   text,
  can_chaperone         boolean,
  can_drive             boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $$
DECLARE
  v_school_id uuid;
  v_allowed   boolean;
  v_term      text := nullif(trim(p_search), '');
BEGIN
  SELECT p.school_id,
         (p.is_superadmin OR p.can_manage_chaperone_credentials OR p.can_manage_compliance)
    INTO v_school_id, v_allowed
  FROM public.profiles p
  WHERE p.user_id = auth.uid() AND p.status = 'active'
  LIMIT 1;

  IF v_school_id IS NULL OR NOT v_allowed THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT v.id, v.first_name, v.last_name, v.email, v.volunteer_roles, v.dl_expires_at, v.insurance_expires_at,
         v.dl_file_path, v.dl_file_name, v.insurance_file_path, v.insurance_file_name,
         v.can_chaperone, v.can_drive
  FROM public.compliance_volunteers v
  WHERE v.school_id = v_school_id
    AND v.archived_at IS NULL
    AND (
      p_trip_id IS NULL
      OR v.id IN (
        SELECT m.volunteer_id
        FROM public.trip_chaperone_volunteer_matches(v_school_id, p_trip_id) m
        WHERE m.volunteer_id IS NOT NULL
      )
    )
    AND (
      v_term IS NULL
      OR v.first_name ILIKE '%' || v_term || '%'
      OR v.last_name ILIKE '%' || v_term || '%'
      OR v.email ILIKE '%' || v_term || '%'
    )
  ORDER BY v.last_name, v.first_name
  LIMIT 200;
END;
$$;

ALTER FUNCTION public.list_chaperone_credentials(text, uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.list_chaperone_credentials(text, uuid) IS
  'SECURITY DEFINER: lets can_manage_chaperone_credentials holders (or full compliance managers) browse the volunteer roster to enter DL/insurance dates and attach copies, without the RLS access to compliance_volunteers that can_manage_compliance normally requires. Optional p_trip_id narrows the list to the people chaperoning that trip. Returns name/email/roles/DL/insurance (dates + file refs) plus the can_chaperone/can_drive override flags -- never BG/MVR status or admin_note.';

REVOKE ALL ON FUNCTION public.list_chaperone_credentials(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_chaperone_credentials(text, uuid) TO authenticated;

-- Upcoming trips for the dropdown. field_trips is RLS-protected and the
-- credentials permission doesn't grant read access, hence SECURITY DEFINER.
-- unmatched_count = chaperones on the trip with no volunteer record.
CREATE OR REPLACE FUNCTION public.list_chaperone_credential_trips()
RETURNS TABLE (
  id               uuid,
  name             text,
  start_date       date,
  end_date         date,
  chaperone_count  integer,
  unmatched_count  integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $$
DECLARE
  v_school_id uuid;
  v_allowed   boolean;
BEGIN
  SELECT p.school_id,
         (p.is_superadmin OR p.can_manage_chaperone_credentials OR p.can_manage_compliance)
    INTO v_school_id, v_allowed
  FROM public.profiles p
  WHERE p.user_id = auth.uid() AND p.status = 'active'
  LIMIT 1;

  IF v_school_id IS NULL OR NOT v_allowed THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT t.id, t.name, t.start_date, t.end_date,
         COALESCE(m.total, 0)::integer,
         COALESCE(m.unmatched, 0)::integer
  FROM public.field_trips t
  LEFT JOIN LATERAL (
    SELECT count(*) AS total,
           count(*) FILTER (WHERE x.volunteer_id IS NULL) AS unmatched
    FROM public.trip_chaperone_volunteer_matches(v_school_id, t.id) x
  ) m ON true
  WHERE t.school_id = v_school_id
    AND t.status = 'active'
    -- One day of slack so a trip today doesn't drop off in the evening
    -- (current_date is UTC on the server).
    AND COALESCE(t.end_date, t.start_date) >= current_date - 1
  ORDER BY t.start_date, t.name;
END;
$$;

ALTER FUNCTION public.list_chaperone_credential_trips() OWNER TO postgres;

COMMENT ON FUNCTION public.list_chaperone_credential_trips() IS
  'SECURITY DEFINER: upcoming, non-cancelled field trips in the caller''s school for the Chaperone Credentials trip filter, with chaperone and unmatched-chaperone counts. Same permission gate as list_chaperone_credentials.';

REVOKE ALL ON FUNCTION public.list_chaperone_credential_trips() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_chaperone_credential_trips() TO authenticated;
