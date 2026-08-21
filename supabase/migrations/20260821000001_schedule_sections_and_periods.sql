-- ============================================================
-- Scheduling: section boards, periods, and the student schedule view
--
-- Placement boards until now had exactly one meaning: "who is in whose
-- homeroom". Committing a board writes students.homeroom_teacher_id,
-- which is the key carline dismissal, roster exports, compliance report
-- scoping, and the staff portal's My Roster all hang off.
--
-- But schools also build boards for the OTHER classes a student rotates
-- through -- Core 1..4 in lower school, Block A..D in upper school. Those
-- boards can never be committed, because committing them would repoint
-- every student's homeroom and scramble dismissal. So they sit in Draft
-- forever, and the only way to see them is to open the board in the admin
-- tool with can_manage_placement. Teachers end up asking an admin every
-- time a schedule changes.
--
-- This migration gives a board a PURPOSE, and adds a read surface:
--
--   session_kind = 'homeroom'  -> unchanged. Commit writes homeroom.
--   session_kind = 'section'   -> Publish. Writes nothing to students;
--                                 the board becomes visible to teachers
--                                 through the student_schedule view.
--
-- Deliberately reuses the placement board as the section editor rather
-- than introducing parallel sections/enrollments tables. The boards
-- already hold this data -- every draft Core board is a complete, correct
-- section roster today. A parallel model would mean maintaining the same
-- rosters twice and giving up drag-drop, placement flags, class-size
-- validation, and realtime collaboration.
--
-- Key invariant, enforced below: a student may sit in at most one LIVE
-- board per (period, academic year). "Live" spans both kinds -- a
-- committed homeroom board tagged Core 1 conflicts with a published
-- section tagged Core 1, because the student cannot be in two Core 1s.
-- The guard is keyed on (student, period, year) rather than
-- (grade, period) on purpose: that is what lets a section hold a subset
-- of a grade (electives) or students from several grades (mixed-grade
-- upper school courses) without any further schema change.
-- ============================================================


/* ---------- 0. Preflight: confirm placement_sessions.status ---------- */
-- A CHECK constraint is added further down. status is a plain text column
-- with no constraint today, so anything unexpected in it would make that
-- ALTER fail with a message that does not explain itself. Fail early and
-- loudly instead.
DO $$
DECLARE
    bad text;
BEGIN
    SELECT string_agg(DISTINCT status, ', ')
      INTO bad
      FROM public.placement_sessions
     WHERE status IS NULL OR status NOT IN ('draft', 'committed');

    IF bad IS NOT NULL THEN
        RAISE EXCEPTION
            'placement_sessions.status holds unexpected value(s): %. Expected only draft/committed. Reconcile these rows before running this migration.',
            bad;
    END IF;
END;
$$;


/* ---------- 1. The school's current academic year ---------- */
-- placement_sessions.academic_year is free text ('2026-2027') and nothing
-- recorded which year was CURRENT. Without that, a schedule view has no
-- way to pick between this year's published sections and last year's --
-- they are equally valid rows. Year-End Promotion makes this acute: it
-- bumps students.grade_level, so last year's boards keep pointing at
-- students who have since moved up a grade.
ALTER TABLE public.schools
    ADD COLUMN IF NOT EXISTS current_academic_year text;

COMMENT ON COLUMN public.schools.current_academic_year IS
  'The academic year ("2026-2027") that schedule and roster views should treat as current. Must match placement_sessions.academic_year to line up. Advance this as part of Year-End Promotion.';

-- Backfill from the newest board each school actually has, so existing
-- schools are not left null. Schools with no boards stay null and are
-- prompted to set it in the UI.
UPDATE public.schools s
   SET current_academic_year = latest.academic_year
  FROM (
        SELECT DISTINCT ON (school_id) school_id, academic_year
          FROM public.placement_sessions
         WHERE deleted_at IS NULL
           AND academic_year IS NOT NULL
         ORDER BY school_id, academic_year DESC
       ) latest
 WHERE latest.school_id = s.id
   AND s.current_academic_year IS NULL;


