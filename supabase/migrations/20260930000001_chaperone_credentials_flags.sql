-- Surfaces the can_chaperone/can_drive manual override flags (set in
-- Compliance -> Volunteers) on the Chaperone Credentials page, so a teacher
-- entering DL/insurance dates for someone flagged "not allowed to drive" or
-- "not allowed to chaperone" sees that before saving a date that would
-- otherwise look like a normal, cleared record. These two booleans aren't
-- BG/MVR status (the thing list_chaperone_credentials' original comment
-- says to withhold from can_manage_chaperone_credentials holders) -- they're
-- a person-level restriction, not a credential result, so including them
-- doesn't cross that boundary.

-- CREATE OR REPLACE can't change a function's RETURNS TABLE shape -- drop first.
DROP FUNCTION IF EXISTS public.list_chaperone_credentials(text);

CREATE OR REPLACE FUNCTION public.list_chaperone_credentials(p_search text DEFAULT NULL)
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
      v_term IS NULL
      OR v.first_name ILIKE '%' || v_term || '%'
      OR v.last_name ILIKE '%' || v_term || '%'
      OR v.email ILIKE '%' || v_term || '%'
    )
  ORDER BY v.last_name, v.first_name
  LIMIT 200;
END;
$$;

ALTER FUNCTION public.list_chaperone_credentials(text) OWNER TO postgres;

COMMENT ON FUNCTION public.list_chaperone_credentials(text) IS
  'SECURITY DEFINER: lets can_manage_chaperone_credentials holders (or full compliance managers) browse the volunteer roster to enter DL/insurance dates and attach copies, without the RLS access to compliance_volunteers that can_manage_compliance normally requires. Returns name/email/roles/DL/insurance (dates + file refs) plus the can_chaperone/can_drive override flags -- never BG/MVR status or admin_note.';

REVOKE ALL ON FUNCTION public.list_chaperone_credentials(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_chaperone_credentials(text) TO authenticated;
