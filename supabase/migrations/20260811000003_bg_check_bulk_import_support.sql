-- Supports bulk-importing historical background check data (Revolution
-- Academy roster) into compliance_bg_check_requests.
--
-- requestor_id was NOT NULL because every prior row came from a staff
-- member submitting a request through the UI. A bulk historical import
-- has no such requestor, so it must be nullable. guardian_id lets an
-- imported/matched row point at the actual guardians record so the
-- compliance report can pick up DL/insurance/chaperone data from there.

ALTER TABLE public.compliance_bg_check_requests
  ALTER COLUMN requestor_id DROP NOT NULL;

ALTER TABLE public.compliance_bg_check_requests
  ADD COLUMN IF NOT EXISTS guardian_id uuid REFERENCES public.guardians(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS imported_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_compliance_bg_check_requests_guardian
  ON public.compliance_bg_check_requests(guardian_id);
