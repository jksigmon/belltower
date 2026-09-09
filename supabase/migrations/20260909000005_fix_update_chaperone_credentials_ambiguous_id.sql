-- Bug: update_chaperone_credentials (20260909000004) fails every save with
-- "column reference id is ambiguous". RETURNS TABLE(id uuid, ...) makes
-- `id` a PL/pgSQL output variable in scope for the whole function body, so
-- the second UPDATE's bare `WHERE id = v_guardian_id` (syncing the linked
-- guardian) couldn't tell that apart from guardians.id. The first UPDATE
-- never hit this because SET-clause targets always resolve to the table
-- being updated, not a PL/pgSQL variable -- only the unqualified WHERE
-- reference was ambiguous. Fix: alias guardians and qualify the column.

CREATE OR REPLACE FUNCTION public.update_chaperone_credentials(
  p_volunteer_id         uuid,
  p_dl_expires_at        date,
  p_insurance_expires_at date
)
RETURNS TABLE (
  id                    uuid,
  dl_expires_at         date,
  insurance_expires_at  date
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $$
DECLARE
  v_school_id   uuid;
  v_allowed     boolean;
  v_guardian_id uuid;
BEGIN
  SELECT p.school_id,
         (p.is_superadmin OR p.can_manage_chaperone_credentials OR p.can_manage_compliance)
    INTO v_school_id, v_allowed
  FROM public.profiles p
  WHERE p.user_id = auth.uid() AND p.status = 'active'
  LIMIT 1;

  IF v_school_id IS NULL OR NOT v_allowed THEN
    RAISE EXCEPTION 'Not authorized to update chaperone credentials';
  END IF;

  UPDATE public.compliance_volunteers v
  SET dl_expires_at = p_dl_expires_at,
      insurance_expires_at = p_insurance_expires_at,
      updated_at = now()
  WHERE v.id = p_volunteer_id
    AND v.school_id = v_school_id
    AND v.archived_at IS NULL
  RETURNING v.guardian_id INTO v_guardian_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Volunteer not found';
  END IF;

  -- Same sync saveVolunteer() does in the full Volunteers drawer --
  -- compliance_report and the field-trips chaperone check read DL/insurance
  -- off guardians directly, not off compliance_volunteers.
  IF v_guardian_id IS NOT NULL THEN
    UPDATE public.guardians g
    SET dl_expires_at = p_dl_expires_at,
        insurance_expires_at = p_insurance_expires_at
    WHERE g.id = v_guardian_id
      AND g.school_id = v_school_id;
  END IF;

  RETURN QUERY SELECT p_volunteer_id, p_dl_expires_at, p_insurance_expires_at;
END;
$$;

ALTER FUNCTION public.update_chaperone_credentials(uuid, date, date) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.update_chaperone_credentials(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_chaperone_credentials(uuid, date, date) TO authenticated;
