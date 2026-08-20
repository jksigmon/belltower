-- ============================================================
-- Resource time blocks + campus scoping
--
-- Lets a resource (or a resource group) offer a preset list of
-- bookable periods (e.g. "Block 1", 7:15-9:15) instead of a free-form
-- start/end time. Blocks are school-defined and optionally scoped to
-- a single campus, following the same nullable campus_id = "all
-- campuses" convention already used on carline_events, staff_licenses,
-- students, and field_trips.
--
-- campus_id is also added directly to reservable_resources and
-- resource_groups so a resource (e.g. Upper School's Chromebook carts)
-- can be scoped to one campus at a multi-campus school, while resources
-- with campus_id = NULL remain visible/bookable from every campus.
--
-- Idempotent: safe to re-run (guards on tables, columns, indexes, and
-- policies) so it succeeds even where these objects were already
-- created by hand.
-- ============================================================

ALTER TABLE public.reservable_resources
  ADD COLUMN IF NOT EXISTS campus_id uuid REFERENCES public.campuses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS use_time_blocks boolean NOT NULL DEFAULT false;

ALTER TABLE public.resource_groups
  ADD COLUMN IF NOT EXISTS campus_id uuid REFERENCES public.campuses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS use_time_blocks boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_reservable_resources_campus ON public.reservable_resources (campus_id);
CREATE INDEX IF NOT EXISTS idx_resource_groups_campus ON public.resource_groups (campus_id);

CREATE TABLE IF NOT EXISTS public.resource_time_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  campus_id   uuid REFERENCES public.campuses(id) ON DELETE SET NULL,
  label       text NOT NULL,
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_resource_time_blocks_school ON public.resource_time_blocks (school_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_resource_time_blocks_campus ON public.resource_time_blocks (campus_id);

ALTER TABLE public.resource_time_blocks ENABLE ROW LEVEL SECURITY;

-- Read: any active, login-enabled staff member at the same school
-- (mirrors reservable_resources_read).
DROP POLICY IF EXISTS resource_time_blocks_read ON public.resource_time_blocks;
CREATE POLICY resource_time_blocks_read ON public.resource_time_blocks
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND p.can_login = true
        AND p.school_id = resource_time_blocks.school_id
    )
  );

-- Write: superadmin, admin role, or can_manage_reservations -- scoped to
-- school (mirrors reservable_resources_write).
DROP POLICY IF EXISTS resource_time_blocks_write ON public.resource_time_blocks;
CREATE POLICY resource_time_blocks_write ON public.resource_time_blocks
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = resource_time_blocks.school_id
              AND (p.role = 'admin' OR p.can_manage_reservations = true))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = resource_time_blocks.school_id
              AND (p.role = 'admin' OR p.can_manage_reservations = true))
        )
    )
  );
