-- ======================================================================
-- Compliance Module Migration
-- Run once in Supabase SQL editor.
-- Adds: compliance_form_templates, compliance_form_links,
--       compliance_agreements, compliance_bg_check_requests
-- Plus: profiles.can_manage_compliance, schools.logo_url
-- ======================================================================

-- ── New permission column ─────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_compliance boolean NOT NULL DEFAULT false;

-- ── School logo (used by volunteer form renderer in Phase 2) ──────────
ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS logo_url text;

-- ======================================================================
-- TABLE: compliance_form_templates
-- One row per form type a school creates (e.g. Confidentiality Agreement)
-- ======================================================================
CREATE TABLE IF NOT EXISTS public.compliance_form_templates (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  title        text        NOT NULL,
  description  text,
  body_html    text        NOT NULL DEFAULT '',
  active       boolean     NOT NULL DEFAULT true,
  content_hash text,
  created_by   uuid        REFERENCES public.profiles(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.compliance_form_templates ENABLE ROW LEVEL SECURITY;

-- Compliance managers (and superadmins) have full access
CREATE POLICY compliance_form_templates_manager ON public.compliance_form_templates
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = compliance_form_templates.school_id
        AND (p.can_manage_compliance = true OR p.is_superadmin = true)
    )
  );

-- ======================================================================
-- TABLE: compliance_form_links
-- Token-based shareable URLs. One template can have many links
-- (e.g. per-year links, per-event links).
-- ======================================================================
CREATE TABLE IF NOT EXISTS public.compliance_form_links (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  template_id uuid        NOT NULL REFERENCES public.compliance_form_templates(id) ON DELETE CASCADE,
  token       char(32)    NOT NULL UNIQUE,
  label       text,
  expires_at  date,
  active      boolean     NOT NULL DEFAULT true,
  created_by  uuid        REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.compliance_form_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY compliance_form_links_manager ON public.compliance_form_links
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = compliance_form_links.school_id
        AND (p.can_manage_compliance = true OR p.is_superadmin = true)
    )
  );

-- ======================================================================
-- TABLE: compliance_agreements
-- One row per signed form submission.
-- Submissions come in via edge function (service role bypasses RLS).
-- Managers read and void via this table.
-- ======================================================================
CREATE TABLE IF NOT EXISTS public.compliance_agreements (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  template_id     uuid        NOT NULL REFERENCES public.compliance_form_templates(id),
  form_link_id    uuid        REFERENCES public.compliance_form_links(id),
  signer_name     text        NOT NULL,
  signer_email    text        NOT NULL,
  signature_type  text        NOT NULL CHECK (signature_type IN ('draw', 'typed')),
  signature_data  text        NOT NULL,
  content_hash    text,
  ip_address      text,
  user_agent      text,
  signed_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      date,
  voided_at       timestamptz,
  voided_by       uuid        REFERENCES public.profiles(id)
);

ALTER TABLE public.compliance_agreements ENABLE ROW LEVEL SECURITY;

-- Managers can read and update (void) agreements
CREATE POLICY compliance_agreements_manager ON public.compliance_agreements
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = compliance_agreements.school_id
        AND (p.can_manage_compliance = true OR p.is_superadmin = true)
    )
  );

-- ======================================================================
-- TABLE: compliance_bg_check_requests
-- Staff submit these to request a background check on a parent/visitor.
-- Staff see only their own; managers see all for the school.
-- ======================================================================
CREATE TABLE IF NOT EXISTS public.compliance_bg_check_requests (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  requestor_id       uuid        NOT NULL REFERENCES public.profiles(id),
  subject_first_name text        NOT NULL,
  subject_last_name  text        NOT NULL,
  subject_email      text,
  reason             text,
  status             text        NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'submitted', 'cleared', 'expired', 'cancelled')),
  requested_at       timestamptz NOT NULL DEFAULT now(),
  submitted_at       timestamptz,
  cleared_at         timestamptz,
  expires_at         date,
  notes              text,
  admin_note         text
);

ALTER TABLE public.compliance_bg_check_requests ENABLE ROW LEVEL SECURITY;

-- Staff see only their own requests
CREATE POLICY bg_check_staff_read ON public.compliance_bg_check_requests
  FOR SELECT USING (
    requestor_id = (
      SELECT id FROM public.profiles WHERE user_id = auth.uid()
    )
  );

-- Managers see all for their school
CREATE POLICY bg_check_manager_read ON public.compliance_bg_check_requests
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = compliance_bg_check_requests.school_id
        AND (p.can_manage_compliance = true OR p.is_superadmin = true)
    )
  );

-- Staff can create requests for their own school
CREATE POLICY bg_check_staff_insert ON public.compliance_bg_check_requests
  FOR INSERT WITH CHECK (
    requestor_id = (
      SELECT id FROM public.profiles
      WHERE user_id = auth.uid()
        AND school_id = compliance_bg_check_requests.school_id
    )
  );

-- Staff can cancel their own pending requests (status → 'cancelled')
CREATE POLICY bg_check_staff_cancel ON public.compliance_bg_check_requests
  FOR UPDATE USING (
    requestor_id = (
      SELECT id FROM public.profiles WHERE user_id = auth.uid()
    )
    AND status = 'pending'
  ) WITH CHECK (status = 'cancelled');

-- Managers can update any request in their school (change status, add notes)
CREATE POLICY bg_check_manager_update ON public.compliance_bg_check_requests
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = compliance_bg_check_requests.school_id
        AND (p.can_manage_compliance = true OR p.is_superadmin = true)
    )
  );

-- ======================================================================
-- Indexes
-- ======================================================================
CREATE INDEX IF NOT EXISTS idx_compliance_form_links_token
  ON public.compliance_form_links(token);

CREATE INDEX IF NOT EXISTS idx_compliance_agreements_school_email
  ON public.compliance_agreements(school_id, signer_email);

CREATE INDEX IF NOT EXISTS idx_compliance_agreements_template
  ON public.compliance_agreements(template_id, signed_at);

CREATE INDEX IF NOT EXISTS idx_bg_check_requests_school
  ON public.compliance_bg_check_requests(school_id, status);

CREATE INDEX IF NOT EXISTS idx_bg_check_requests_requestor
  ON public.compliance_bg_check_requests(requestor_id);
