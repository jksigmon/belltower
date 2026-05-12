-- ====================================================
-- Belltower — Licensure Tracking Module
-- Run this entire file in the Supabase SQL editor
-- ====================================================


-- ── 1. Profile permission column ────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_licensure boolean DEFAULT false NOT NULL;


-- ── 2. staff_licenses ───────────────────────────────
CREATE TABLE public.staff_licenses (
  id              uuid DEFAULT gen_random_uuid() NOT NULL,
  school_id       uuid NOT NULL,
  employee_id     uuid NOT NULL,
  license_number  text,
  state           text DEFAULT 'NC' NOT NULL,

  -- License classification
  license_type    text NOT NULL,
  -- IPL | CPL | Residency | Emergency | Permit | CTE_Provisional | Admin | Student_Services
  category        text NOT NULL DEFAULT 'teaching',
  -- teaching | admin | support | substitute

  -- Authorization
  license_area        text,    -- Elementary Education, Mathematics, English Language Arts, etc.
  grade_authorization text,    -- K-6 | 6-9 | 9-12 | K-12

  -- Dates
  issue_date      date,
  expiration_date date,

  -- Provisional / temporary
  is_provisional   boolean DEFAULT false NOT NULL,
  provisional_type text,
  -- emergency | residency | permit | cte_provisional

  -- Status
  status          text DEFAULT 'active' NOT NULL,
  -- active | expiring | expired | pending_renewal | suspended | revoked
  renewal_status  text DEFAULT 'not_started' NOT NULL,
  -- not_started | in_progress | submitted

  -- Applicability
  campus_id           uuid,    -- NULL = all campuses
  role_applicability  text[] DEFAULT '{}',
  -- {teacher, substitute, admin, ec, support}

  -- Verification
  verified      boolean DEFAULT false NOT NULL,
  verified_by   uuid,
  verified_at   timestamp with time zone,

  -- Alert control
  alert_muted   boolean DEFAULT false NOT NULL,

  -- Misc
  notes       text,
  created_at  timestamp with time zone DEFAULT now() NOT NULL,
  updated_at  timestamp with time zone DEFAULT now() NOT NULL,
  created_by  uuid
);


-- ── 3. staff_license_history (audit trail) ──────────
CREATE TABLE public.staff_license_history (
  id           uuid DEFAULT gen_random_uuid() NOT NULL,
  license_id   uuid NOT NULL,
  school_id    uuid NOT NULL,
  changed_by   uuid,
  changed_at   timestamp with time zone DEFAULT now() NOT NULL,
  change_type  text NOT NULL,
  -- created | updated | renewed | verified | deleted
  field_changes jsonb
);


-- ── 4. license_alert_log ────────────────────────────
CREATE TABLE public.license_alert_log (
  id           uuid DEFAULT gen_random_uuid() NOT NULL,
  school_id    uuid NOT NULL,
  license_id   uuid NOT NULL,
  employee_id  uuid NOT NULL,
  alert_type   text NOT NULL,
  -- 90_day | 60_day | 30_day | 7_day | expired
  sent_at      timestamp with time zone DEFAULT now() NOT NULL
);


-- ── Primary keys ────────────────────────────────────
ALTER TABLE ONLY public.staff_licenses
  ADD CONSTRAINT staff_licenses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.staff_license_history
  ADD CONSTRAINT staff_license_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.license_alert_log
  ADD CONSTRAINT license_alert_log_pkey PRIMARY KEY (id);


-- ── Foreign keys ────────────────────────────────────
ALTER TABLE ONLY public.staff_licenses
  ADD CONSTRAINT staff_licenses_school_id_fkey
  FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.staff_licenses
  ADD CONSTRAINT staff_licenses_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.staff_licenses
  ADD CONSTRAINT staff_licenses_campus_id_fkey
  FOREIGN KEY (campus_id) REFERENCES public.campuses(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.staff_license_history
  ADD CONSTRAINT staff_license_history_license_id_fkey
  FOREIGN KEY (license_id) REFERENCES public.staff_licenses(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.license_alert_log
  ADD CONSTRAINT license_alert_log_license_id_fkey
  FOREIGN KEY (license_id) REFERENCES public.staff_licenses(id) ON DELETE CASCADE;


-- ── Indexes ─────────────────────────────────────────
CREATE INDEX idx_staff_licenses_school_id   ON public.staff_licenses USING btree (school_id);
CREATE INDEX idx_staff_licenses_employee_id ON public.staff_licenses USING btree (employee_id);
CREATE INDEX idx_staff_licenses_expiration  ON public.staff_licenses USING btree (school_id, expiration_date);
CREATE INDEX idx_license_history_license_id ON public.staff_license_history USING btree (license_id);
CREATE INDEX idx_license_alert_log          ON public.license_alert_log USING btree (license_id, alert_type, sent_at);

-- One alert per license per threshold per calendar day
CREATE UNIQUE INDEX uq_license_alert_daily
  ON public.license_alert_log USING btree (license_id, alert_type, ((sent_at AT TIME ZONE 'America/New_York')::date));


-- ── updated_at trigger ──────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_staff_licenses_updated_at
  BEFORE UPDATE ON public.staff_licenses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ── Enable RLS ──────────────────────────────────────
ALTER TABLE public.staff_licenses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_license_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.license_alert_log     ENABLE ROW LEVEL SECURITY;


-- ── RLS: staff_licenses ─────────────────────────────

-- Admins see all licenses for their school
CREATE POLICY "Licenses: admin select" ON public.staff_licenses
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = staff_licenses.school_id
        AND (p.is_superadmin OR p.can_manage_licensure)
    )
  );

-- Staff see only their own license records
CREATE POLICY "Licenses: staff own select" ON public.staff_licenses
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.employee_id = staff_licenses.employee_id
    )
  );

CREATE POLICY "Licenses: admin insert" ON public.staff_licenses
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = staff_licenses.school_id
        AND (p.is_superadmin OR p.can_manage_licensure)
    )
  );

CREATE POLICY "Licenses: admin update" ON public.staff_licenses
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = staff_licenses.school_id
        AND (p.is_superadmin OR p.can_manage_licensure)
    )
  );

CREATE POLICY "Licenses: admin delete" ON public.staff_licenses
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = staff_licenses.school_id
        AND (p.is_superadmin OR p.can_manage_licensure)
    )
  );


-- ── RLS: staff_license_history ──────────────────────

CREATE POLICY "License history: admin select" ON public.staff_license_history
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = staff_license_history.school_id
        AND (p.is_superadmin OR p.can_manage_licensure)
    )
  );

CREATE POLICY "License history: insert" ON public.staff_license_history
  FOR INSERT WITH CHECK (
    school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid())
  );


-- ── RLS: license_alert_log ──────────────────────────

CREATE POLICY "License alerts: admin select" ON public.license_alert_log
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = license_alert_log.school_id
        AND (p.is_superadmin OR p.can_manage_licensure)
    )
  );

CREATE POLICY "License alerts: insert" ON public.license_alert_log
  FOR INSERT WITH CHECK (
    school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid())
  );


-- ── Enable module for your school(s) ────────────────
-- Replace <school-id> with your actual school UUID from the schools table.
-- Run once per school that should have licensure tracking enabled.
--
-- INSERT INTO public.school_modules (school_id, module, enabled)
-- VALUES ('<school-id>', 'licensure', true)
-- ON CONFLICT (school_id, module) DO UPDATE SET enabled = true;
