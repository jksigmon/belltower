-- Allow compliance form templates to opt out of requiring a signature.
-- When false, the volunteer form shows name/email fields only and records
-- the submission as signature_type = 'acknowledged'.
ALTER TABLE public.compliance_form_templates
  ADD COLUMN IF NOT EXISTS require_signature boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.compliance_form_templates.require_signature IS
  'When false, the form collects name and email only (no drawn/typed signature). Submission is recorded as acknowledged.';
