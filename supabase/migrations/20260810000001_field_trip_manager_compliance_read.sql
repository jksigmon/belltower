-- Field trip managers (field_trip_managers table) could not read compliance
-- data for their own trips' chaperones — the read policies added in
-- field-trips-chaperone-forms-migration.sql only checked can_manage_field_trips
-- / is_superadmin, never per-trip manager membership. This extends them to
-- match the pattern already used on field_trips/field_trip_chaperones.

DROP POLICY IF EXISTS compliance_agreements_ft_read ON public.compliance_agreements;
CREATE POLICY compliance_agreements_ft_read ON public.compliance_agreements
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = compliance_agreements.school_id
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          EXISTS (
            SELECT 1 FROM public.field_trip_managers m
            JOIN public.field_trips ft ON ft.id = m.field_trip_id
            WHERE m.profile_id = p.id AND ft.school_id = compliance_agreements.school_id
          )
        )
    )
  );

DROP POLICY IF EXISTS compliance_form_templates_ft_read ON public.compliance_form_templates;
CREATE POLICY compliance_form_templates_ft_read ON public.compliance_form_templates
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = compliance_form_templates.school_id
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          EXISTS (
            SELECT 1 FROM public.field_trip_managers m
            JOIN public.field_trips ft ON ft.id = m.field_trip_id
            WHERE m.profile_id = p.id AND ft.school_id = compliance_form_templates.school_id
          )
        )
    )
  );

DROP POLICY IF EXISTS bg_check_ft_read ON public.compliance_bg_check_requests;
CREATE POLICY bg_check_ft_read ON public.compliance_bg_check_requests
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = compliance_bg_check_requests.school_id
        AND (
          p.can_manage_field_trips = true OR p.is_superadmin = true OR
          EXISTS (
            SELECT 1 FROM public.field_trip_managers m
            JOIN public.field_trips ft ON ft.id = m.field_trip_id
            WHERE m.profile_id = p.id AND ft.school_id = compliance_bg_check_requests.school_id
          )
        )
    )
  );
