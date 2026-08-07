-- placement_flags and student_placement_flags have accumulated multiple overlapping
-- RLS policies from several migrations that were never cleaned up (some also contain
-- a `profiles.id = auth.uid()` bug — should be `profiles.user_id`, so those clauses
-- never match anyone but still cost a subquery per row). Each row in a join has to
-- evaluate every permissive policy, which is what caused the Student Directory query
-- to time out. Consolidates down to one SELECT + one write policy per table, matching
-- the intended design from 20260603000003_fix_placement_rls.sql, and removes an
-- overly-broad grant that let any active school member (not just can_manage_placement
-- holders) write to these tables.

DROP POLICY IF EXISTS "placement_flags_all" ON public.placement_flags;
DROP POLICY IF EXISTS "placement_flags_select" ON public.placement_flags;
DROP POLICY IF EXISTS "placement_flags_school_isolation" ON public.placement_flags;
DROP POLICY IF EXISTS "school members can manage their placement flags" ON public.placement_flags;
DROP POLICY IF EXISTS "placement_flags_read" ON public.placement_flags;
DROP POLICY IF EXISTS "placement_flags_write" ON public.placement_flags;

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

DROP POLICY IF EXISTS "student_placement_flags_all" ON public.student_placement_flags;
DROP POLICY IF EXISTS "student_placement_flags_school_isolation" ON public.student_placement_flags;
DROP POLICY IF EXISTS "school members can manage their student placement flags" ON public.student_placement_flags;
DROP POLICY IF EXISTS "student_placement_flags_read" ON public.student_placement_flags;
DROP POLICY IF EXISTS "student_placement_flags_write" ON public.student_placement_flags;

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
