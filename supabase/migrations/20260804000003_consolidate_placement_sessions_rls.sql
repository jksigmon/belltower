-- Same root cause as 20260804000002: 20260603000003_fix_placement_rls.sql was never
-- actually applied to prod (only its placement_flags portion has since been patched).
-- placement_sessions, placement_session_teachers, and placement_assignments still carry
-- the original overlapping/buggy policies: a `profiles.id = auth.uid()` bug (dead clause,
-- still costs a subquery per row) and an overly-broad "school members can manage" grant
-- with no permission check (any active user, not just can_manage_placement holders).
-- Consolidates to one SELECT + one write policy per table, matching the intended design.

DROP POLICY IF EXISTS "placement_sessions_all" ON public.placement_sessions;
DROP POLICY IF EXISTS "placement_sessions_select" ON public.placement_sessions;
DROP POLICY IF EXISTS "placement_sessions_school_isolation" ON public.placement_sessions;
DROP POLICY IF EXISTS "school members can manage their placement sessions" ON public.placement_sessions;
DROP POLICY IF EXISTS "placement_sessions_read" ON public.placement_sessions;
DROP POLICY IF EXISTS "placement_sessions_write" ON public.placement_sessions;

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

DROP POLICY IF EXISTS "placement_session_teachers_all" ON public.placement_session_teachers;
DROP POLICY IF EXISTS "placement_session_teachers_school_isolation" ON public.placement_session_teachers;
DROP POLICY IF EXISTS "school members can manage their session teachers" ON public.placement_session_teachers;
DROP POLICY IF EXISTS "placement_session_teachers_read" ON public.placement_session_teachers;
DROP POLICY IF EXISTS "placement_session_teachers_write" ON public.placement_session_teachers;

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

DROP POLICY IF EXISTS "placement_assignments_school_isolation" ON public.placement_assignments;
DROP POLICY IF EXISTS "school members can manage their placement assignments" ON public.placement_assignments;
DROP POLICY IF EXISTS "placement_assignments_read" ON public.placement_assignments;
DROP POLICY IF EXISTS "placement_assignments_write" ON public.placement_assignments;

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
