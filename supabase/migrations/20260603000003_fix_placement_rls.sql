-- All placement table RLS policies used `profiles WHERE id = auth.uid()`,
-- comparing profiles.id (a random UUID PK) to auth.uid() (the auth user ID).
-- This always returns NULL, blocking everyone. Fix: use profiles.user_id = auth.uid().
-- Also splits the single catch-all policy per table into proper SELECT vs write policies
-- so that any same-school user can read, but only can_manage_placement users can write.

-- ── placement_sessions ────────────────────────────────────────────────
DROP POLICY IF EXISTS "placement_sessions_school_isolation" ON public.placement_sessions;

CREATE POLICY placement_sessions_read ON public.placement_sessions FOR SELECT
  USING (school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1));

CREATE POLICY placement_sessions_write ON public.placement_sessions FOR ALL
  USING (
    school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    AND (
      (SELECT is_superadmin FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
      OR (SELECT role FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = 'admin'
      OR (SELECT can_manage_placement FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
    )
  )
  WITH CHECK (
    school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    AND (
      (SELECT is_superadmin FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
      OR (SELECT role FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = 'admin'
      OR (SELECT can_manage_placement FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
    )
  );


-- ── placement_session_teachers ────────────────────────────────────────
DROP POLICY IF EXISTS "placement_session_teachers_school_isolation" ON public.placement_session_teachers;

CREATE POLICY placement_session_teachers_read ON public.placement_session_teachers FOR SELECT
  USING (
    session_id IN (
      SELECT id FROM public.placement_sessions
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    )
  );

CREATE POLICY placement_session_teachers_write ON public.placement_session_teachers FOR ALL
  USING (
    session_id IN (
      SELECT id FROM public.placement_sessions
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    )
    AND (
      (SELECT is_superadmin FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
      OR (SELECT role FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = 'admin'
      OR (SELECT can_manage_placement FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
    )
  )
  WITH CHECK (
    session_id IN (
      SELECT id FROM public.placement_sessions
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    )
    AND (
      (SELECT is_superadmin FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
      OR (SELECT role FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = 'admin'
      OR (SELECT can_manage_placement FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
    )
  );


-- ── placement_assignments ─────────────────────────────────────────────
DROP POLICY IF EXISTS "placement_assignments_school_isolation" ON public.placement_assignments;

CREATE POLICY placement_assignments_read ON public.placement_assignments FOR SELECT
  USING (
    session_id IN (
      SELECT id FROM public.placement_sessions
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    )
  );

CREATE POLICY placement_assignments_write ON public.placement_assignments FOR ALL
  USING (
    session_id IN (
      SELECT id FROM public.placement_sessions
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    )
    AND (
      (SELECT is_superadmin FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
      OR (SELECT role FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = 'admin'
      OR (SELECT can_manage_placement FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
    )
  )
  WITH CHECK (
    session_id IN (
      SELECT id FROM public.placement_sessions
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    )
    AND (
      (SELECT is_superadmin FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
      OR (SELECT role FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = 'admin'
      OR (SELECT can_manage_placement FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
    )
  );


-- ── placement_flags ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "placement_flags_school_isolation" ON public.placement_flags;

CREATE POLICY placement_flags_read ON public.placement_flags FOR SELECT
  USING (school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1));

CREATE POLICY placement_flags_write ON public.placement_flags FOR ALL
  USING (
    school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    AND (
      (SELECT is_superadmin FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
      OR (SELECT role FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = 'admin'
      OR (SELECT can_manage_placement FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
    )
  )
  WITH CHECK (
    school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    AND (
      (SELECT is_superadmin FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
      OR (SELECT role FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = 'admin'
      OR (SELECT can_manage_placement FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
    )
  );


-- ── student_placement_flags ───────────────────────────────────────────
DROP POLICY IF EXISTS "student_placement_flags_school_isolation" ON public.student_placement_flags;

CREATE POLICY student_placement_flags_read ON public.student_placement_flags FOR SELECT
  USING (
    flag_id IN (
      SELECT id FROM public.placement_flags
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    )
  );

CREATE POLICY student_placement_flags_write ON public.student_placement_flags FOR ALL
  USING (
    flag_id IN (
      SELECT id FROM public.placement_flags
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    )
    AND (
      (SELECT is_superadmin FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
      OR (SELECT role FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = 'admin'
      OR (SELECT can_manage_placement FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
    )
  )
  WITH CHECK (
    flag_id IN (
      SELECT id FROM public.placement_flags
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    )
    AND (
      (SELECT is_superadmin FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
      OR (SELECT role FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = 'admin'
      OR (SELECT can_manage_placement FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
    )
  );
