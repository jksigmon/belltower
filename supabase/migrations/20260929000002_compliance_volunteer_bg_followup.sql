-- Lets a compliance manager flag a volunteer's background check record as
-- needing the *volunteer themselves* to call the vendor and resolve
-- something (e.g. a name/address mismatch, an item the vendor needs the
-- applicant to clarify directly). This is not a to-do for the compliance
-- office -- can_chaperone/can_drive already cover "block this person" --
-- it's purely a status explanation so anyone looking at this person's BG
-- status (Volunteers/Needs Attention, the field-trips chaperone list, and
-- the teacher-facing compliance report) understands the file is stalled on
-- the volunteer's own action, not on the school.
--
-- Deliberately no vendor name anywhere in schema or UI copy -- not every
-- school uses the same background-check company. bg_followup_note is where
-- a compliance manager can note specifics (which vendor, what's needed) if
-- she wants to.

ALTER TABLE public.compliance_volunteers
  ADD COLUMN IF NOT EXISTS bg_followup_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bg_followup_note text;

-- compliance_volunteer_status lists its columns explicitly rather than
-- SELECT * (security_invoker view), so the new columns need adding here
-- too or every reader of the view (Volunteers drawer, Needs Attention,
-- field-trips chaperone check) would never see them.
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
  insurance_file_name,
  bg_followup_flag,
  bg_followup_note
FROM public.compliance_volunteers v;
