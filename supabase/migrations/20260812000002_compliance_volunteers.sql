-- ============================================================
-- Compliance: person-centric volunteer roster
--
-- Problem: compliance_bg_check_requests models "a request", not "a
-- person" -- every renewal (BG check, MVR, DL, insurance) has been a
-- brand new row since the office's old Excel sheet, so the same
-- volunteer accumulates duplicate rows over time (39 duplicate names /
-- ~900 rows in the real data as of 2026-08-12). guardian_id, added in
-- 20260811000003, was meant to be the fix but is unreliable: it's null
-- on every row created before that migration, null on every row the
-- staff request form creates (app/staff.html never sets it), and only
-- fuzzy name-matched for the bulk historical import.
--
-- Fix: a new compliance_volunteers table, one row per person per
-- school, keyed on a normalized name (match_key) since email is absent
-- on the majority of historical rows and guardian_id isn't trustworthy
-- enough to be a key. compliance_bg_check_requests is untouched in
-- shape -- it keeps its own requestor-scoped RLS (staff need to see
-- their own requests) and becomes an inbox that resolves *into* a
-- volunteer row via the new volunteer_id column, instead of being the
-- system of record itself.
-- ============================================================

-- ── Normalized match key ───────────────────────────────────────────
-- Mirrors the ad-hoc bg_norm() used for the one-time historical import
-- (bg-check-data-import.sql): strips "(...)" nickname/maiden-name
-- annotations (e.g. "BAKER (Barker)") and keys off first name's first
-- word only, so "GREGORY MICHAEL" matches a roster entry of "GREGORY".
-- Declared IMMUTABLE so it can back a generated column.
CREATE OR REPLACE FUNCTION public.compliance_volunteer_match_key(p_first_name text, p_last_name text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT
    lower(trim(regexp_replace(coalesce(p_last_name, ''), '\s*\([^)]*\)\s*', ' ', 'g')))
    || '|' ||
    lower(split_part(trim(regexp_replace(coalesce(p_first_name, ''), '\s*\([^)]*\)\s*', ' ', 'g')), ' ', 1))
$$;

-- ── TABLE: compliance_volunteers ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.compliance_volunteers (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  first_name            text        NOT NULL,
  last_name             text        NOT NULL,
  email                 text,
  guardian_id           uuid        REFERENCES public.guardians(id) ON DELETE SET NULL,
  match_key             text        GENERATED ALWAYS AS (public.compliance_volunteer_match_key(first_name, last_name)) STORED,

  volunteer_roles       text[]      NOT NULL DEFAULT '{}',

  bg_cleared_at         date,
  bg_expires_at         date,
  mvr_cleared_at        date,
  mvr_expires_at        date,
  dl_expires_at         date,
  insurance_expires_at  date,

  can_chaperone         boolean     NOT NULL DEFAULT true,
  can_drive             boolean     NOT NULL DEFAULT true,

  admin_note            text,
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Enforces the merge decision: a new request for an existing (active)
-- person must update this row, never insert a second one for the same
-- name. Partial on archived_at so an archived volunteer's name can be
-- reused by a genuinely new person without fighting a dead row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_volunteers_match_key
  ON public.compliance_volunteers (school_id, match_key)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_compliance_volunteers_school
  ON public.compliance_volunteers (school_id) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_compliance_volunteers_guardian
  ON public.compliance_volunteers (guardian_id);

CREATE OR REPLACE TRIGGER trg_compliance_volunteers_updated_at
  BEFORE UPDATE ON public.compliance_volunteers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.compliance_volunteers ENABLE ROW LEVEL SECURITY;

-- Managers (and superadmins) have full access -- same shape as every
-- other compliance_* manager policy in this schema.
CREATE POLICY compliance_volunteers_manager ON public.compliance_volunteers
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = compliance_volunteers.school_id
        AND (p.can_manage_compliance = true OR p.is_superadmin = true)
    )
  );

