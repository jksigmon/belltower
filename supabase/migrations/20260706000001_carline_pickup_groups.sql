-- ============================================================
-- Carline Pickup Groups
-- Named groups of students (by grade range) that participate
-- in a specific campus's dismissal even though the students
-- are enrolled on a different campus. Example: upper school
-- shuttle students (grades 8-12) waiting in the lower school
-- library during lower school dismissal.
-- ============================================================

CREATE TABLE public.carline_pickup_groups (
  id           uuid DEFAULT gen_random_uuid() NOT NULL,
  school_id    uuid NOT NULL,
  name         text NOT NULL,
  campus_id    uuid,
  grade_levels text[] NOT NULL DEFAULT '{}',
  active       boolean DEFAULT true NOT NULL,
  created_at   timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT carline_pickup_groups_pkey PRIMARY KEY (id),
  CONSTRAINT carline_pickup_groups_school_fkey
    FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE,
  CONSTRAINT carline_pickup_groups_campus_fkey
    FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE SET NULL
);

ALTER TABLE public.carline_pickup_groups ENABLE ROW LEVEL SECURITY;

-- Any carline user can read pickup groups for their school
CREATE POLICY carline_pickup_groups_read ON public.carline_pickup_groups
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND p.school_id = carline_pickup_groups.school_id
        AND (
          p.can_view_carline = true
          OR p.can_manage_carline = true
          OR p.is_superadmin = true
        )
    )
  );

-- Only carline managers and superadmins can create / update / delete
CREATE POLICY carline_pickup_groups_manage ON public.carline_pickup_groups
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND p.school_id = carline_pickup_groups.school_id
        AND (p.can_manage_carline = true OR p.is_superadmin = true)
    )
  );
