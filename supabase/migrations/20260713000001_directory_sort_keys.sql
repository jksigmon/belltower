-- ============================================================
-- Numeric sort keys for directory sorting
--
-- carline_tag_number and grade_level are text, so ordering by
-- them is lexicographic ('233' < '24', '10' < '2'). Generated
-- integer columns give PostgREST a proper numeric sort target.
-- Generated columns are computed by Postgres on write — no app
-- code changes needed to keep them in sync.
-- ============================================================

-- Family carline tag as integer ('23' → 23; non-numeric → NULL)
ALTER TABLE public.families
  ADD COLUMN IF NOT EXISTS carline_tag_sort integer
  GENERATED ALWAYS AS (
    NULLIF(regexp_replace(carline_tag_number, '[^0-9]', '', 'g'), '')::integer
  ) STORED;

-- Student grade level in GRADE_ORDER position (PK=-2, K=-1, 1..12)
ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS grade_sort integer
  GENERATED ALWAYS AS (
    CASE
      WHEN grade_level = 'PK' THEN -2
      WHEN grade_level = 'K'  THEN -1
      WHEN grade_level ~ '^[0-9]+$' THEN grade_level::integer
      ELSE NULL
    END
  ) STORED;
