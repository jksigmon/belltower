-- ============================================================
-- Field trips: permission slip tracking + parent-facing notes
--
-- Permission slips: today attendance is just a boolean with no consent
-- record behind it. This adds a per-(trip, student) status a teacher can
-- mark off as slips come in -- pending/signed/declined -- mirroring how
-- field_trip_students is modeled. Deliberately NOT a public e-signature
-- flow (no token/edge-function surface) in this pass -- schools still
-- collect paper slips; this just gives teachers a place to track them.
--
-- parent_notes: separate from the existing internal-only `notes` column.
-- Meant for what-to-bring/what-to-expect copy a teacher can hand to
-- parents (via the "Copy Parent Email" action), not for admin eyes only.
-- ============================================================

CREATE TABLE public.field_trip_permission_slips (
    id            uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id     uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    field_trip_id uuid NOT NULL REFERENCES public.field_trips(id) ON DELETE CASCADE,
    student_id    uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    status        text NOT NULL DEFAULT 'pending',
    note          text,
    updated_by    uuid REFERENCES public.profiles(id),
    updated_at    timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT field_trip_permission_slips_pkey PRIMARY KEY (id),
    CONSTRAINT field_trip_permission_slips_status_check CHECK (status IN ('pending', 'signed', 'declined')),
    CONSTRAINT field_trip_permission_slips_unique UNIQUE (field_trip_id, student_id)
);

ALTER TABLE public.field_trip_permission_slips ENABLE ROW LEVEL SECURITY;

-- Mirrors fts_all on field_trip_students -- same audience (admins,
-- field-trip managers, or managers of this specific trip) gets full
-- read/write, since permission slips are edited from the same Students tab.
CREATE POLICY "ftps_all" ON public.field_trip_permission_slips USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.school_id = field_trip_permission_slips.school_id
      AND ( p.can_manage_field_trips = true
            OR p.is_superadmin = true
            OR EXISTS ( SELECT 1 FROM public.field_trip_managers m
                        WHERE m.field_trip_id = field_trip_permission_slips.field_trip_id
                          AND m.profile_id = p.id ) )
  )
);

ALTER TABLE public.field_trips
  ADD COLUMN parent_notes text;
