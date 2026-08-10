-- carline_calls INSERT/UPDATE/DELETE policies only checked role='admin'/
-- is_superadmin, ignoring can_manage_carline even though the frontend
-- (carline.html, carline-input.html) gates the Call/Recall/Bus buttons on
-- can_manage_carline. A front-office user with can_manage_carline=true but
-- role != 'admin' would see the buttons but every call would be silently
-- rejected by RLS. This brings carline_calls in line with the pattern
-- already used on carline_pickup_groups.

DROP POLICY IF EXISTS carline_calls_insert_admin ON public.carline_calls;
CREATE POLICY carline_calls_insert_admin ON public.carline_calls
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (p.is_superadmin = true OR p.role = 'admin' OR p.can_manage_carline = true)
    )
  );

DROP POLICY IF EXISTS carline_calls_update_admin ON public.carline_calls;
CREATE POLICY carline_calls_update_admin ON public.carline_calls
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (p.is_superadmin = true OR p.role = 'admin' OR p.can_manage_carline = true)
    )
  );

DROP POLICY IF EXISTS carline_calls_delete_admin ON public.carline_calls;
CREATE POLICY carline_calls_delete_admin ON public.carline_calls
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (p.is_superadmin = true OR p.role = 'admin' OR p.can_manage_carline = true)
    )
  );
