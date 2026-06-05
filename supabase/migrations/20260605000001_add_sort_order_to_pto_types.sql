-- Adds sort_order to school_pto_types so each school can control column ordering
-- in the Leave Policies admin panel and leave-type dropdowns.
ALTER TABLE public.school_pto_types
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 99;

-- Sensible defaults for the known leave types
UPDATE public.school_pto_types SET sort_order = 1 WHERE pto_type = 'PERSONAL';
UPDATE public.school_pto_types SET sort_order = 2 WHERE pto_type = 'ROLLOVER';
UPDATE public.school_pto_types SET sort_order = 3 WHERE pto_type = 'PROFESSIONAL';
UPDATE public.school_pto_types SET sort_order = 4 WHERE pto_type = 'JURY DUTY';
-- Any unrecognized types keep DEFAULT 99 and sort alphabetically among themselves
