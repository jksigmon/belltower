-- Adds an optional, explicit grade assignment for employees (teachers).
--
-- Today, "what grade does teacher X teach" is derived on the fly from the
-- grade_level of the active students currently in their homeroom
-- (see supabase/functions/guardian_intake_lookup). That derivation breaks
-- for a window every year: once students are promoted (grade_level bumped)
-- but before class placements are committed, every teacher's derived grade
-- is off by one. This column lets admins set the grade directly so it's
-- independent of promotion/placement timing.
--
-- Nullable, no default: existing behavior (derive from students) remains
-- the fallback wherever this is null.

ALTER TABLE public.employees
  ADD COLUMN grade text;

COMMENT ON COLUMN public.employees.grade IS
  'Optional explicit grade assignment for the employee''s homeroom (e.g. PK, K, 1-12). Matches students.grade_level short codes. When set, takes precedence over deriving the teacher''s grade from currently-enrolled students.';
