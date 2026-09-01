-- required_for_chaperones was all-or-nothing: a template applied to every
-- field trip a chaperone was added to, with no way to scope it to only
-- overnight trips (e.g. an "Overnight Chaperone Guidelines" form that
-- shouldn't block a same-day trip). Adds an opt-in narrowing flag rather
-- than a new trip field -- overnight-ness is already derived elsewhere in
-- the field trips UI from end_date <> start_date, so no field_trips
-- schema change is needed.

ALTER TABLE public.compliance_form_templates
  ADD COLUMN overnight_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.compliance_form_templates.overnight_only IS
  'When required_for_chaperones is true, restricts that requirement to trips where end_date differs from start_date (i.e. overnight/multi-day trips). Ignored when required_for_chaperones is false.';
