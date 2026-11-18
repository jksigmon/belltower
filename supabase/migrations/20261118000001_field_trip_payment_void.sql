-- Let trip managers void a mistaken payment entry instead of asking an admin
-- to fix it in SQL. Voided entries stay in the log for the audit trail.

ALTER TABLE public.field_trip_payment_log
  ADD COLUMN IF NOT EXISTS voided_at   timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by   uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS void_reason text;

-- Same access rule as ftpl_insert / ftpl_select: superadmin, or a manager of the trip's school.
DROP POLICY IF EXISTS ftpl_update ON public.field_trip_payment_log;
CREATE POLICY ftpl_update ON public.field_trip_payment_log FOR UPDATE
USING (EXISTS (
  SELECT 1
  FROM public.field_trip_payments ftp
  JOIN public.profiles p ON p.user_id = auth.uid()
  WHERE ftp.id = field_trip_payment_log.payment_id
    AND (p.is_superadmin = true
      OR (p.school_id = public.ft_get_school_id(ftp.field_trip_id)
          AND (p.can_manage_field_trips = true
            OR public.ft_is_manager(ftp.field_trip_id, p.id))))
))
WITH CHECK (EXISTS (
  SELECT 1
  FROM public.field_trip_payments ftp
  JOIN public.profiles p ON p.user_id = auth.uid()
  WHERE ftp.id = field_trip_payment_log.payment_id
    AND (p.is_superadmin = true
      OR (p.school_id = public.ft_get_school_id(ftp.field_trip_id)
          AND (p.can_manage_field_trips = true
            OR public.ft_is_manager(ftp.field_trip_id, p.id))))
));
