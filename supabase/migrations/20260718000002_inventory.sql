-- ============================================================
-- Inventory
-- Freeform asset checkout/roster tracking. A teacher builds a "list"
-- (a roster of students) and a freeform set of tracked item TYPES
-- (Skills Book, Knowledge Book, calculator, etc — whatever the school
-- needs), then records a per-student identifier and checked-out/
-- returned status for each student x item combination. Deliberately
-- freeform (no hardcoded item types) so this works for any school's
-- asset-tracking need, not just books.
-- ============================================================

-- New permission (must exist before the policies below reference it)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_inventory boolean NOT NULL DEFAULT false;

CREATE TABLE public.inventory_lists (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  owner_profile_id   uuid REFERENCES public.profiles(id),
  -- Denormalized: profiles SELECT under RLS is self-only unless you hold
  -- can_manage_access (can_manage_inventory alone doesn't grant that), so
  -- a join would show NULL for a colleague's list to any other viewer with
  -- oversight access. Same pattern as reservations.reserved_by_name.
  owner_name         text NOT NULL,
  name               text NOT NULL,
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_lists_school ON public.inventory_lists (school_id);
CREATE INDEX idx_inventory_lists_owner ON public.inventory_lists (owner_profile_id);

-- Tracked item TYPES/columns for a list (e.g. "Skills Book") — not
-- individual physical copies.
CREATE TABLE public.inventory_list_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id     uuid NOT NULL REFERENCES public.inventory_lists(id) ON DELETE CASCADE,
  label       text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0
);

CREATE INDEX idx_inventory_list_items_list ON public.inventory_list_items (list_id, sort_order);

-- Roster membership — snapshotted at add-time (not a live homeroom
-- query), so a list stays stable even if a student's homeroom changes
-- later in the year.
CREATE TABLE public.inventory_list_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id     uuid NOT NULL REFERENCES public.inventory_lists(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  sort_order  integer NOT NULL DEFAULT 0,
  UNIQUE (list_id, student_id)
);

CREATE INDEX idx_inventory_list_members_list ON public.inventory_list_members (list_id);

-- The actual checkout record for a given student x item on a list.
CREATE TABLE public.inventory_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id         uuid NOT NULL REFERENCES public.inventory_lists(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  item_id         uuid NOT NULL REFERENCES public.inventory_list_items(id) ON DELETE CASCADE,
  identifier      text,
  status          text NOT NULL DEFAULT 'not_assigned'
                    CHECK (status IN ('not_assigned', 'checked_out', 'returned')),
  checked_out_at  timestamptz,
  returned_at     timestamptz,
  note            text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (list_id, student_id, item_id)
);

CREATE INDEX idx_inventory_assignments_list ON public.inventory_assignments (list_id);

ALTER TABLE public.inventory_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_list_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_list_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_assignments ENABLE ROW LEVEL SECURITY;

-- ── inventory_lists ──────────────────────────────────────────
-- Owner sees/manages their own lists; can_manage_inventory holders
-- (or admin/superadmin) see and manage ALL lists in their school —
-- global oversight, no per-teacher assignment mapping in this version.

CREATE POLICY inventory_lists_all ON public.inventory_lists
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = inventory_lists.school_id
              AND (p.role = 'admin' OR p.can_manage_inventory = true OR p.id = inventory_lists.owner_profile_id))
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
          OR (p.school_id = inventory_lists.school_id
              AND (p.role = 'admin' OR p.can_manage_inventory = true OR p.id = inventory_lists.owner_profile_id))
        )
    )
  );

-- ── inventory_list_items / members / assignments ──────────────
-- All three are scoped through their parent list's school_id and
-- owner, via the same nested-EXISTS pattern used for
-- request_category_fields → request_categories in this repo.

CREATE POLICY inventory_list_items_all ON public.inventory_list_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.inventory_lists l
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE l.id = inventory_list_items.list_id
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = l.school_id
              AND (p.role = 'admin' OR p.can_manage_inventory = true OR p.id = l.owner_profile_id))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inventory_lists l
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE l.id = inventory_list_items.list_id
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = l.school_id
              AND (p.role = 'admin' OR p.can_manage_inventory = true OR p.id = l.owner_profile_id))
        )
    )
  );

CREATE POLICY inventory_list_members_all ON public.inventory_list_members
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.inventory_lists l
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE l.id = inventory_list_members.list_id
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = l.school_id
              AND (p.role = 'admin' OR p.can_manage_inventory = true OR p.id = l.owner_profile_id))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inventory_lists l
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE l.id = inventory_list_members.list_id
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = l.school_id
              AND (p.role = 'admin' OR p.can_manage_inventory = true OR p.id = l.owner_profile_id))
        )
    )
  );

CREATE POLICY inventory_assignments_all ON public.inventory_assignments
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.inventory_lists l
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE l.id = inventory_assignments.list_id
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = l.school_id
              AND (p.role = 'admin' OR p.can_manage_inventory = true OR p.id = l.owner_profile_id))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inventory_lists l
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE l.id = inventory_assignments.list_id
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = l.school_id
              AND (p.role = 'admin' OR p.can_manage_inventory = true OR p.id = l.owner_profile_id))
        )
    )
  );
