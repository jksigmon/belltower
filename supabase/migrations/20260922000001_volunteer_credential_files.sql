-- Lets a TA (can_manage_chaperone_credentials) or compliance manager
-- (can_manage_compliance) attach a scanned copy/photo of a volunteer's
-- driver's license and insurance card alongside the expiration dates they
-- already enter, in both the standalone Chaperone Credentials tool and the
-- full Volunteers drawer in Compliance.
--
-- Mirrors the license-files / ceu-files pattern already used elsewhere:
-- file_path + file_name columns on the owning row, a private storage
-- bucket, and storage.objects RLS keyed off the school_id path segment.
-- NOTE: per the caveat left in 20260717000001_resource_documents.sql, this
-- repo has no other storage.objects RLS policies committed anywhere else --
-- these are written the same way, but please verify in the Supabase
-- dashboard's Storage section that upload/view/delete behave as expected.

ALTER TABLE public.compliance_volunteers
  ADD COLUMN IF NOT EXISTS dl_file_path text,
  ADD COLUMN IF NOT EXISTS dl_file_name text,
  ADD COLUMN IF NOT EXISTS insurance_file_path text,
  ADD COLUMN IF NOT EXISTS insurance_file_name text;

-- compliance_volunteer_status lists its columns explicitly rather than
-- SELECT * (security_invoker view), so the new file columns need adding
-- here too or every reader of the view (Volunteers drawer, Needs Attention)
-- would never see them.
CREATE OR REPLACE VIEW public.compliance_volunteer_status
WITH (security_invoker = true) AS
SELECT
  id,
  school_id,
  first_name,
  last_name,
  email,
  guardian_id,
  match_key,
  volunteer_roles,
  bg_cleared_at,
  bg_expires_at,
  mvr_cleared_at,
  mvr_expires_at,
  dl_expires_at,
  insurance_expires_at,
  can_chaperone,
  can_drive,
  admin_note,
  archived_at,
  created_at,
  updated_at,
  (bg_expires_at IS NOT NULL AND bg_expires_at < CURRENT_DATE) AS bg_expired,
  (mvr_expires_at IS NOT NULL AND mvr_expires_at < CURRENT_DATE) AS mvr_expired,
  (dl_expires_at IS NOT NULL AND dl_expires_at < CURRENT_DATE) AS dl_expired,
  (insurance_expires_at IS NOT NULL AND insurance_expires_at < CURRENT_DATE) AS insurance_expired,
  LEAST(bg_expires_at, mvr_expires_at, dl_expires_at, insurance_expires_at) AS next_expiry,
  CASE
    WHEN bg_cleared_at IS NULL THEN 'missing_bg'
    WHEN bg_expires_at IS NOT NULL AND bg_expires_at < CURRENT_DATE THEN 'expired'
    WHEN LEAST(bg_expires_at, mvr_expires_at, dl_expires_at, insurance_expires_at) IS NOT NULL
         AND LEAST(bg_expires_at, mvr_expires_at, dl_expires_at, insurance_expires_at) < CURRENT_DATE THEN 'expired'
    WHEN LEAST(bg_expires_at, mvr_expires_at, dl_expires_at, insurance_expires_at) IS NOT NULL
         AND LEAST(bg_expires_at, mvr_expires_at, dl_expires_at, insurance_expires_at) <= CURRENT_DATE + 30 THEN 'expiring_30'
    WHEN LEAST(bg_expires_at, mvr_expires_at, dl_expires_at, insurance_expires_at) IS NOT NULL
         AND LEAST(bg_expires_at, mvr_expires_at, dl_expires_at, insurance_expires_at) <= CURRENT_DATE + 60 THEN 'expiring_60'
    ELSE 'ok'
  END AS worst_status,
  dl_file_path,
  dl_file_name,
  insurance_file_path,
  insurance_file_name
FROM public.compliance_volunteers v;

-- ============================================================
-- Storage: private 'volunteer-credential-files' bucket
--
-- Object path convention: `${school_id}/${volunteer_id}/${field}-${timestamp}-${filename}`
-- where field is 'dl' or 'insurance'. This never gets a public URL --
-- always accessed via a short-lived signed URL, same as license-files.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'volunteer-credential-files',
  'volunteer-credential-files',
  false,
  10485760, -- 10 MB
  ARRAY['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "volunteer_credential_files_read" ON storage.objects;
CREATE POLICY "volunteer_credential_files_read" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'volunteer-credential-files'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id::text = (storage.foldername(name))[1]
              AND (p.can_manage_compliance = true OR p.can_manage_chaperone_credentials = true))
        )
    )
  );

