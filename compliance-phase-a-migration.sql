-- ======================================================================
-- Compliance Phase A Migration — Guardian Linking
-- Run once in Supabase SQL editor after compliance-migration.sql.
-- Adds linking columns to compliance_agreements so signed forms can be
-- associated with guardian/family records and used in compliance reports.
-- ======================================================================

-- ── New columns on compliance_agreements ─────────────────────────────
ALTER TABLE public.compliance_agreements
  ADD COLUMN IF NOT EXISTS guardian_id           uuid REFERENCES public.guardians(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS family_id             uuid REFERENCES public.families(id)  ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS link_status           text NOT NULL DEFAULT 'unresolved'
                             CHECK (link_status IN ('auto_linked', 'manual_linked', 'unresolved')),
  ADD COLUMN IF NOT EXISTS student_name_hint     text,   -- free-text the signer typed
  ADD COLUMN IF NOT EXISTS carline_tag_hint      text,   -- optional car tag entered on form
  ADD COLUMN IF NOT EXISTS submitted_phone       text,   -- enrichment data, admin-review only
  ADD COLUMN IF NOT EXISTS submitted_relationship text;  -- enrichment data, admin-review only

-- ── Indexes for report queries ────────────────────────────────────────
-- Used when building the per-student compliance matrix
CREATE INDEX IF NOT EXISTS idx_compliance_agreements_guardian
  ON public.compliance_agreements(guardian_id, template_id);

CREATE INDEX IF NOT EXISTS idx_compliance_agreements_family
  ON public.compliance_agreements(family_id);

CREATE INDEX IF NOT EXISTS idx_compliance_agreements_link_status
  ON public.compliance_agreements(school_id, link_status);
