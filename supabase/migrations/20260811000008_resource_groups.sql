-- ============================================================
-- Resource groups
-- Lets a reservable resource optionally belong to a parent group
-- (e.g. "Upper School Chromebook Carts" grouping "Cart 1".."Cart 6"),
-- so staff pick the specific unit when booking instead of it just
-- being part of the reservation title. A group is purely organizational
-- metadata -- it is never itself bookable, only its members are.
--
-- Idempotent: safe to re-run (guards on tables, indexes, and policies).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.resource_groups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name               text NOT NULL,
  description        text,
  color              text NOT NULL DEFAULT '#2563eb',
  requires_approval  boolean NOT NULL DEFAULT false,
  sort_order         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resource_groups_school ON public.resource_groups (school_id, sort_order);

ALTER TABLE public.reservable_resources
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.resource_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reservable_resources_group ON public.reservable_resources (group_id);

ALTER TABLE public.resource_groups ENABLE ROW LEVEL SECURITY;

-- Read: any active, login-enabled staff member at the same school
-- (mirrors reservable_resources_read).
DROP POLICY IF EXISTS resource_groups_read ON public.resource_groups;
CREATE POLICY resource_groups_read ON public.resource_groups
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND p.can_login = true
        AND p.school_id = resource_groups.school_id
    )
  );

-- Write: superadmin, admin role, or can_manage_reservations -- scoped to
-- school (mirrors reservable_resources_write).
DROP POLICY IF EXISTS resource_groups_write ON public.resource_groups;
CREATE POLICY resource_groups_write ON public.resource_groups
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = resource_groups.school_id
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
          OR (p.school_id = resource_groups.school_id
              AND (p.role = 'admin' OR p.can_manage_reservations = true))
        )
    )
  );
