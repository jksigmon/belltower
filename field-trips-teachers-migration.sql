-- ======================================================================
-- Field Trips Teachers Migration
-- Run AFTER field-trips-migration.sql.
-- Adds: field_trip_managers table
-- Updates: RLS policies to allow school-level admins AND per-trip managers
-- ======================================================================

-- ── 1. field_trip_managers ────────────────────────────────────────────
-- Which staff profiles can manage a given trip.
-- Created automatically when a teacher creates a trip or is added by a peer.
CREATE TABLE IF NOT EXISTS public.field_trip_managers (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  field_trip_id   uuid        NOT NULL REFERENCES public.field_trips(id) ON DELETE CASCADE,
  profile_id      uuid        NOT NULL REFERENCES public.profiles(id)    ON DELETE CASCADE,
  added_by        uuid        REFERENCES public.profiles(id),
  added_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE(field_trip_id, profile_id)
);

ALTER TABLE public.field_trip_managers ENABLE ROW LEVEL SECURITY;

-- Any logged-in staff at the school can read the managers list
-- (needed so RLS joins in other policies can resolve)
CREATE POLICY ftm_select ON public.field_trip_managers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      JOIN public.field_trips ft ON ft.id = field_trip_managers.field_trip_id
      WHERE p.user_id = auth.uid()
        AND p.school_id = ft.school_id
        AND p.can_login = true
    )
  );

-- Only admins or existing managers on the trip may add/remove managers
CREATE POLICY ftm_insert ON public.field_trip_managers
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      JOIN public.field_trips ft ON ft.id = field_trip_managers.field_trip_id
      WHERE p.user_id = auth.uid()
        AND p.school_id = ft.school_id
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          EXISTS (
            SELECT 1 FROM public.field_trip_managers m2
            WHERE m2.field_trip_id = field_trip_managers.field_trip_id
              AND m2.profile_id = p.id
          )
        )
    )
  );

CREATE POLICY ftm_delete ON public.field_trip_managers
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      JOIN public.field_trips ft ON ft.id = field_trip_managers.field_trip_id
      WHERE p.user_id = auth.uid()
        AND p.school_id = ft.school_id
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          -- Can remove yourself or others if you're a manager
          EXISTS (
            SELECT 1 FROM public.field_trip_managers m2
            WHERE m2.field_trip_id = field_trip_managers.field_trip_id
              AND m2.profile_id = p.id
          )
        )
    )
  );

-- ── 2. Drop old single-policy RLS on field_trips tables ───────────────
DROP POLICY IF EXISTS field_trips_manager             ON public.field_trips;
DROP POLICY IF EXISTS field_trip_chaperones_manager   ON public.field_trip_chaperones;
DROP POLICY IF EXISTS field_trip_students_manager     ON public.field_trip_students;

-- ── 3. field_trips — split into SELECT / INSERT / UPDATE+DELETE ────────

-- SELECT: admins, superadmins, or listed managers
CREATE POLICY ft_select ON public.field_trips
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = field_trips.school_id
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          EXISTS (
            SELECT 1 FROM public.field_trip_managers m
            WHERE m.field_trip_id = field_trips.id AND m.profile_id = p.id
          )
        )
    )
  );

-- INSERT: any can_login staff at the school may create a trip
-- (JS immediately inserts them as a manager after creation)
CREATE POLICY ft_insert ON public.field_trips
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = field_trips.school_id
        AND p.can_login = true
    )
  );

-- UPDATE: admins or listed managers
CREATE POLICY ft_update ON public.field_trips
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = field_trips.school_id
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          EXISTS (
            SELECT 1 FROM public.field_trip_managers m
            WHERE m.field_trip_id = field_trips.id AND m.profile_id = p.id
          )
        )
    )
  );

-- DELETE: admins only (managers cannot delete trips)
CREATE POLICY ft_delete ON public.field_trips
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = field_trips.school_id
        AND (p.can_manage_field_trips = true OR p.is_superadmin = true)
    )
  );

-- ── 4. field_trip_chaperones — same manager logic ─────────────────────
CREATE POLICY ftc_all ON public.field_trip_chaperones
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = field_trip_chaperones.school_id
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          EXISTS (
            SELECT 1 FROM public.field_trip_managers m
            WHERE m.field_trip_id = field_trip_chaperones.field_trip_id
              AND m.profile_id = p.id
          )
        )
    )
  );

-- ── 5. field_trip_students — same manager logic ───────────────────────
CREATE POLICY fts_all ON public.field_trip_students
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = field_trip_students.school_id
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          EXISTS (
            SELECT 1 FROM public.field_trip_managers m
            WHERE m.field_trip_id = field_trip_students.field_trip_id
              AND m.profile_id = p.id
          )
        )
    )
  );

-- ── 6. Backfill: make existing trip creators managers ────────────────
-- Any existing trips created before this migration will have no managers.
-- This inserts the creator as the initial manager for all existing trips.
INSERT INTO public.field_trip_managers (field_trip_id, profile_id, added_by)
SELECT ft.id, ft.created_by_profile_id, ft.created_by_profile_id
FROM public.field_trips ft
WHERE ft.created_by_profile_id IS NOT NULL
ON CONFLICT (field_trip_id, profile_id) DO NOTHING;
