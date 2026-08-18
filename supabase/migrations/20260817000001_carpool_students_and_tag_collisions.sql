-- ============================================================
-- Solo student pickup tags + cross-table tag collision guards
--
-- Two related changes to the carline tag system:
--
-- 1. carpool_students — lets a pickup tag point at individual
--    students, not just whole families. Needed for split/blended
--    households where one child must be callable without their
--    siblings (e.g. tag #309 calls both Tucker girls, #542 calls
--    only Bella). Previously a tag could only resolve to families,
--    and a family always calls every student in it.
--
--    Deliberately a SEPARATE table from carline_tags rather than a
--    nullable student_id column on it: carline_tags already has an
--    FK to families, and adding a students FK to the same table
--    would give PostgREST a students<->families many-to-many path
--    alongside the existing direct students.family_id FK, which
--    makes every families/students embed ambiguous (PGRST201).
--    Keeping members in two tables means no table ever references
--    both students and families.
--
-- 2. Cross-table tag uniqueness. families.carline_tag_number and
--    carpools.tag_number are each unique within their own table but
--    knew nothing about each other, so a family could be created on
--    a number already in use by a pickup tag with no warning. That
--    is not cosmetic: callByTag checks pickup tags BEFORE family
--    numbers, so the colliding family silently becomes unreachable
--    and typing its number calls someone else's children.
--
--    Enforced with triggers rather than a constraint because the
--    rule spans two tables. SECURITY DEFINER because a user with
--    can_manage_families may have no read access to carpools under
--    RLS -- without it the lookup would return nothing and the
--    collision would slip through.
--
-- Both checks ignore active/inactive status, matching the existing
-- families_school_tag_unique index (which has no partial predicate).
-- A deactivated family still owns its number; free it by deleting
-- the row or renumbering it.
-- ============================================================

/* ---------- 1. Solo student pickup tag members ---------- */

CREATE TABLE IF NOT EXISTS public.carpool_students (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    carpool_id uuid NOT NULL REFERENCES public.carpools(id) ON DELETE CASCADE,
    student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT carpool_students_carpool_student_unique UNIQUE (carpool_id, student_id)
);

CREATE INDEX IF NOT EXISTS carpool_students_student_id_idx
    ON public.carpool_students (student_id);

ALTER TABLE public.carpool_students ENABLE ROW LEVEL SECURITY;

-- Read/write mirror carline_tags exactly -- same audience, same
-- permission flags, scoped through the parent carpool's school.
DROP POLICY IF EXISTS carpool_students_read ON public.carpool_students;
CREATE POLICY carpool_students_read ON public.carpool_students
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            JOIN public.carpools c ON c.id = carpool_students.carpool_id
            WHERE p.user_id = auth.uid()
              AND p.status = 'active'
              AND p.school_id = c.school_id
              AND (p.can_view_carline = true OR p.can_manage_carline = true
                   OR p.can_manage_carpools = true OR p.is_superadmin = true)
        )
    );

DROP POLICY IF EXISTS carpool_students_admin_write ON public.carpool_students;
CREATE POLICY carpool_students_admin_write ON public.carpool_students
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            JOIN public.carpools c ON c.id = carpool_students.carpool_id
            WHERE p.user_id = auth.uid()
              AND p.status = 'active'
              AND (p.is_superadmin = true
                   OR (p.can_manage_carpools = true AND p.school_id = c.school_id))
        )
    );

-- A pickup tag must never reach across schools.
CREATE OR REPLACE FUNCTION public.assert_carpool_student_same_school()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    carpool_school uuid;
    student_school uuid;
BEGIN
    SELECT school_id INTO carpool_school FROM public.carpools WHERE id = NEW.carpool_id;
    SELECT school_id INTO student_school FROM public.students WHERE id = NEW.student_id;

    IF carpool_school IS DISTINCT FROM student_school THEN
        RAISE EXCEPTION
            'Student and pickup tag belong to different schools.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS carpool_students_same_school ON public.carpool_students;
CREATE TRIGGER carpool_students_same_school
    BEFORE INSERT OR UPDATE ON public.carpool_students
    FOR EACH ROW EXECUTE FUNCTION public.assert_carpool_student_same_school();


/* ---------- 2. Cross-table tag collision guards ---------- */