DROP POLICY IF EXISTS "volunteer_credential_files_write" ON storage.objects;
CREATE POLICY "volunteer_credential_files_write" ON storage.objects
  FOR ALL USING (
    bucket_id = 'volunteer-credential-files'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id::text = (storage.foldername(name))[1]
              AND (p.can_manage_compliance = true OR p.can_manage_chaperone_credentials = true))
        )
    )
  )
  WITH CHECK (
    bucket_id = 'volunteer-credential-files'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id::text = (storage.foldername(name))[1]
              AND (p.can_manage_compliance = true OR p.can_manage_chaperone_credentials = true))
        )
    )
  );

-- list_chaperone_credentials / update_chaperone_credentials (20260909000004)
-- are the only way a can_manage_chaperone_credentials holder touches
-- compliance_volunteers -- they have no RLS access to the table itself, by
-- design, so the file columns have to be added to these hand-picked
-- SECURITY DEFINER shapes rather than just relying on table RLS.

-- CREATE OR REPLACE can't change a function's RETURNS TABLE shape -- drop
-- first, same as the update_chaperone_credentials 3-arg overload below.
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
  insurance_file_name   text
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
         v.dl_file_path, v.dl_file_name, v.insurance_file_path, v.insurance_file_name
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
  'SECURITY DEFINER: lets can_manage_chaperone_credentials holders (or full compliance managers) browse the volunteer roster to enter DL/insurance dates and attach copies, without the RLS access to compliance_volunteers that can_manage_compliance normally requires. Returns only name/email/roles/DL/insurance (dates + file refs) -- never BG/MVR status or admin_note.';

REVOKE ALL ON FUNCTION public.list_chaperone_credentials(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_chaperone_credentials(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_chaperone_credentials(
  p_volunteer_id         uuid,
  p_dl_expires_at        date,
  p_insurance_expires_at date,
  p_dl_file_path         text DEFAULT NULL,
  p_dl_file_name         text DEFAULT NULL,
  p_insurance_file_path  text DEFAULT NULL,
  p_insurance_file_name  text DEFAULT NULL
)
RETURNS TABLE (
  id                    uuid,
  dl_expires_at         date,
  insurance_expires_at  date,
  dl_file_path          text,
  dl_file_name          text,
  insurance_file_path   text,
  insurance_file_name   text
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
      dl_file_path = p_dl_file_path,
      dl_file_name = p_dl_file_name,
      insurance_file_path = p_insurance_file_path,
      insurance_file_name = p_insurance_file_name,
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
  -- off guardians directly, not off compliance_volunteers. Guardians has no
  -- file columns of its own -- only the dates sync, same as before.
  --
  -- WHERE clause is qualified with the "g" alias -- RETURNS TABLE above
  -- declares an OUT parameter literally named "id", so an unqualified
  -- "WHERE id = ..." here is ambiguous between that variable and
  -- guardians.id (this was a latent bug in the original 3-arg function
  -- too, just never exercised until now).
  IF v_guardian_id IS NOT NULL THEN
    UPDATE public.guardians g
    SET dl_expires_at = p_dl_expires_at,
        insurance_expires_at = p_insurance_expires_at
    WHERE g.id = v_guardian_id
      AND g.school_id = v_school_id;
  END IF;

  RETURN QUERY SELECT p_volunteer_id, p_dl_expires_at, p_insurance_expires_at,
                      p_dl_file_path, p_dl_file_name, p_insurance_file_path, p_insurance_file_name;
END;
$$;

ALTER FUNCTION public.update_chaperone_credentials(uuid, date, date, text, text, text, text) OWNER TO postgres;

COMMENT ON FUNCTION public.update_chaperone_credentials(uuid, date, date, text, text, text, text) IS
  'SECURITY DEFINER: lets can_manage_chaperone_credentials holders (or full compliance managers) update dl_expires_at/insurance_expires_at and their attached file refs on an existing compliance_volunteers row and its linked guardian dates. Does not touch BG/MVR fields, admin_note, or create new volunteer records.';

REVOKE ALL ON FUNCTION public.update_chaperone_credentials(uuid, date, date, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_chaperone_credentials(uuid, date, date, text, text, text, text) TO authenticated;

-- The old 3-arg signature is superseded by the 7-arg one above -- drop it so
-- PostgREST doesn't have two overloads with the same name to disambiguate.
DROP FUNCTION IF EXISTS public.update_chaperone_credentials(uuid, date, date);
