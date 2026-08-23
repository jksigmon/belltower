-- ============================================================
-- Field trip chaperones: allow staff (employees), not just
-- guardians, to be added as chaperones. guardian_id becomes
-- nullable, a new employee_id column is added, and a check
-- constraint enforces exactly one of the two is set.
--
-- Also drops field_trips.homeroom_teacher_ids: added in the
-- original migration, never read or written by the app.
-- ============================================================

ALTER TABLE public.field_trip_chaperones
  ALTER COLUMN guardian_id DROP NOT NULL;

ALTER TABLE public.field_trip_chaperones
  ADD COLUMN employee_id uuid REFERENCES public.employees(id) ON DELETE CASCADE;

ALTER TABLE public.field_trip_chaperones
  ADD CONSTRAINT field_trip_chaperones_one_person CHECK (
    (guardian_id IS NOT NULL AND employee_id IS NULL) OR
    (guardian_id IS NULL AND employee_id IS NOT NULL)
  );

-- Mirrors field_trip_chaperones_active_unique but for the employee side --
-- a staff member can't be added to the same trip twice while active.
CREATE UNIQUE INDEX field_trip_chaperones_employee_active_unique
  ON public.field_trip_chaperones USING btree (field_trip_id, employee_id)
  WHERE (removed_at IS NULL);

ALTER TABLE public.field_trips
  DROP COLUMN IF EXISTS homeroom_teacher_ids;
