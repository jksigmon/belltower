-- ======================================================================
-- Field Trip Vehicle Assignments Migration
-- Run once in Supabase SQL editor.
--
-- Changes:
--   1. Add vehicle_capacity to field_trip_chaperones (optional, per driver)
--   2. Create field_trip_vehicle_assignments (student → driver mapping)
--
-- Depends on:
--   • public.ft_get_school_id(uuid)   — SECURITY DEFINER helper
--   • public.ft_is_manager(uuid,uuid) — SECURITY DEFINER helper
--   • public.field_trip_chaperones
--   • public.students
-- ======================================================================


-- ── 1. Vehicle capacity on chaperone rows ─────────────────────────────
-- Nullable int; a driver may bring different vehicles on different trips
-- so this lives on the per-trip chaperone record, not on the guardian.

ALTER TABLE public.field_trip_chaperones
  ADD COLUMN IF NOT EXISTS vehicle_capacity int;


-- ── 2. field_trip_vehicle_assignments ────────────────────────────────
-- One row per student per trip. UNIQUE(field_trip_id, student_id)
-- ensures each student can only be in one vehicle.

CREATE TABLE IF NOT EXISTS public.field_trip_vehicle_assignments (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  school_id     uuid        NOT NULL REFERENCES public.schools(id)                  ON DELETE CASCADE,
  field_trip_id uuid        NOT NULL REFERENCES public.field_trips(id)              ON DELETE CASCADE,
  student_id    uuid        NOT NULL REFERENCES public.students(id)                 ON DELETE CASCADE,
  chaperone_id  uuid        NOT NULL REFERENCES public.field_trip_chaperones(id)   ON DELETE CASCADE,
  assigned_by   uuid        REFERENCES public.profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT field_trip_vehicle_assignments_pkey PRIMARY KEY (id),
  CONSTRAINT ftva_student_unique UNIQUE (field_trip_id, student_id)
);

ALTER TABLE public.field_trip_vehicle_assignments ENABLE ROW LEVEL SECURITY;

-- Trip managers and can_manage_field_trips admins can read/write.
CREATE POLICY ftva_select ON public.field_trip_vehicle_assignments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.is_superadmin = true
          OR (
            p.school_id = public.ft_get_school_id(field_trip_vehicle_assignments.field_trip_id)
            AND (p.can_manage_field_trips = true OR public.ft_is_manager(field_trip_vehicle_assignments.field_trip_id, p.id))
          )
        )
    )
  );

CREATE POLICY ftva_insert ON public.field_trip_vehicle_assignments
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.is_superadmin = true
          OR (
            p.school_id = public.ft_get_school_id(field_trip_vehicle_assignments.field_trip_id)
            AND (p.can_manage_field_trips = true OR public.ft_is_manager(field_trip_vehicle_assignments.field_trip_id, p.id))
          )
        )
    )
  );

CREATE POLICY ftva_update ON public.field_trip_vehicle_assignments
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.is_superadmin = true
          OR (
            p.school_id = public.ft_get_school_id(field_trip_vehicle_assignments.field_trip_id)
            AND (p.can_manage_field_trips = true OR public.ft_is_manager(field_trip_vehicle_assignments.field_trip_id, p.id))
          )
        )
    )
  );

CREATE POLICY ftva_delete ON public.field_trip_vehicle_assignments
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.is_superadmin = true
          OR (
            p.school_id = public.ft_get_school_id(field_trip_vehicle_assignments.field_trip_id)
            AND (p.can_manage_field_trips = true OR public.ft_is_manager(field_trip_vehicle_assignments.field_trip_id, p.id))
          )
        )
    )
  );
