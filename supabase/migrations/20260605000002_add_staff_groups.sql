-- Staff groups: per-school reporting divisions (e.g. Elementary, Middle, High).
-- Independent of physical campuses so carline logic is unaffected.
CREATE TABLE public.staff_groups (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  sort_order integer     NOT NULL DEFAULT 99,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.staff_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "School members can view staff groups"
  ON public.staff_groups FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.school_id = staff_groups.school_id
    )
  );

CREATE POLICY "Campus managers can manage staff groups"
  ON public.staff_groups FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = staff_groups.school_id
        AND (p.can_manage_campuses = true OR p.is_superadmin = true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = staff_groups.school_id
        AND (p.can_manage_campuses = true OR p.is_superadmin = true)
    )
  );

-- Link employees to a staff group (nullable — unassigned staff are still valid)
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS staff_group_id uuid REFERENCES public.staff_groups(id) ON DELETE SET NULL;
