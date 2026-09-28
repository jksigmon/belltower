-- ============================================================
-- Fixes repeated statement timeouts (57014) on the staff portal
-- immediately before dismissal, first reported 2026-09-28 (teachers
-- "kicked out" of Bell Tower right before 3pm carline).
--
-- Root cause: staff.html's two nav-gate checks (showMyRosterNavIfHomeroomTeacher,
-- showStudentLookupNavIfScheduleExists) ran on EVERY staff portal page load,
-- querying the student_schedule view for existence via limit(1). That view's
-- homeroom branch (added in 20260821000002_homeroom_schedule_from_student_record.sql)
-- is a LEFT JOIN LATERAL evaluated once per active student in the school just
-- to borrow a label/period for display -- irrelevant to a pure existence
-- check, but not something limit(1) reliably short-circuits before it runs,
-- especially wrapped in the view's security_invoker RLS. Under concurrent
-- load (many teachers loading the portal at once ahead of dismissal) this
-- was enough to blow statement_timeout repeatedly and take unrelated
-- queries down with it (observed: pto_requests 500s and an auth token
-- refresh 504 in the same window).
--
-- Fix: a SECURITY DEFINER function that answers the same boolean directly
-- against the underlying tables, skipping the view, its LATERAL, and its
-- per-row RLS entirely. The homeroom branch here is deliberately NOT a port
-- of the view's LATERAL -- existence doesn't need the label/period lookup,
-- so it's a plain students-table filter (already covered by
-- idx_students_school_active). The section branch mirrors the view's
-- section logic (published boards, current academic year).
--
-- current_user_is_active_in_school() is the same same-school gate the
-- underlying tables' own RLS already enforces (see
-- 20260812000004_fix_students_employees_bus_groups_rls_perf.sql), evaluated
-- once here instead of once per row.
-- ============================================================

CREATE OR REPLACE FUNCTION public.staff_has_current_schedule(
  p_school_id uuid,
  p_teacher_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $$
  SELECT public.current_user_is_active_in_school(p_school_id)
     AND (
       -- Homeroom: students.homeroom_teacher_id is authoritative and always
       -- "current" (no academic_year concept on this field) -- see
       -- 20260821000002 for why the view treats it that way.
       EXISTS (
         SELECT 1
         FROM public.students st
         WHERE st.school_id = p_school_id
           AND st.active = true
           AND st.homeroom_teacher_id IS NOT NULL
           AND (p_teacher_id IS NULL OR st.homeroom_teacher_id = p_teacher_id)
       )
       OR
       -- Sections: published boards for the school's current academic year.
       EXISTS (
         SELECT 1
         FROM public.placement_assignments pa
         JOIN public.placement_sessions ps ON ps.id = pa.session_id
         JOIN public.students st           ON st.id = pa.student_id
         WHERE ps.school_id    = p_school_id
           AND (p_teacher_id IS NULL OR pa.teacher_id = p_teacher_id)
           AND ps.session_kind = 'section'
           AND ps.status       = 'published'
           AND ps.deleted_at  IS NULL
           AND ps.archived_at IS NULL
           AND ps.academic_year = (
                 SELECT sc.current_academic_year
                   FROM public.schools sc
                  WHERE sc.id = p_school_id
               )
           AND st.active = true
           AND (pa.teacher_id IS NOT NULL OR pa.assigned_col_id IS NOT NULL)
       )
     );
$$;

COMMENT ON FUNCTION public.staff_has_current_schedule(uuid, uuid) IS
  'Cheap existence check behind the staff portal My Roster / Student Lookup / Class Rosters nav links. Deliberately not a port of student_schedule''s LATERAL (that only exists to enrich display data, irrelevant to existence). p_teacher_id NULL means "does the school have any schedule at all"; same same-school gate as the underlying tables'' own RLS, evaluated once instead of per row.';

GRANT EXECUTE ON FUNCTION public.staff_has_current_schedule(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_has_current_schedule(uuid, uuid) TO service_role;

-- Supporting indexes for the section branch -- both were missing entirely
-- (FKs don't auto-index in Postgres), forcing a sequential scan of
-- placement_assignments and/or placement_sessions per call.
CREATE INDEX IF NOT EXISTS placement_assignments_session_idx
    ON public.placement_assignments (session_id);

CREATE INDEX IF NOT EXISTS placement_sessions_school_status_idx
    ON public.placement_sessions (school_id, status)
    WHERE deleted_at IS NULL AND archived_at IS NULL;
