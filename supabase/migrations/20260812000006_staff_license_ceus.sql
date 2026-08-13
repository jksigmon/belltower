-- ============================================================
-- CEU tracking for the Licensure module.
--
-- NC requires 8 CEUs (80 clock hours) per 5-year Continuing
-- Professional License renewal cycle, split into role-dependent
-- category minimums (e.g. PreK-6 teachers need 3 Literacy / 3
-- Content / 2 Digital Learning; administrators need 3 Admin / 3
-- General / 2 Digital Learning). staff_licenses already carries
-- `category` ('teaching'|'admin'|'support'|'substitute') and
-- `grade_authorization` ('K-6'|'6-9'|'9-12'|'K-12'), which the
-- admin UI uses to pick the right target profile client-side --
-- this migration only needs to store individual CEU entries and
-- let the app compute progress against those targets.
--
-- Each entry converts to a CEU amount at save time via a generated
-- column so the stored ceu_amount can never drift from hours/source:
-- 1 CEU = 10 clock hours (LEA in-service / LEA-approved workshops),
-- or 1 semester credit = 1.5 CEUs (college coursework) -- `hours`
-- holds whichever input unit source_type implies.
--
-- RLS mirrors staff_licenses exactly (admin manage-all via
-- can_manage_licensure/is_superadmin, staff read-only on their own
-- records) EXCEPT admin select uses the SECURITY DEFINER
-- current_user_can_manage_licensure() helper instead of a raw
-- inline EXISTS(...FROM profiles...): the new CEUs tab loads every
-- entry for a school in one query (same shape as the Student
-- Directory / field-trips list queries that caused the
-- 20260812000001/000004/000005 statement-timeout incidents earlier
-- today), so this table starts on the safe pattern instead of
-- needing a follow-up fix once it has real data in it.
--
-- Staff self-entry (staff logging their own PD, admin verifies) is
-- intentionally NOT included yet -- only a staff read-own SELECT
-- policy is added below. Add a "CEUs: staff own insert" policy
-- alongside the staff-facing "Add CEU" UI when that's built.
-- ============================================================

CREATE OR REPLACE FUNCTION public.current_user_can_manage_licensure(target_school_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
    AS $$
  select coalesce(
    bool_or(
      status = 'active' AND (
        is_superadmin = true
        OR (can_manage_licensure = true AND school_id = target_school_id)
      )
    ),
    false
  )
  from profiles
  where user_id = auth.uid();
$$;

CREATE TABLE public.staff_license_ceus (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    license_id uuid NOT NULL REFERENCES public.staff_licenses(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    category text NOT NULL,
    title text NOT NULL,
    provider text,
    source_type text DEFAULT 'lea_inservice'::text NOT NULL,
    hours numeric NOT NULL,
    ceu_amount numeric GENERATED ALWAYS AS (
        CASE WHEN source_type = 'college_credit' THEN hours * 1.5 ELSE hours / 10 END
    ) STORED,
    completed_date date NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    verified_by uuid,
    verified_at timestamp with time zone,
    file_path text,
    file_name text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT staff_license_ceus_pkey PRIMARY KEY (id),
    CONSTRAINT staff_license_ceus_category_check CHECK (category = ANY (ARRAY[
        'literacy'::text, 'content'::text, 'digital_learning'::text,
        'administration'::text, 'professional_discipline'::text, 'general_other'::text
    ])),
    CONSTRAINT staff_license_ceus_source_type_check CHECK (source_type = ANY (ARRAY[
        'college_credit'::text, 'lea_inservice'::text, 'lea_approved'::text
    ])),
    CONSTRAINT staff_license_ceus_hours_check CHECK (hours > 0)
);

CREATE INDEX idx_staff_license_ceus_school_id ON public.staff_license_ceus USING btree (school_id);
CREATE INDEX idx_staff_license_ceus_license_id ON public.staff_license_ceus USING btree (license_id);
CREATE INDEX idx_staff_license_ceus_employee_id ON public.staff_license_ceus USING btree (employee_id);

CREATE TRIGGER trg_staff_license_ceus_updated_at BEFORE UPDATE ON public.staff_license_ceus
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.staff_license_ceus ENABLE ROW LEVEL SECURITY;

CREATE POLICY "CEUs: admin select" ON public.staff_license_ceus FOR SELECT USING (
    public.current_user_can_manage_licensure(staff_license_ceus.school_id)
);

CREATE POLICY "CEUs: staff own select" ON public.staff_license_ceus FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND p.employee_id = staff_license_ceus.employee_id
    )
);

CREATE POLICY "CEUs: admin insert" ON public.staff_license_ceus FOR INSERT WITH CHECK (
    public.current_user_can_manage_licensure(staff_license_ceus.school_id)
);

CREATE POLICY "CEUs: admin update" ON public.staff_license_ceus FOR UPDATE USING (
    public.current_user_can_manage_licensure(staff_license_ceus.school_id)
);

CREATE POLICY "CEUs: admin delete" ON public.staff_license_ceus FOR DELETE USING (
    public.current_user_can_manage_licensure(staff_license_ceus.school_id)
);

-- ── Storage: ceu-files (private) ──
-- Path convention mirrors license-files: `${school_id}/${ceu_id}/${timestamp}-${filename}`.
INSERT INTO storage.buckets (id, name, public)
VALUES ('ceu-files', 'ceu-files', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "CEU files storage: admin manage" ON storage.objects;
CREATE POLICY "CEU files storage: admin manage" ON storage.objects
    FOR ALL USING (
        bucket_id = 'ceu-files'
        AND public.current_user_can_manage_licensure(((storage.foldername(name))[1])::uuid)
    );

DROP POLICY IF EXISTS "CEU files storage: read own" ON storage.objects;
CREATE POLICY "CEU files storage: read own" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'ceu-files'
        AND EXISTS (
            SELECT 1 FROM public.staff_license_ceus c
            JOIN public.profiles p ON p.employee_id = c.employee_id
            WHERE c.id::text = (storage.foldername(name))[2]
              AND p.user_id = auth.uid()
        )
    );
