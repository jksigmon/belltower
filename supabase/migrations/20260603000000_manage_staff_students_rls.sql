-- Allow users with can_manage_staff to insert and update employees (same school only).
-- Previously only role='admin' or is_superadmin could write to employees.

CREATE POLICY employees_insert_manage_staff ON public.employees FOR INSERT
  WITH CHECK ((EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND p.school_id = employees.school_id
      AND p.can_manage_staff = true
  )));

CREATE POLICY employees_update_manage_staff ON public.employees FOR UPDATE
  USING ((EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND p.school_id = employees.school_id
      AND p.can_manage_staff = true
  )))
  WITH CHECK ((EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND p.school_id = employees.school_id
      AND p.can_manage_staff = true
  )));


-- Allow users with can_manage_students to insert and update students (same school only).

CREATE POLICY students_insert_manage_students ON public.students FOR INSERT
  WITH CHECK ((EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND p.school_id = students.school_id
      AND p.can_manage_students = true
  )));

CREATE POLICY students_update_manage_students ON public.students FOR UPDATE
  USING ((EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND p.school_id = students.school_id
      AND p.can_manage_students = true
  )))
  WITH CHECK ((EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND p.school_id = students.school_id
      AND p.can_manage_students = true
  )));