/* ---------- 2. Periods (Core 1..4, Block A..D, Advisory, ...) ---------- */
-- Named per school, because "Core 2" and "Block C" are the same concept
-- wearing different local vocabulary.
--
-- grade_levels scopes a period to the grades it applies to, so one school
-- can run Cores for K-7 and Blocks for 8-12 without the two showing up in
-- each other's dropdowns. NULL means "all grades" (e.g. a school-wide
-- Advisory). Chosen over a campus_id because placement boards carry a
-- grade but no campus, and a single-campus school running both lower and
-- upper school divisions would get no separation from campus at all.
CREATE TABLE IF NOT EXISTS public.schedule_periods (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id    uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    label        text NOT NULL,
    short_label  text,
    grade_levels text[],
    sort_order   integer NOT NULL DEFAULT 0,
    archived_at  timestamp with time zone,
    created_at   timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT schedule_periods_label_not_blank CHECK (btrim(label) <> ''),
    CONSTRAINT schedule_periods_school_label_unique UNIQUE (school_id, label)
);

CREATE INDEX IF NOT EXISTS schedule_periods_school_sort_idx
    ON public.schedule_periods (school_id, sort_order);

ALTER TABLE public.schedule_periods ENABLE ROW LEVEL SECURITY;

-- Read: any active staff member in the school. Teachers need this to
-- render their own schedule, so it cannot be gated on can_manage_placement.
-- Uses the SECURITY DEFINER helper from 20260812000001 rather than a raw
-- EXISTS on profiles -- see that migration for why the raw form causes a
-- per-row re-entry into profiles' own RLS.
DROP POLICY IF EXISTS schedule_periods_read ON public.schedule_periods;
CREATE POLICY schedule_periods_read ON public.schedule_periods
    FOR SELECT USING (public.current_user_is_active_in_school(schedule_periods.school_id));

