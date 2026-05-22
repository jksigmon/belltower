-- Migration: employees_add_is_teacher
-- Adds a boolean flag to quickly identify teacher employees without
-- relying on free-text position matching at query time.

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS is_teacher boolean NOT NULL DEFAULT false;

-- Backfill: mark any employee whose position contains "teacher" (case-insensitive)
UPDATE public.employees
SET is_teacher = true
WHERE position ILIKE '%teacher%';
