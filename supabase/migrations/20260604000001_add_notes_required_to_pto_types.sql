-- Adds notes_required to school_pto_types.
-- When true, the staff leave request form requires a non-empty notes entry
-- before submission. Configurable per school per type via the Leave Management
-- → Leave Policies admin panel.
ALTER TABLE public.school_pto_types
  ADD COLUMN IF NOT EXISTS notes_required boolean NOT NULL DEFAULT false;

-- Allow can_manage_pto_balances users to update their school's PTO type flags.
CREATE POLICY "Allow managers to update PTO types for their school"
  ON public.school_pto_types FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = school_pto_types.school_id
        AND (p.can_manage_pto_balances = true OR p.is_superadmin = true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = school_pto_types.school_id
        AND (p.can_manage_pto_balances = true OR p.is_superadmin = true)
    )
  );
