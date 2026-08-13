-- Lets admins mark a family with special dismissal/handling needs directly
-- on the family record, visible at a glance from the Families tab: skipping
-- the car line, EC (exceptional children) needs, or an open-ended "other"
-- case with a free-text note.
--
-- Booleans rather than a separate tags table: this is a small, fixed set of
-- known categories (not admin-defined/extensible), so a join table would be
-- more machinery than the feature needs.

ALTER TABLE public.families
  ADD COLUMN skip_car_line boolean NOT NULL DEFAULT false,
  ADD COLUMN ec_needs      boolean NOT NULL DEFAULT false,
  ADD COLUMN other_flag    boolean NOT NULL DEFAULT false,
  ADD COLUMN other_flag_note text;

COMMENT ON COLUMN public.families.skip_car_line IS
  'True if this family should skip the car line (special dismissal handling).';
COMMENT ON COLUMN public.families.ec_needs IS
  'True if this family has an EC (exceptional children) need flagged for staff awareness.';
COMMENT ON COLUMN public.families.other_flag IS
  'True if this family has some other special-handling need; details in other_flag_note.';
COMMENT ON COLUMN public.families.other_flag_note IS
  'Free-text detail for other_flag. Not meaningful unless other_flag is true.';
