-- ============================================================
-- Backfill: collapse compliance_bg_check_requests into
-- compliance_volunteers, one row per person.
--
-- Selection rules per person (school_id + match_key):
--   - BG date pair comes from whichever of their rows has the
--     latest cleared_at. MVR date pair is chosen independently
--     (latest mvr_cleared_at) so a person's most recent BG-only
--     renewal can't erase an earlier row's MVR clearance.
--   - volunteer_roles is the union of every role ever recorded
--     across all of their rows.
--   - email / guardian_id / admin_note come from their most
--     recently requested row that has a non-null value.
--   - Archived rows are excluded. The office's existing workflow
--     is to archive/delete a row once stale and start over on
--     re-request, so an archived row shouldn't resurrect a
--     volunteer nobody is tracking anymore.
--
-- Idempotent: the partial unique index on (school_id, match_key)
-- backs an ON CONFLICT DO NOTHING, so re-running after new
-- requests come in won't duplicate anyone already backfilled.
-- ============================================================

CREATE TEMP TABLE _volunteer_backfill AS
WITH source AS (
  SELECT
    r.*,
    public.compliance_volunteer_match_key(r.subject_first_name, r.subject_last_name) AS match_key
  FROM public.compliance_bg_check_requests r
  WHERE r.archived_at IS NULL
),
bg_winner AS (
  SELECT DISTINCT ON (school_id, match_key)
    school_id, match_key, cleared_at AS bg_cleared_at, expires_at AS bg_expires_at
  FROM source
  WHERE cleared_at IS NOT NULL
  ORDER BY school_id, match_key, cleared_at DESC
),
mvr_winner AS (
  SELECT DISTINCT ON (school_id, match_key)
    school_id, match_key, mvr_cleared_at, mvr_expires_at
  FROM source
  WHERE mvr_cleared_at IS NOT NULL
  ORDER BY school_id, match_key, mvr_cleared_at DESC
),
latest AS (
  SELECT DISTINCT ON (school_id, match_key)
    school_id, match_key, subject_first_name, subject_last_name,
    subject_email, guardian_id, admin_note, requested_at
  FROM source
  ORDER BY school_id, match_key, requested_at DESC
),
roles AS (
  SELECT s.school_id, s.match_key,
         array_agg(DISTINCT role_val) FILTER (WHERE role_val IS NOT NULL) AS volunteer_roles
  FROM source s, unnest(s.volunteer_roles) AS role_val
  GROUP BY s.school_id, s.match_key
)
SELECT
  l.school_id,
  l.match_key,
  l.subject_first_name AS first_name,
  l.subject_last_name  AS last_name,
  l.subject_email       AS email,
  l.guardian_id,
  l.admin_note,
  COALESCE(rl.volunteer_roles, '{}') AS volunteer_roles,
  bg.bg_cleared_at,
  bg.bg_expires_at,
  mvr.mvr_cleared_at,
  mvr.mvr_expires_at
FROM latest l
LEFT JOIN bg_winner  bg  ON bg.school_id  = l.school_id AND bg.match_key  = l.match_key
LEFT JOIN mvr_winner mvr ON mvr.school_id = l.school_id AND mvr.match_key = l.match_key
LEFT JOIN roles      rl  ON rl.school_id  = l.school_id AND rl.match_key  = l.match_key;

INSERT INTO public.compliance_volunteers (
  school_id, first_name, last_name, email, guardian_id,
  volunteer_roles, bg_cleared_at, bg_expires_at, mvr_cleared_at, mvr_expires_at,
  dl_expires_at, insurance_expires_at, can_chaperone, can_drive, admin_note
)
SELECT
  b.school_id, b.first_name, b.last_name, b.email, b.guardian_id,
  b.volunteer_roles, b.bg_cleared_at, b.bg_expires_at, b.mvr_cleared_at, b.mvr_expires_at,
  g.dl_expires_at, g.insurance_expires_at,
  COALESCE(g.can_chaperone, true), COALESCE(g.can_drive, true),
  b.admin_note
FROM _volunteer_backfill b
LEFT JOIN public.guardians g ON g.id = b.guardian_id
ON CONFLICT (school_id, match_key) WHERE archived_at IS NULL DO NOTHING;

-- Link every open (non-archived) request back to the volunteer row it
-- collapsed into, so future UI can navigate request -> person.
UPDATE public.compliance_bg_check_requests r
SET volunteer_id = v.id
FROM public.compliance_volunteers v
WHERE v.school_id  = r.school_id
  AND v.match_key  = public.compliance_volunteer_match_key(r.subject_first_name, r.subject_last_name)
  AND r.archived_at IS NULL
  AND r.volunteer_id IS NULL;
