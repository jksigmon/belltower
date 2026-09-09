-- Teacher assistants need to enter driver's license and insurance expiration
-- dates for chaperones/volunteers, but shouldn't get the rest of what
-- can_manage_compliance unlocks (background check requests, BG/MVR
-- clearance dates, agreement forms, admin notes). compliance_volunteers'
-- only write policy (compliance_volunteers_manager) is all-or-nothing at
-- the row level, so there's no RLS-only way to carve out "these two
-- columns only" without either widening that policy (exposing BG/MVR
-- status and admin_note to a much larger audience) or writing fragile
-- column-diffing logic into a shared policy used by every other write path.
--
-- Instead: a new standalone permission, plus two narrow SECURITY DEFINER
-- functions with a hand-picked shape (name/email/roles/DL/insurance only)
-- -- the same pattern already used for compliance_bg_check_lookup,
-- compliance_report, and get_trip_managers elsewhere in this module.
-- compliance_volunteers' RLS is untouched.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_chaperone_credentials boolean DEFAULT false NOT NULL;

-- log_permission_changes() (20260727000001) tracks a fixed field list, not
-- every boolean column, so a new permission has to be added here or its
-- grant/revoke history silently never reaches permission_audit_log.
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
    'can_manage_licensure', 'can_manage_compliance', 'can_manage_chaperone_credentials', 'can_manage_field_trips',
    'can_manage_requests', 'can_bulk_upload', 'can_export_data',
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

CREATE OR REPLACE FUNCTION public.list_chaperone_credentials(p_search text DEFAULT NULL)
RETURNS TABLE (
  id                    uuid,
  first_name            text,
  last_name             text,
  email                 text,
  volunteer_roles       text[],
  dl_expires_at         date,
  insurance_expires_at  date
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
  SELECT v.id, v.first_name, v.last_name, v.email, v.volunteer_roles, v.dl_expires_at, v.insurance_expires_at
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
  'SECURITY DEFINER: lets can_manage_chaperone_credentials holders (or full compliance managers) browse the volunteer roster to enter DL/insurance dates, without the RLS access to compliance_volunteers that can_manage_compliance normally requires. Returns only name/email/roles/DL/insurance -- never BG/MVR status or admin_note.';

REVOKE ALL ON FUNCTION public.list_chaperone_credentials(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_chaperone_credentials(text) TO authenticated;

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
    UPDATE public.guardians
    SET dl_expires_at = p_dl_expires_at,
        insurance_expires_at = p_insurance_expires_at
    WHERE id = v_guardian_id
      AND school_id = v_school_id;
  END IF;

  RETURN QUERY SELECT p_volunteer_id, p_dl_expires_at, p_insurance_expires_at;
END;
$$;

ALTER FUNCTION public.update_chaperone_credentials(uuid, date, date) OWNER TO postgres;

COMMENT ON FUNCTION public.update_chaperone_credentials(uuid, date, date) IS
  'SECURITY DEFINER: lets can_manage_chaperone_credentials holders (or full compliance managers) update only dl_expires_at/insurance_expires_at on an existing compliance_volunteers row and its linked guardian. Does not touch BG/MVR fields, admin_note, or create new volunteer records.';

REVOKE ALL ON FUNCTION public.update_chaperone_credentials(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_chaperone_credentials(uuid, date, date) TO authenticated;
