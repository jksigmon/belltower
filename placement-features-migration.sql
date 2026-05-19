-- ======================================================================
-- Placement module: security + features migration
-- Adds: target_class_size column, RLS policies for all placement tables
-- Run once in Supabase SQL editor.
-- ======================================================================

-- ── 1. Add target class size to placement sessions ────────────────────
ALTER TABLE public.placement_sessions
  ADD COLUMN IF NOT EXISTS target_class_size integer;


-- ── 2. RLS policies: placement_sessions ──────────────────────────────
DROP POLICY IF EXISTS "placement_sessions_school_isolation" ON public.placement_sessions;
CREATE POLICY "placement_sessions_school_isolation"
  ON public.placement_sessions
  USING (school_id = (SELECT school_id FROM public.profiles WHERE id = auth.uid()))
  WITH CHECK (school_id = (SELECT school_id FROM public.profiles WHERE id = auth.uid()));


-- ── 3. RLS policies: placement_session_teachers ───────────────────────
DROP POLICY IF EXISTS "placement_session_teachers_school_isolation" ON public.placement_session_teachers;
CREATE POLICY "placement_session_teachers_school_isolation"
  ON public.placement_session_teachers
  USING (
    session_id IN (
      SELECT id FROM public.placement_sessions
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE id = auth.uid())
    )
  )
  WITH CHECK (
    session_id IN (
      SELECT id FROM public.placement_sessions
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE id = auth.uid())
    )
  );


-- ── 4. RLS policies: placement_assignments ────────────────────────────
DROP POLICY IF EXISTS "placement_assignments_school_isolation" ON public.placement_assignments;
CREATE POLICY "placement_assignments_school_isolation"
  ON public.placement_assignments
  USING (
    session_id IN (
      SELECT id FROM public.placement_sessions
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE id = auth.uid())
    )
  )
  WITH CHECK (
    session_id IN (
      SELECT id FROM public.placement_sessions
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE id = auth.uid())
    )
  );


-- ── 5. RLS policies: placement_flags ─────────────────────────────────
DROP POLICY IF EXISTS "placement_flags_school_isolation" ON public.placement_flags;
CREATE POLICY "placement_flags_school_isolation"
  ON public.placement_flags
  USING (school_id = (SELECT school_id FROM public.profiles WHERE id = auth.uid()))
  WITH CHECK (school_id = (SELECT school_id FROM public.profiles WHERE id = auth.uid()));


-- ── 6. RLS policies: student_placement_flags ─────────────────────────
DROP POLICY IF EXISTS "student_placement_flags_school_isolation" ON public.student_placement_flags;
CREATE POLICY "student_placement_flags_school_isolation"
  ON public.student_placement_flags
  USING (
    flag_id IN (
      SELECT id FROM public.placement_flags
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE id = auth.uid())
    )
  )
  WITH CHECK (
    flag_id IN (
      SELECT id FROM public.placement_flags
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE id = auth.uid())
    )
  );
