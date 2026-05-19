-- ======================================================================
-- Field Trips: Chaperone Form Requirements
-- Run once in Supabase SQL editor.
-- Adds: compliance_form_templates.required_for_chaperones
-- Plus: RLS read policies so field trip managers can read compliance data
-- ======================================================================

-- ── Flag on form templates ────────────────────────────────────────────
ALTER TABLE public.compliance_form_templates
  ADD COLUMN IF NOT EXISTS required_for_chaperones boolean NOT NULL DEFAULT false;

-- ── Allow field trip managers to read compliance agreements ───────────
-- (needed so field-trips.html can check whether chaperones have signed)

CREATE POLICY compliance_agreements_ft_read ON public.compliance_agreements
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = compliance_agreements.school_id
        AND (p.can_manage_field_trips = true OR p.is_superadmin = true)
    )
  );

CREATE POLICY compliance_form_templates_ft_read ON public.compliance_form_templates
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = compliance_form_templates.school_id
        AND (p.can_manage_field_trips = true OR p.is_superadmin = true)
    )
  );

-- bg_check_requests already has a separate manager read policy;
-- add a parallel one for field trip managers
CREATE POLICY bg_check_ft_read ON public.compliance_bg_check_requests
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = compliance_bg_check_requests.school_id
        AND (p.can_manage_field_trips = true OR p.is_superadmin = true)
    )
  );
