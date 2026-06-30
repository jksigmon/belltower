-- ============================================================================
-- Placement: realign existing boards to the single-grade model
-- ============================================================================
-- Context:
--   Class placement boards used to store a "rising" pair: incoming_grade (the
--   students' grade when placed) and target_grade (= the next grade up). Sync
--   and the roster pull key off incoming_grade.
--
--   Revolution Academy ran Year-End Promotion BEFORE finishing placement, so the
--   students placed on a board are now sitting in target_grade. Their boards
--   still sync on the old incoming_grade, which pulls the wrong cohort.
--
--   The app now uses a single grade per board (= the students' actual current
--   grade_level). This script realigns existing DRAFT boards so incoming_grade
--   matches the grade the placed students are actually in now (target_grade).
--
-- What this touches:
--   ONLY placement_sessions.incoming_grade. It does NOT modify
--   placement_assignments (the placements already made) or placement_flags
--   (the flags on students). Those are preserved exactly as-is.
--
-- Safety:
--   * Scoped to one school and to draft (uncommitted) sessions.
--   * Idempotent: only rows still carrying the old offset are changed.
--   * Run the SELECTs first and confirm the rows look right before the UPDATE.
--
-- Before running: confirm the school name matches your data (adjust if needed).
-- ============================================================================

-- 0. Confirm the school resolves to exactly one row.
select id, name from public.schools where name = 'Revolution Academy';

-- 1. PREVIEW — every board for this school, with the change that will be applied.
--    "new_incoming_grade" is what incoming_grade will become.
select
  ps.id,
  ps.label,
  ps.academic_year,
  ps.status,
  ps.incoming_grade                              as current_incoming_grade,
  ps.target_grade,
  ps.target_grade                                as new_incoming_grade,
  (select count(*) from public.placement_assignments pa
     where pa.session_id = ps.id)                as assignment_count
from public.placement_sessions ps
where ps.school_id = (select id from public.schools where name = 'Revolution Academy')
order by ps.created_at;

-- 2. APPLY — realign draft boards. incoming_grade := target_grade.
--    placement_assignments and placement_flags are not referenced and stay intact.
update public.placement_sessions ps
set incoming_grade = ps.target_grade
where ps.school_id   = (select id from public.schools where name = 'Revolution Academy')
  and ps.status      = 'draft'
  and ps.target_grade is not null
  and ps.target_grade <> ps.incoming_grade;

-- 3. VERIFY — boards now show incoming_grade = target_grade, and the assignment
--    counts are unchanged from the preview above (nothing was added or removed).
select
  ps.id,
  ps.label,
  ps.status,
  ps.incoming_grade,
  ps.target_grade,
  (select count(*) from public.placement_assignments pa
     where pa.session_id = ps.id)                as assignment_count
from public.placement_sessions ps
where ps.school_id = (select id from public.schools where name = 'Revolution Academy')
order by ps.created_at;