-- Write: same audience that manages placement boards.
DROP POLICY IF EXISTS schedule_periods_write ON public.schedule_periods;
CREATE POLICY schedule_periods_write ON public.schedule_periods
    FOR ALL USING (
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

COMMENT ON TABLE public.schedule_periods IS
  'Named slots in the school day (Core 1-4, Block A-D, Advisory). grade_levels scopes a period to certain grades; NULL means all grades.';


/* ---------- 3. Board purpose, period, and publish state ---------- */
ALTER TABLE public.placement_sessions
    ADD COLUMN IF NOT EXISTS session_kind        text NOT NULL DEFAULT 'homeroom',
    ADD COLUMN IF NOT EXISTS period_id           uuid REFERENCES public.schedule_periods(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS published_at        timestamp with time zone,
    ADD COLUMN IF NOT EXISTS schedule_updated_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS placement_sessions_period_idx
    ON public.placement_sessions (school_id, period_id)
    WHERE period_id IS NOT NULL;

-- Existing boards are all homeroom boards; the column default backfills
-- them correctly and their committed status is left untouched.
ALTER TABLE public.placement_sessions
    DROP CONSTRAINT IF EXISTS placement_sessions_kind_check;
ALTER TABLE public.placement_sessions
    ADD CONSTRAINT placement_sessions_kind_check
    CHECK (session_kind IN ('homeroom', 'section'));

ALTER TABLE public.placement_sessions
    DROP CONSTRAINT IF EXISTS placement_sessions_status_check;
ALTER TABLE public.placement_sessions
    ADD CONSTRAINT placement_sessions_status_check
    CHECK (status IN ('draft', 'committed', 'published'));

-- The two live states are not interchangeable, and confusing them is the
-- exact failure this migration exists to prevent:
--   'committed' means students.homeroom_teacher_id was written.
--   'published' means nothing outside the board was touched.
-- A section board must never reach 'committed' (it would imply a homeroom
-- write that never happened, and Undo Commit would then clear real
-- homerooms using prev_homeroom_teacher_id rows that were never captured).
ALTER TABLE public.placement_sessions
    DROP CONSTRAINT IF EXISTS placement_sessions_kind_status_check;
ALTER TABLE public.placement_sessions
    ADD CONSTRAINT placement_sessions_kind_status_check
    CHECK (
        NOT (session_kind = 'section'  AND status = 'committed')
        AND
        NOT (session_kind = 'homeroom' AND status = 'published')
    );

COMMENT ON COLUMN public.placement_sessions.session_kind IS
  'homeroom = committing writes students.homeroom_teacher_id (drives carline, rosters, compliance scoping). section = publishing exposes the board through student_schedule and writes nothing to students.';

COMMENT ON COLUMN public.placement_sessions.period_id IS
  'Which slot in the day this board covers. Set on section boards; also valid on a homeroom board whose homeroom doubles as a period (e.g. "6th grade core 1 & HR").';

COMMENT ON COLUMN public.placement_sessions.schedule_updated_at IS
  'Last time a published section board''s assignments changed. Surfaced to teachers as "Updated <date>" so a live-read schedule shows its own freshness.';


/* ---------- 4. Kind is only changeable while the board is a draft ---------- */
-- Draft -> section is safe: nothing has been written to students.
-- Committed -> section is NOT: the homeroom write already happened, and
-- placement_assignments.prev_homeroom_teacher_id is the only record of
-- what to restore. Flipping kind would strand those rows and leave real
-- homerooms pointing at section teachers with no way back.
-- Recovery path for a board committed by mistake is Undo Commit first
-- (which restores prev homerooms and returns the board to draft), then
-- change the kind.
CREATE OR REPLACE FUNCTION public.assert_session_kind_change_allowed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.session_kind IS DISTINCT FROM OLD.session_kind
       AND OLD.status <> 'draft' THEN
        RAISE EXCEPTION
            'This board is %, so its type cannot be changed. Revert it to draft first (Undo Commit restores the previous homeroom teachers), then switch between homeroom and section.',
            OLD.status;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS placement_sessions_kind_change_guard ON public.placement_sessions;
CREATE TRIGGER placement_sessions_kind_change_guard
    BEFORE UPDATE ON public.placement_sessions
    FOR EACH ROW EXECUTE FUNCTION public.assert_session_kind_change_allowed();


/* ---------- 5. One live board per student per period per year ---------- */
-- Nothing stopped a student from landing on two boards tagged the same
-- period. It is an easy mistake to make: creating a board pre-populates
-- EVERY active student in the grade, so two boards for grade 6 both
-- tagged Core 2 silently give every 6th grader two Core 2 teachers, and
-- the schedule view would show both with no indication which is right.
--
-- Scoped to (student, period, academic_year) and NOT to grade, so a
-- section may legitimately hold part of a grade (electives) or span
-- several grades (mixed-grade courses) without tripping the guard.
--
-- Spans rows in two tables, so it is a trigger rather than a constraint.
-- SECURITY DEFINER because the caller may not be able to read the
-- conflicting session under RLS -- without it the lookup returns nothing
-- and the collision slips through.
CREATE OR REPLACE FUNCTION public.find_period_conflicts(
    p_session_id uuid,
    p_student_id uuid DEFAULT NULL
)
RETURNS TABLE (student_label text, other_label text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    -- The set of students to check is resolved WITHOUT reading this
    -- session's own assignments when a specific student is passed in.
    -- The per-assignment trigger below runs BEFORE INSERT, so the row
    -- being added is not in placement_assignments yet -- deriving the
    -- target from a self-join there would find nothing and wave every
    -- conflict through.
    WITH me AS (
        SELECT id, school_id, period_id, academic_year
          FROM public.placement_sessions
         WHERE id = p_session_id
           AND period_id IS NOT NULL
    ),
    targets AS (
        SELECT p_student_id AS student_id
         WHERE p_student_id IS NOT NULL
        UNION
        SELECT mine.student_id
          FROM public.placement_assignments mine
          JOIN me ON mine.session_id = me.id
         WHERE p_student_id IS NULL
           AND (mine.teacher_id IS NOT NULL OR mine.assigned_col_id IS NOT NULL)
    )
    SELECT DISTINCT
           st.last_name || ', ' || st.first_name AS student_label,
           other.label                           AS other_label
      FROM targets t
      CROSS JOIN me
      JOIN public.placement_assignments theirs
        ON theirs.student_id = t.student_id
       AND theirs.session_id <> me.id
       AND (theirs.teacher_id IS NOT NULL OR theirs.assigned_col_id IS NOT NULL)
      JOIN public.placement_sessions other
        ON other.id           =  theirs.session_id
       AND other.school_id    =  me.school_id
       AND other.period_id    =  me.period_id
       AND other.academic_year = me.academic_year
       AND other.status       IN ('committed', 'published')
       AND other.deleted_at   IS NULL
      JOIN public.students st
        ON st.id = t.student_id
       AND st.active = true
     ORDER BY 1
     LIMIT 25;
$$;

-- Fires when a board goes live. One set-based pass over the whole board
-- rather than a per-student check, so publishing a 100-student board is
-- one query.
CREATE OR REPLACE FUNCTION public.assert_session_period_free()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    conflicts text;
    n         integer;
BEGIN
    -- Only when transitioning INTO a live state with a period set.
    IF NEW.period_id IS NULL
       OR NEW.status NOT IN ('committed', 'published')
       OR (TG_OP = 'UPDATE'
           AND OLD.status = NEW.status
           AND OLD.period_id IS NOT DISTINCT FROM NEW.period_id) THEN
        RETURN NEW;
    END IF;

    SELECT string_agg(student_label || ' (also on "' || other_label || '")', '; '),
           count(*)
      INTO conflicts, n
      FROM public.find_period_conflicts(NEW.id);

    IF n > 0 THEN
        RAISE EXCEPTION
            'Cannot publish: % student(s) are already in another live board for this period and year -- %. A student can only be in one class per period. Move them off the other board, or change this board''s period.',
            n, conflicts;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS placement_sessions_period_free ON public.placement_sessions;
CREATE TRIGGER placement_sessions_period_free
    BEFORE INSERT OR UPDATE ON public.placement_sessions
    FOR EACH ROW EXECUTE FUNCTION public.assert_session_period_free();

-- Fires when a student is placed onto a board that is ALREADY live --
-- published sections stay editable, so this is the common path, not an
-- edge case. Single-student check, so it stays cheap during drag-drop.
CREATE OR REPLACE FUNCTION public.assert_assignment_period_free()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    sess   record;
    other  text;
BEGIN
    -- Unplacing a student can never create a conflict.
    IF NEW.teacher_id IS NULL AND NEW.assigned_col_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT status, period_id INTO sess
      FROM public.placement_sessions WHERE id = NEW.session_id;

    IF sess.period_id IS NULL OR sess.status NOT IN ('committed', 'published') THEN
        RETURN NEW;
    END IF;

    SELECT other_label INTO other
      FROM public.find_period_conflicts(NEW.session_id, NEW.student_id)
     LIMIT 1;

    IF other IS NOT NULL THEN
        RAISE EXCEPTION
            'This student is already in "%" for the same period and year. A student can only be in one class per period.',
            other;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS placement_assignments_period_free ON public.placement_assignments;
CREATE TRIGGER placement_assignments_period_free
    BEFORE INSERT OR UPDATE ON public.placement_assignments
    FOR EACH ROW EXECUTE FUNCTION public.assert_assignment_period_free();


/* ---------- 6. Freshness stamp for published boards ---------- */
-- Published section boards are read live -- an admin moving a student
-- changes what teachers see immediately, with no republish step. That is
-- deliberate (a snapshot would drift, which is why homeroom boards need
-- getPendingStudents()), but it means teachers have no signal that what
-- they are looking at just changed. This stamp gives the schedule views
-- an "Updated <date>" to show.
--
-- Statement-level with a transition table, not row-level. saveAssignments()
-- upserts the whole changed set in one call and Sync Students can insert an
-- entire incoming class, so a row-level trigger would issue one UPDATE per
-- student against the same placement_sessions row. Gated on the parent being
-- published, so ordinary drag-drop on a draft board writes nothing.
CREATE OR REPLACE FUNCTION public.touch_schedule_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE public.placement_sessions ps
       SET schedule_updated_at = now()
     WHERE ps.status = 'published'
       AND ps.id IN (SELECT DISTINCT session_id FROM changed);
    RETURN NULL;
END;
$$;

-- Three triggers rather than one: a transition table is bound per event
-- type, and INSERT/UPDATE expose NEW TABLE while DELETE exposes OLD TABLE.
-- All three name it "changed" so one function serves them.
DROP TRIGGER IF EXISTS placement_assignments_touch_schedule_ins ON public.placement_assignments;
CREATE TRIGGER placement_assignments_touch_schedule_ins
    AFTER INSERT ON public.placement_assignments
    REFERENCING NEW TABLE AS changed
    FOR EACH STATEMENT EXECUTE FUNCTION public.touch_schedule_updated_at();

DROP TRIGGER IF EXISTS placement_assignments_touch_schedule_upd ON public.placement_assignments;
CREATE TRIGGER placement_assignments_touch_schedule_upd
    AFTER UPDATE ON public.placement_assignments
    REFERENCING NEW TABLE AS changed
    FOR EACH STATEMENT EXECUTE FUNCTION public.touch_schedule_updated_at();

DROP TRIGGER IF EXISTS placement_assignments_touch_schedule_del ON public.placement_assignments;
CREATE TRIGGER placement_assignments_touch_schedule_del
    AFTER DELETE ON public.placement_assignments
    REFERENCING OLD TABLE AS changed
    FOR EACH STATEMENT EXECUTE FUNCTION public.touch_schedule_updated_at();


/* ---------- 7. The read surface ---------- */
-- One view behind all three planned UIs (a student's day, a teacher's
-- sections, the admin grade x period grid).
--
-- security_invoker so the caller's own RLS on placement_sessions /
-- placement_assignments / students applies -- without it the view would
-- run as owner and hand every school's schedule to every caller.
--
-- Placeholder ("Open Position") columns are INCLUDED, with a null
-- teacher. A school may publish before the Core 3 teacher is hired, and
-- filtering those rows out would make the students in that column vanish
-- from their own schedule with no explanation. The UI renders them as
-- "Not yet assigned".
DROP VIEW IF EXISTS public.student_schedule;
CREATE VIEW public.student_schedule
WITH (security_invoker = true) AS
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
 WHERE ps.status IN ('committed', 'published')
   AND ps.deleted_at  IS NULL
   AND ps.archived_at IS NULL
   AND st.active = true
   AND (pa.teacher_id IS NOT NULL OR pa.assigned_col_id IS NOT NULL);

COMMENT ON VIEW public.student_schedule IS
  'One row per student per live board. Covers published section boards and committed homeroom boards, so a student''s full day reads from one place. Callers should filter is_current_year unless deliberately looking at a past year.';


/* ---------- 8. Report anything already colliding ---------- */
-- The triggers only guard new writes. Boards are all homeroom-kind and
-- period-less at this point, so there is nothing to collide yet -- but
-- the same reporting block is worth keeping for reruns against a school
-- that has already started tagging periods.
DO $$
DECLARE
    r record;
    found_any boolean := false;
BEGIN
    FOR r IN
        SELECT ps.school_id, ps.label, ps.academic_year, count(*) AS n
          FROM public.placement_sessions ps
          JOIN LATERAL public.find_period_conflicts(ps.id) fc ON true
         WHERE ps.status IN ('committed', 'published')
           AND ps.period_id IS NOT NULL
           AND ps.deleted_at IS NULL
         GROUP BY ps.school_id, ps.label, ps.academic_year
    LOOP
        found_any := true;
        RAISE WARNING
            'Existing period conflict -- school %, board "%" (%): % student(s) also sit on another live board for the same period.',
            r.school_id, r.label, r.academic_year, r.n;
    END LOOP;

    IF NOT found_any THEN
        RAISE NOTICE 'No pre-existing period conflicts found.';
    END IF;
END;
$$;


/* ---------- 9. Schools with no homerooms ---------- */
-- schools.uses_homerooms already exists and is honored in the student
-- directory and the staff portal. At a school where it is false there is
-- no meaningful homeroom commit at all -- every board is a section. The
-- UI reads this flag to default the board-type choice and hide the
-- homeroom option; recorded here so the coupling is discoverable from
-- the schema side.
COMMENT ON COLUMN public.schools.uses_homerooms IS
  'False means the school has no homerooms. Placement boards there default to session_kind = section and the homeroom option is hidden, since committing a homeroom would have nothing to drive.';
