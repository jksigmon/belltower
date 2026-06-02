-- Phase B/C: Compliance report grants + guardian enrichment review
-- Run after compliance-phase-a-migration.sql

-- ── compliance_report_grants ──────────────────────────────────────────
-- Maps a profile (TA or anyone granted access) to a teacher's homeroom.
-- The grantee can view compliance status for that teacher's students.
CREATE TABLE IF NOT EXISTS public.compliance_report_grants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  grantee_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  teacher_id       uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  granted_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  granted_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, grantee_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS idx_compliance_report_grants_grantee
  ON public.compliance_report_grants(school_id, grantee_id);

CREATE INDEX IF NOT EXISTS idx_compliance_report_grants_teacher
  ON public.compliance_report_grants(school_id, teacher_id);

-- RLS
ALTER TABLE public.compliance_report_grants ENABLE ROW LEVEL SECURITY;

-- Compliance managers can see/manage all grants for their school
CREATE POLICY "compliance managers manage grants"
  ON public.compliance_report_grants
  FOR ALL
  USING (
    school_id IN (
      SELECT p.school_id FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.can_manage_compliance = true
    )
  );

-- Grantees can read their own grants
-- Note: grantee_id references profiles.id (not auth.uid() directly)
CREATE POLICY "grantees read own grants"
  ON public.compliance_report_grants
  FOR SELECT
  USING (
    grantee_id IN (
      SELECT p.id FROM public.profiles p WHERE p.user_id = auth.uid()
    )
  );

-- ── compliance_agreements: submitted_data_reviewed flag ───────────────
-- Tracks whether admin has reviewed submitted phone/relationship hints
ALTER TABLE public.compliance_agreements
  ADD COLUMN IF NOT EXISTS submitted_data_reviewed boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_compliance_agreements_review_pending
  ON public.compliance_agreements(school_id, submitted_data_reviewed)
  WHERE submitted_data_reviewed = false
    AND (submitted_phone IS NOT NULL OR submitted_relationship IS NOT NULL);
