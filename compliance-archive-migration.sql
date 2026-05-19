-- ======================================================================
-- Compliance: Archive support for BG checks and agreements
-- Run once in Supabase SQL editor.
-- ======================================================================

ALTER TABLE public.compliance_bg_check_requests
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE public.compliance_agreements
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
