-- Add missing FOR UPDATE policy to field_trip_managers.
-- Required because upsert generates ON CONFLICT DO UPDATE,
-- which PostgreSQL requires an UPDATE policy to satisfy.
-- Depends on ft_get_school_id() from field-trips-rls-fix.sql.

CREATE POLICY ftm_update ON public.field_trip_managers
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = public.ft_get_school_id(field_trip_managers.field_trip_id)
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          EXISTS (
            SELECT 1 FROM public.field_trip_managers m2
            WHERE m2.field_trip_id = field_trip_managers.field_trip_id
              AND m2.profile_id = p.id
          )
        )
    )
  );
