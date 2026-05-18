-- Carline fix: add all_call_at column + broaden INSERT/UPDATE RLS to can_manage_carline
--
-- Bug 1: all_call_at was referenced in code but never added to the table.
--        Every carline SELECT was returning 400, so sessions could never be detected.
--
-- Bug 2: INSERT and UPDATE policies only allowed role='admin', blocking users who
--        have can_manage_carline permission from starting or closing dismissal.

-- 1. Add missing column
ALTER TABLE public.carline_events
  ADD COLUMN IF NOT EXISTS all_call_at timestamptz;

-- 2. Fix INSERT policy
DROP POLICY IF EXISTS carline_events_insert_admin ON public.carline_events;
CREATE POLICY carline_events_insert_admin ON public.carline_events
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (p.is_superadmin = true OR p.role = 'admin' OR p.can_manage_carline = true)
  ));

-- 3. Fix UPDATE policy
DROP POLICY IF EXISTS carline_events_update_admin ON public.carline_events;
CREATE POLICY carline_events_update_admin ON public.carline_events
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (p.is_superadmin = true OR p.role = 'admin' OR p.can_manage_carline = true)
  ));
