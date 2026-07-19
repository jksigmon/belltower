-- ============================================================
-- Reservations
-- Shared-resource booking (conference room, van, gym, etc). The
-- resource catalog itself is school-defined, not hardcoded, so this
-- works for any school's set of bookable spaces/equipment. Each
-- resource can optionally require admin approval before a booking
-- is confirmed.
-- ============================================================

-- New permission (must exist before the policies below reference it)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_reservations boolean NOT NULL DEFAULT false;

CREATE TABLE public.reservable_resources (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name               text NOT NULL,
  description        text,
  color              text NOT NULL DEFAULT '#2563eb',
  requires_approval  boolean NOT NULL DEFAULT false,
  active             boolean NOT NULL DEFAULT true,
  sort_order         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_reservable_resources_school ON public.reservable_resources (school_id, sort_order);

CREATE TABLE public.reservations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id                uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  resource_id              uuid NOT NULL REFERENCES public.reservable_resources(id) ON DELETE CASCADE,
  reserved_by_profile_id   uuid REFERENCES public.profiles(id),
  -- Denormalized: profiles SELECT under RLS only allows reading your own
  -- row (or any row, if you hold can_manage_access) — a join would show
  -- NULL for a colleague's booking on the shared calendar. Same pattern
  -- as placement_session_notes.author_name / resource_documents.uploaded_by_name.
  reserved_by_name         text NOT NULL,
  title                    text NOT NULL,
  notes                    text,
  starts_at                timestamptz NOT NULL,
  ends_at                  timestamptz NOT NULL,
  status                   text NOT NULL DEFAULT 'confirmed'
                             CHECK (status IN ('confirmed', 'pending', 'denied', 'cancelled')),
  decided_by               uuid REFERENCES public.profiles(id),
  decided_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX idx_reservations_resource_time ON public.reservations (resource_id, starts_at, ends_at);
CREATE INDEX idx_reservations_school ON public.reservations (school_id);

ALTER TABLE public.reservable_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

-- ── reservable_resources ──────────────────────────────────────

-- Read: any active, login-enabled staff member at the same school
CREATE POLICY reservable_resources_read ON public.reservable_resources
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND p.can_login = true
        AND p.school_id = reservable_resources.school_id
    )
  );

-- Write: superadmin, admin role, or can_manage_reservations — scoped to school
CREATE POLICY reservable_resources_write ON public.reservable_resources
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = reservable_resources.school_id
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
          OR (p.school_id = reservable_resources.school_id
              AND (p.role = 'admin' OR p.can_manage_reservations = true))
        )
    )
  );

-- ── reservations ───────────────────────────────────────────────

-- Read: any active, login-enabled staff member at the same school —
-- everyone needs to see what's booked to avoid double-booking.
CREATE POLICY reservations_read ON public.reservations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND p.can_login = true
        AND p.school_id = reservations.school_id
    )
  );

-- Insert: any active staff member at the same school, only as themselves
-- (reserved_by_profile_id must be their own profile id), unless superadmin.
CREATE POLICY reservations_insert ON public.reservations
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND p.can_login = true
        AND (
          p.is_superadmin = true
          OR (p.school_id = reservations.school_id
              AND p.id = reservations.reserved_by_profile_id)
        )
    )
  );

-- Update/Delete: the reserving user can modify/cancel their own booking;
-- superadmin / admin role / can_manage_reservations can modify or cancel
-- ANY booking at their school (needed to approve/deny pending requests).
CREATE POLICY reservations_update ON public.reservations
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = reservations.school_id
              AND (p.role = 'admin' OR p.can_manage_reservations = true OR p.id = reservations.reserved_by_profile_id))
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
          OR (p.school_id = reservations.school_id
              AND (p.role = 'admin' OR p.can_manage_reservations = true OR p.id = reservations.reserved_by_profile_id))
        )
    )
  );

CREATE POLICY reservations_delete ON public.reservations
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = reservations.school_id
              AND (p.role = 'admin' OR p.can_manage_reservations = true OR p.id = reservations.reserved_by_profile_id))
        )
    )
  );
