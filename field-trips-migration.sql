-- ======================================================================
-- Field Trips Module Migration
-- Run once in Supabase SQL editor.
-- Adds: field_trips, field_trip_chaperones, field_trip_students
-- Plus: profiles.can_manage_field_trips
-- ======================================================================

-- ── New permission column ─────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_field_trips boolean NOT NULL DEFAULT false;

-- ======================================================================
-- TABLE: field_trips
-- One row per trip or event that requires chaperones.
-- ======================================================================
CREATE TABLE IF NOT EXISTS public.field_trips (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id              uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  campus_id              uuid        REFERENCES public.campuses(id),
  name                   text        NOT NULL,
  destination            text,
  start_date             date        NOT NULL,
  end_date               date,
  depart_at              time,
  return_at              time,
  grade_levels           text[]      NOT NULL DEFAULT '{}',
  homeroom_teacher_ids   uuid[]      NOT NULL DEFAULT '{}',
  drivers_needed         boolean     NOT NULL DEFAULT false,
  max_chaperones         int,
  notes                  text,
  status                 text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by_profile_id  uuid        REFERENCES public.profiles(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.field_trips ENABLE ROW LEVEL SECURITY;

CREATE POLICY field_trips_manager ON public.field_trips
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = field_trips.school_id
        AND (p.can_manage_field_trips = true OR p.is_superadmin = true)
    )
  );

-- ======================================================================
-- TABLE: field_trip_chaperones
-- Guardians assigned as chaperones for a trip (soft-delete via removed_at).
-- ======================================================================
CREATE TABLE IF NOT EXISTS public.field_trip_chaperones (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id            uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  field_trip_id        uuid        NOT NULL REFERENCES public.field_trips(id) ON DELETE CASCADE,
  guardian_id          uuid        NOT NULL REFERENCES public.guardians(id) ON DELETE CASCADE,
  is_driver            boolean     NOT NULL DEFAULT false,
  added_by_profile_id  uuid        REFERENCES public.profiles(id),
  added_at             timestamptz NOT NULL DEFAULT now(),
  removed_at           timestamptz
);

-- Prevent duplicate active chaperone assignments
CREATE UNIQUE INDEX IF NOT EXISTS field_trip_chaperones_active_unique
  ON public.field_trip_chaperones (field_trip_id, guardian_id)
  WHERE removed_at IS NULL;

ALTER TABLE public.field_trip_chaperones ENABLE ROW LEVEL SECURITY;

CREATE POLICY field_trip_chaperones_manager ON public.field_trip_chaperones
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = field_trip_chaperones.school_id
        AND (p.can_manage_field_trips = true OR p.is_superadmin = true)
    )
  );

-- ======================================================================
-- TABLE: field_trip_students
-- Explicit attendance overrides; absence of a row means attending = true.
-- ======================================================================
CREATE TABLE IF NOT EXISTS public.field_trip_students (
  id             uuid     PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid     NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  field_trip_id  uuid     NOT NULL REFERENCES public.field_trips(id) ON DELETE CASCADE,
  student_id     uuid     NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  attending      boolean  NOT NULL DEFAULT true
);

CREATE UNIQUE INDEX IF NOT EXISTS field_trip_students_unique
  ON public.field_trip_students (field_trip_id, student_id);

ALTER TABLE public.field_trip_students ENABLE ROW LEVEL SECURITY;

CREATE POLICY field_trip_students_manager ON public.field_trip_students
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = field_trip_students.school_id
        AND (p.can_manage_field_trips = true OR p.is_superadmin = true)
    )
  );
