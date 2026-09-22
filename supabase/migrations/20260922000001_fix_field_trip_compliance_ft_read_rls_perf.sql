-- ============================================================
-- Fix: field trip managers timing out (57014 statement timeout) reading
-- compliance data for their own trips' chaperones -- e.g. the Field
-- Trips chaperone tab's Background Check column always showing "No
-- Record" for a manager who isn't also can_manage_field_trips/
-- is_superadmin, even though the underlying data and grant are correct.
--
-- Root cause: compliance_volunteers_ft_read (20260812000002) and its
-- three siblings compliance_agreements_ft_read/
-- compliance_form_templates_ft_read/bg_check_ft_read
-- (20260810000001_field_trip_manager_compliance_read.sql) all use a raw
--   EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() ...)
-- which isn't SECURITY DEFINER, so it re-triggers profiles' own RLS
-- policies on every evaluation -- the exact anti-pattern already fixed
-- for guardians/families in 20260812000001_fix_guardians_families_rls_perf.sql,
-- but these four policies (written the same day, different migration)
-- never got it.
--
-- For can_manage_field_trips/is_superadmin holders the policy's first
-- OR branch is a plain boolean and short-circuits immediately. For a
-- plain field-trip manager, none of the cheap branches are true, so
-- Postgres falls through to the correlated EXISTS(field_trip_managers
-- JOIN field_trips) branch -- re-run, with the profiles RLS recursion,
-- for every row PostgREST scans (compliance_volunteer_status alone is
-- ~900 rows/school). That blows past the 8s statement timeout for a
-- manager-only profile while an admin's session never even reaches it.
--
-- Fix: a SECURITY DEFINER STABLE helper (matching current_user_is_active_in_school's
-- existing pattern) that bypasses profiles' RLS entirely. Also drops the
-- redundant ft.school_id join -- a non-superadmin's field_trip_managers
-- rows are already guaranteed same-school by ftm_insert's WITH CHECK, so
-- checking p.school_id = target_school_id (already required) makes the
-- second join unnecessary. Same set of allowed school_ids as before, just
-- without the recursion or the extra join.
-- ============================================================

CREATE OR REPLACE FUNCTION public.current_user_can_ft_read_compliance(target_school_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.school_id = target_school_id
      AND p.status = 'active'
      AND (
        p.can_manage_field_trips = true
        OR p.is_superadmin = true
        OR EXISTS (
          SELECT 1 FROM public.field_trip_managers m
          WHERE m.profile_id = p.id
        )
      )
  );
$$;

DROP POLICY IF EXISTS compliance_volunteers_ft_read ON public.compliance_volunteers;
CREATE POLICY compliance_volunteers_ft_read ON public.compliance_volunteers
  FOR SELECT USING (public.current_user_can_ft_read_compliance(compliance_volunteers.school_id));

DROP POLICY IF EXISTS compliance_agreements_ft_read ON public.compliance_agreements;
CREATE POLICY compliance_agreements_ft_read ON public.compliance_agreements
  FOR SELECT USING (public.current_user_can_ft_read_compliance(compliance_agreements.school_id));

DROP POLICY IF EXISTS compliance_form_templates_ft_read ON public.compliance_form_templates;
CREATE POLICY compliance_form_templates_ft_read ON public.compliance_form_templates
  FOR SELECT USING (public.current_user_can_ft_read_compliance(compliance_form_templates.school_id));

DROP POLICY IF EXISTS bg_check_ft_read ON public.compliance_bg_check_requests;
CREATE POLICY bg_check_ft_read ON public.compliance_bg_check_requests
  FOR SELECT USING (public.current_user_can_ft_read_compliance(compliance_bg_check_requests.school_id));