-- Rejects a family number already claimed by a pickup tag.
CREATE OR REPLACE FUNCTION public.assert_family_tag_free()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    conflict_label text;
BEGIN
    IF NEW.carline_tag_number IS NULL THEN
        RETURN NEW;
    END IF;

    -- Only re-check when the number (or school) actually moves, so unrelated
    -- edits to an already-colliding legacy row aren't blocked.
    IF TG_OP = 'UPDATE'
       AND NEW.carline_tag_number IS NOT DISTINCT FROM OLD.carline_tag_number
       AND NEW.school_id IS NOT DISTINCT FROM OLD.school_id THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(c.label, 'Pickup tag #' || c.tag_number)
      INTO conflict_label
      FROM public.carpools c
     WHERE c.school_id = NEW.school_id
       AND c.tag_number = NEW.carline_tag_number
     LIMIT 1;

    IF conflict_label IS NOT NULL THEN
        RAISE EXCEPTION
            'Number % is already in use by the pickup tag "%". Family numbers and pickup tags share one pool -- pick a different number, or renumber that pickup tag first.',
            NEW.carline_tag_number, conflict_label;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS families_tag_free ON public.families;
CREATE TRIGGER families_tag_free
    BEFORE INSERT OR UPDATE ON public.families
    FOR EACH ROW EXECUTE FUNCTION public.assert_family_tag_free();


-- Rejects a pickup tag number already claimed by a family.
CREATE OR REPLACE FUNCTION public.assert_carpool_tag_free()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    conflict_label text;
BEGIN
    IF NEW.tag_number IS NULL THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW.tag_number IS NOT DISTINCT FROM OLD.tag_number
       AND NEW.school_id IS NOT DISTINCT FROM OLD.school_id THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(NULLIF(f.family_name, ''), '(Unnamed family)')
      INTO conflict_label
      FROM public.families f
     WHERE f.school_id = NEW.school_id
       AND f.carline_tag_number = NEW.tag_number
     LIMIT 1;

    IF conflict_label IS NOT NULL THEN
        RAISE EXCEPTION
            'Number % is already the family number for %. Family numbers and pickup tags share one pool -- pick a different number, or free that family number first.',
            NEW.tag_number, conflict_label;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS carpools_tag_free ON public.carpools;
CREATE TRIGGER carpools_tag_free
    BEFORE INSERT OR UPDATE ON public.carpools
    FOR EACH ROW EXECUTE FUNCTION public.assert_carpool_tag_free();


/* ---------- 3. Naming ---------- */
-- The UI calls these "Pickup Tags"; the tables still say carpool, from when
-- families were the only member type. The mismatch is deliberate: renaming
-- carpools/carline_tags means touching ~49 call sites in untyped JS on the
-- dismissal path, and renaming the permission column would fork the audit
-- trail (permission_audit_log stores tracked permission names as text, so
-- historical rows would keep the old name forever). Documented here instead.

COMMENT ON TABLE public.carpools IS
  'Pickup tags (shown in the UI as "Pickup Tags"). An extra dismissal number that calls a set of member families (carline_tags) and/or individual students (carpool_students). Named "carpools" historically, when families were the only member type. Shares one number pool with families.carline_tag_number -- see assert_carpool_tag_free.';

COMMENT ON TABLE public.carline_tags IS
  'Family members of a pickup tag. Calling the tag calls every student in each listed family.';

COMMENT ON TABLE public.carpool_students IS
  'Individual student members of a pickup tag. Calling the tag calls only these students -- used where one child must be callable without their siblings (split/blended households).';

COMMENT ON COLUMN public.profiles.can_manage_carpools IS
  'Grants the Pickup Tags admin tab. Name predates the UI rename; do not change it -- permission_audit_log stores tracked permission names as text in historical rows.';


/* ---------- 4. Report pre-existing collisions ---------- */
-- Triggers only guard new writes. Anything already colliding when this
-- migration runs stays broken until a human renumbers one side, so name
-- them here rather than letting them sit silently.
DO $$
DECLARE
    r record;
    found_any boolean := false;
BEGIN
    FOR r IN
        SELECT f.school_id,
               f.carline_tag_number AS tag,
               COALESCE(NULLIF(f.family_name, ''), '(Unnamed family)') AS family_label,
               COALESCE(c.label, 'Pickup tag #' || c.tag_number)       AS carpool_label
          FROM public.families f
          JOIN public.carpools c
            ON c.school_id = f.school_id
           AND c.tag_number = f.carline_tag_number
         ORDER BY f.school_id, f.carline_tag_number
    LOOP
        found_any := true;
        RAISE WARNING
            'Existing tag collision -- school %, number %: family "%" and pickup tag "%" share this number. Carline resolves pickup tags first, so the family is currently unreachable.',
            r.school_id, r.tag, r.family_label, r.carpool_label;
    END LOOP;

    IF NOT found_any THEN
        RAISE NOTICE 'No pre-existing family/pickup tag collisions found.';
    END IF;
END;
$$;
