-- Allow individual students to be manually added to a placement board
-- regardless of whether their grade_level matches the board's incoming_grade.
-- Rows inserted via the "Add Student" UI get manually_added = true;
-- all existing and auto-populated rows keep the default false.
ALTER TABLE public.placement_assignments
  ADD COLUMN IF NOT EXISTS manually_added boolean NOT NULL DEFAULT false;
