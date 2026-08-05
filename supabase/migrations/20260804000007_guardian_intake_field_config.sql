-- Per-campaign toggle for which optional fields appear on the guardian intake form.
-- Fixed set of togglable fields (not a form builder) — name is always required.
ALTER TABLE public.guardian_intake_campaigns
  ADD COLUMN field_config jsonb NOT NULL DEFAULT '{
    "email": true,
    "phone": true,
    "relationship": true,
    "second_guardian": true,
    "students": true
  }'::jsonb;
