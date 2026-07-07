-- ============================================================
-- school_settings write policies (kiosk PIN save was 403'ing)
--
-- school_settings had RLS enabled with ONLY a SELECT policy
-- ("staff can read school settings"), so the carline kiosk-PIN
-- upsert (INSERT ... ON CONFLICT UPDATE) was blocked by RLS.
--
-- Gating mirrors the carline manage policies and the Pickup Groups
-- drawer that sets the PIN: superadmin, admin, or can_manage_carline.
-- Superadmins may write any school; admins / carline managers may
-- only write their own school's row.
-- ============================================================

DROP POLICY IF EXISTS "carline managers can insert school settings" ON public.school_settings;
CREATE POLICY "carline managers can insert school settings"
  ON public.school_settings FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (
        p.is_superadmin = true
        OR (p.school_id = school_settings.school_id
            AND (p.role = 'admin' OR p.can_manage_carline = true))
      )
  ));

DROP POLICY IF EXISTS "carline managers can update school settings" ON public.school_settings;
CREATE POLICY "carline managers can update school settings"
  ON public.school_settings FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (
        p.is_superadmin = true
        OR (p.school_id = school_settings.school_id
            AND (p.role = 'admin' OR p.can_manage_carline = true))
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (
        p.is_superadmin = true
        OR (p.school_id = school_settings.school_id
            AND (p.role = 'admin' OR p.can_manage_carline = true))
      )
  ));
