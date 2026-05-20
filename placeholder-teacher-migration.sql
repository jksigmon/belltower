-- placeholder-teacher-migration.sql
-- Allows "Open Position" placeholder columns on placement boards
-- Run this in the Supabase SQL editor

-- ── Step 1: Add a surrogate id column ────────────────────────────────────
-- The table currently uses (session_id, teacher_id) as its composite PK.
-- We need a standalone id so placeholder rows (no teacher_id) can exist
-- and so assigned_col_id can reference individual rows.
ALTER TABLE public.placement_session_teachers
  ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();

-- Populate id for any existing rows that don't have one yet
UPDATE public.placement_session_teachers
  SET id = gen_random_uuid()
  WHERE id IS NULL;

-- Make the new column NOT NULL now that all rows have a value
ALTER TABLE public.placement_session_teachers
  ALTER COLUMN id SET NOT NULL;

-- ── Step 2: Swap the primary key ─────────────────────────────────────────
ALTER TABLE public.placement_session_teachers
  DROP CONSTRAINT placement_session_teachers_pkey;

ALTER TABLE public.placement_session_teachers
  ADD PRIMARY KEY (id);

-- ── Step 3: Make teacher_id nullable ─────────────────────────────────────
-- (was part of the PK, so this is now safe)
ALTER TABLE public.placement_session_teachers
  ALTER COLUMN teacher_id DROP NOT NULL;

-- ── Step 4: Add placeholder_name ─────────────────────────────────────────
ALTER TABLE public.placement_session_teachers
  ADD COLUMN IF NOT EXISTS placeholder_name text;

-- ── Step 5: Enforce teacher_id OR placeholder_name must be present ────────
ALTER TABLE public.placement_session_teachers
  ADD CONSTRAINT placement_session_teachers_teacher_or_placeholder
    CHECK (teacher_id IS NOT NULL OR placeholder_name IS NOT NULL);

-- ── Step 6: Partial unique index (replaces old composite PK uniqueness) ───
-- One real teacher per session; multiple placeholders are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS placement_session_teachers_session_teacher_uniq
  ON public.placement_session_teachers(session_id, teacher_id)
  WHERE teacher_id IS NOT NULL;

-- ── Step 7: Add assigned_col_id to placement_assignments ─────────────────
-- For real-teacher assignments: teacher_id is set, assigned_col_id is null.
-- For placeholder assignments:  teacher_id is null, assigned_col_id = PST row id.
-- For unplaced:                  both null.
ALTER TABLE public.placement_assignments
  ADD COLUMN IF NOT EXISTS assigned_col_id uuid
    REFERENCES public.placement_session_teachers(id) ON DELETE SET NULL;
