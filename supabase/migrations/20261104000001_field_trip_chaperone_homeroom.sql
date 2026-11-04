-- Lets a trip manager place a staff or volunteer chaperone under a homeroom
-- teacher, so the Chaperones tab homeroom filter can show them under the right
-- class. Guardian chaperones keep using their family's students; this is only
-- for people with no family on file (grandparents, friends, outside volunteers).
ALTER TABLE public.field_trip_chaperones
  ADD COLUMN IF NOT EXISTS homeroom_teacher_id uuid REFERENCES public.employees(id) ON DELETE SET NULL;
