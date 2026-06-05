-- When an employee is deleted, convert any placement board columns they own
-- into placeholder "Open Position" columns rather than cascade-deleting them.
-- Students in that column stay exactly where they are; the admin can assign
-- a replacement teacher later using the existing "Assign Teacher" workflow.
--
-- Also fixes placement_session_teachers.teacher_id FK from ON DELETE CASCADE
-- → ON DELETE SET NULL. The BEFORE DELETE trigger fires first, setting
-- placeholder_name before teacher_id is nulled, so the CHECK constraint
-- (teacher_id IS NOT NULL OR placeholder_name IS NOT NULL) stays satisfied.

CREATE OR REPLACE FUNCTION public.convert_placement_teacher_to_placeholder()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.placement_session_teachers
  SET
    placeholder_name = OLD.first_name || ' ' || OLD.last_name || ' (departed)',
    teacher_id       = NULL
  WHERE teacher_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER before_employee_delete_placement_columns
  BEFORE DELETE ON public.employees
  FOR EACH ROW
  EXECUTE FUNCTION public.convert_placement_teacher_to_placeholder();

ALTER TABLE public.placement_session_teachers
  DROP CONSTRAINT placement_session_teachers_teacher_id_fkey;

ALTER TABLE public.placement_session_teachers
  ADD CONSTRAINT placement_session_teachers_teacher_id_fkey
  FOREIGN KEY (teacher_id) REFERENCES public.employees(id) ON DELETE SET NULL;
