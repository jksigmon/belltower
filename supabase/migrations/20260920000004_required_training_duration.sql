-- Required Training records can now optionally record how long the
-- training took, entered as separate Hours + Minutes fields (matching the
-- CEU entry UX in admin.licensure.js/staff.html) and combined into a single
-- decimal-hours value before it touches the database. Unlike CEUs, this is
-- purely informational -- there's no ceu_amount/credit conversion here,
-- since Required Training was split out specifically because it doesn't
-- count toward NC renewal credit.

ALTER TABLE public.staff_required_training
  ADD COLUMN IF NOT EXISTS duration_hours numeric,
  ADD CONSTRAINT staff_required_training_duration_hours_check
    CHECK (duration_hours IS NULL OR duration_hours > 0);
