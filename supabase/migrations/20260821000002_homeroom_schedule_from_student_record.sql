-- ============================================================
-- student_schedule: source homeroom from students.homeroom_teacher_id,
-- not from placement_assignments
--
-- students.homeroom_teacher_id can be set three ways that never touch
-- placement_assignments at all: the Student Directory drawer's edit form
-- (admin.students.js saveEditStudent), its add-student form
-- (createStudent), and bulk CSV import (bulk_upload_commit, an edge
-- function with no placement concept whatsoever). All three are real,
-- necessary paths -- bulk import is how most schools populate homerooms
-- at all, and forcing every mid-year homeroom correction through opening
-- a placement board would be a real workflow regression.
--
-- The previous version of this view built its homeroom rows entirely
-- from placement_assignments, so a student whose homeroom was ever set
-- through one of those three paths was invisible to My Roster, Class
-- Rosters, and Student Lookup -- even though carline, roster exports,
-- and compliance scoping all read homeroom correctly, because they read
-- students.homeroom_teacher_id directly like they always have.
--
-- A plain "add a fallback row when no placement_assignments row exists"
-- fix is not enough: if a student WAS on a committed board and is later
-- reassigned through the drawer, a placement_assignments row still
-- exists (from the original commit) -- it is just stale, pointing at the
-- old teacher. A NOT-EXISTS fallback would skip that student entirely
-- and the view would keep showing the wrong teacher.
--
-- So this migration doesn't add a fallback -- it flips which side is
-- authoritative. Homeroom rows are now built starting from
-- students.homeroom_teacher_id, the same field every other part of the
-- app already trusts. A live committed board is joined in only to borrow
-- its label/period for a nicer display, matched on (student, teacher) so
-- a stale board can never override the real value -- if nothing matches,
-- the row still appears, just labeled plain "Homeroom" with no period.
--
-- Section rows are untouched. There is no students.core_2_teacher_id or
-- equivalent -- sections only ever existed in placement_assignments, so
-- there is nothing to reconcile there and no fallback is possible or
-- needed.
-- ============================================================

-- The homeroom branch below does one correlated lookup per active
-- student with a homeroom set, keyed on (student_id, teacher_id). This
-- view is now the read path for My Roster, Class Rosters, Student
-- Lookup, and the admin grid, so it is worth indexing rather than
-- leaving it to a sequential scan of placement_assignments per student.
CREATE INDEX IF NOT EXISTS placement_assignments_student_teacher_idx
    ON public.placement_assignments (student_id, teacher_id);

DROP VIEW IF EXISTS public.student_schedule;
CREATE VIEW public.student_schedule
WITH (security_invoker = true) AS

/* ---------- Sections: unchanged, placement_assignments is still the only source ---------- */
SELECT ps.school_id,
       pa.student_id,
       ps.id                                    AS session_id,
       ps.label                                 AS section_label,
       ps.session_kind,
       ps.academic_year,
       (ps.academic_year = sc.current_academic_year) AS is_current_year,
       ps.period_id,
       sp.label                                 AS period_label,
       sp.short_label                           AS period_short_label,
       COALESCE(sp.sort_order, 9999)            AS period_sort_order,
       pa.teacher_id,
       te.first_name                            AS teacher_first_name,
       te.last_name                             AS teacher_last_name,
       pst.placeholder_name,
       ps.schedule_updated_at
  FROM public.placement_assignments pa
  JOIN public.placement_sessions ps  ON ps.id = pa.session_id
  JOIN public.students st            ON st.id = pa.student_id
  JOIN public.schools sc             ON sc.id = ps.school_id
  LEFT JOIN public.schedule_periods sp        ON sp.id = ps.period_id
  LEFT JOIN public.placement_session_teachers pst ON pst.id = pa.assigned_col_id
  LEFT JOIN public.employees te               ON te.id = pa.teacher_id
 WHERE ps.session_kind = 'section'
   AND ps.status       = 'published'
   AND ps.deleted_at  IS NULL
   AND ps.archived_at IS NULL
   AND st.active = true
   AND (pa.teacher_id IS NOT NULL OR pa.assigned_col_id IS NOT NULL)

UNION ALL

/* ---------- Homeroom: driven by students.homeroom_teacher_id ---------- */
-- No year concept on this field -- whatever it currently says IS the
-- student's homeroom, full stop, same as carline/rosters/compliance
-- already assume. So a row here always counts as current year: when no
-- board agrees, is_current_year falls back to comparing against
-- schools.current_academic_year directly rather than any board's stated
-- year, which would otherwise be NULL and wrongly hide the row.
SELECT st.school_id,
       st.id                                    AS student_id,
       board.id                                 AS session_id,
       COALESCE(board.label, 'Homeroom')        AS section_label,
       'homeroom'::text                         AS session_kind,
       COALESCE(board.academic_year, sc.current_academic_year) AS academic_year,
       true                                      AS is_current_year,
       board.period_id,
       sp.label                                 AS period_label,
       sp.short_label                           AS period_short_label,
       COALESCE(sp.sort_order, 9999)            AS period_sort_order,
       st.homeroom_teacher_id                   AS teacher_id,
       te.first_name                            AS teacher_first_name,
       te.last_name                             AS teacher_last_name,
       NULL::text                                AS placeholder_name,
       board.schedule_updated_at
  FROM public.students st
  JOIN public.schools sc        ON sc.id = st.school_id
  LEFT JOIN public.employees te ON te.id = st.homeroom_teacher_id
  -- Best-effort match to the board that produced this homeroom, purely
  -- for display (label, period). Keyed on teacher, not just student: a
  -- board committed for a DIFFERENT teacher than the student's current
  -- homeroom is stale and must not be borrowed from -- committed_at DESC
  -- picks the most recent agreeing commit if more than one somehow does.
  LEFT JOIN LATERAL (
        SELECT ps2.id, ps2.label, ps2.academic_year, ps2.period_id, ps2.schedule_updated_at
          FROM public.placement_assignments pa2
          JOIN public.placement_sessions ps2 ON ps2.id = pa2.session_id
         WHERE pa2.student_id  = st.id
           AND pa2.teacher_id  = st.homeroom_teacher_id
           AND ps2.session_kind = 'homeroom'
           AND ps2.status       = 'committed'
           AND ps2.deleted_at  IS NULL
           AND ps2.archived_at IS NULL
         ORDER BY ps2.committed_at DESC NULLS LAST
         LIMIT 1
       ) board ON true
  LEFT JOIN public.schedule_periods sp ON sp.id = board.period_id
 WHERE st.homeroom_teacher_id IS NOT NULL
   AND st.active = true;

COMMENT ON VIEW public.student_schedule IS
  'One row per student per live class. Sections come from published placement boards (the only place that data exists). Homeroom comes from students.homeroom_teacher_id (the field carline/rosters/compliance already trust) enriched with board label/period when a live committed board agrees with it -- see the migration for why a stale board must not override this. Callers should filter is_current_year unless deliberately looking at a past year.';
