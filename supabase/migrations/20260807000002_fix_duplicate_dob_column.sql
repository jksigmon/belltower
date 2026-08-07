-- The IC sync was mistakenly built against a new `date_of_birth` column instead of the
-- pre-existing `birthdate` column that the rest of Belltower's admin UI actually reads
-- and writes. Every DOB the sync has written so far went into a column nothing else
-- looks at. Backfill birthdate from date_of_birth wherever IC's sync had a value and
-- the real column doesn't, then drop the duplicate.

UPDATE public.students
SET birthdate = date_of_birth
WHERE date_of_birth IS NOT NULL AND birthdate IS NULL;

ALTER TABLE public.students DROP COLUMN date_of_birth;