-- Field trip managers need read access to check chaperone/driver
-- eligibility -- mirrors bg_check_ft_read
-- (20260810000001_field_trip_manager_compliance_read.sql).
CREATE POLICY compliance_volunteers_ft_read ON public.compliance_volunteers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = compliance_volunteers.school_id
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          EXISTS (
            SELECT 1 FROM public.field_trip_managers m
            JOIN public.field_trips ft ON ft.id = m.field_trip_id
            WHERE m.profile_id = p.id AND ft.school_id = compliance_volunteers.school_id
          )
        )
    )
  );

-- Staff get no direct read here -- they see their own requests through
-- compliance_bg_check_requests, whose RLS is unchanged.

-- ── compliance_bg_check_requests: link to the roster ───────────────
ALTER TABLE public.compliance_bg_check_requests
  ADD COLUMN IF NOT EXISTS volunteer_id uuid REFERENCES public.compliance_volunteers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_compliance_bg_check_requests_volunteer
  ON public.compliance_bg_check_requests (volunteer_id);

-- Add 'declined' so a manager can reject a request without repurposing
-- 'cancelled' (staff-withdrawal) or 'expired' (credential lapsed).
ALTER TABLE public.compliance_bg_check_requests
  DROP CONSTRAINT IF EXISTS compliance_bg_check_requests_status_check;
ALTER TABLE public.compliance_bg_check_requests
  ADD CONSTRAINT compliance_bg_check_requests_status_check
  CHECK (status IN ('pending', 'submitted', 'cleared', 'expired', 'cancelled', 'declined'));

-- ── VIEW: compliance_volunteer_status ──────────────────────────────
-- Derives per-credential validity plus one sortable next_expiry /
-- worst_status so Needs Attention and the Directory can filter/sort
-- server-side instead of pulling every row and computing this in JS
-- (today's approach at ~900 rows sits just under PostgREST's default
-- 1000-row cap with no defensive count check).
-- security_invoker so the view is subject to the caller's own RLS on
-- compliance_volunteers, not the view owner's.
CREATE OR REPLACE VIEW public.compliance_volunteer_status
WITH (security_invoker = true) AS
SELECT
  v.*,
  (v.bg_expires_at IS NOT NULL AND v.bg_expires_at < current_date)  AS bg_expired,
  (v.mvr_expires_at IS NOT NULL AND v.mvr_expires_at < current_date) AS mvr_expired,
  (v.dl_expires_at IS NOT NULL AND v.dl_expires_at < current_date)  AS dl_expired,
  (v.insurance_expires_at IS NOT NULL AND v.insurance_expires_at < current_date) AS insurance_expired,
  LEAST(v.bg_expires_at, v.mvr_expires_at, v.dl_expires_at, v.insurance_expires_at) AS next_expiry,
  CASE
    WHEN v.bg_cleared_at IS NULL THEN 'missing_bg'
    WHEN v.bg_expires_at IS NOT NULL AND v.bg_expires_at < current_date THEN 'expired'
    WHEN LEAST(v.bg_expires_at, v.mvr_expires_at, v.dl_expires_at, v.insurance_expires_at) IS NOT NULL
         AND LEAST(v.bg_expires_at, v.mvr_expires_at, v.dl_expires_at, v.insurance_expires_at) < current_date THEN 'expired'
    WHEN LEAST(v.bg_expires_at, v.mvr_expires_at, v.dl_expires_at, v.insurance_expires_at) IS NOT NULL
         AND LEAST(v.bg_expires_at, v.mvr_expires_at, v.dl_expires_at, v.insurance_expires_at) <= current_date + 30 THEN 'expiring_30'
    WHEN LEAST(v.bg_expires_at, v.mvr_expires_at, v.dl_expires_at, v.insurance_expires_at) IS NOT NULL
         AND LEAST(v.bg_expires_at, v.mvr_expires_at, v.dl_expires_at, v.insurance_expires_at) <= current_date + 60 THEN 'expiring_60'
    ELSE 'ok'
  END AS worst_status
FROM public.compliance_volunteers v;
