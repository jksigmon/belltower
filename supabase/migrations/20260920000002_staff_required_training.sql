-- ============================================================
-- Required/compliance training tracking, separate from CEUs.
--
-- Safe Schools, AED, CPR, and similar Vector Solutions style trainings are
-- employment-required compliance training, not NC renewal credit -- they
-- don't appear anywhere in NC SBE Policy LICN-005's renewal-credit
-- categories. Before this table existed, the only place to log them was
-- staff_license_ceus with license_id NULL ("General CEU (not tied to a
-- license)"), which labels them as CEUs and shows them next to a running
-- "Total X CEUs" figure on the staff Licensure page -- exactly the kind of
-- record that makes a teacher think a Safe Schools module counted toward
-- their 8-credit renewal requirement when it never did.
--
-- This table is intentionally CEU-shaped in its verification workflow
-- (staff self-report, admin verifies, optional certificate upload) but has
-- no category/hours/ceu_amount columns at all -- there's nothing here to
-- convert into a credit. It lives under the Compliance module
-- (can_manage_compliance), not Licensure, since that's where Belltower
-- already tracks other employment-required records (background checks,
-- signed agreements).
-- ============================================================

CREATE OR REPLACE FUNCTION public.current_user_can_manage_compliance(target_school_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
    AS $$
  select coalesce(
    bool_or(
      status = 'active' AND (
        is_superadmin = true
        OR (can_manage_compliance = true AND school_id = target_school_id)
      )
    ),
    false
  )
  from profiles
  where user_id = auth.uid();
$$;

CREATE TABLE public.staff_required_training (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    training_name text NOT NULL,
    provider text DEFAULT 'Vector Solutions'::text,
    completed_date date NOT NULL,
    expires_date date,
    verified boolean DEFAULT false NOT NULL,
    verified_by uuid,
    verified_at timestamp with time zone,
    file_path text,
    file_name text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT staff_required_training_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_staff_required_training_school_id   ON public.staff_required_training USING btree (school_id);
CREATE INDEX idx_staff_required_training_employee_id ON public.staff_required_training USING btree (employee_id);
CREATE INDEX idx_staff_required_training_expires     ON public.staff_required_training USING btree (school_id, expires_date);

CREATE TRIGGER trg_staff_required_training_updated_at BEFORE UPDATE ON public.staff_required_training
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.staff_required_training ENABLE ROW LEVEL SECURITY;

-- No anon policy exists below, so no anon grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_required_training TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_required_training TO service_role;

CREATE POLICY "Required training: admin select" ON public.staff_required_training FOR SELECT USING (
    public.current_user_can_manage_compliance(staff_required_training.school_id)
);

CREATE POLICY "Required training: staff own select" ON public.staff_required_training FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND p.employee_id = staff_required_training.employee_id
    )
);

CREATE POLICY "Required training: admin insert" ON public.staff_required_training FOR INSERT WITH CHECK (
    public.current_user_can_manage_compliance(staff_required_training.school_id)
);

CREATE POLICY "Required training: staff own insert" ON public.staff_required_training FOR INSERT WITH CHECK (
    verified = false
    AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND p.employee_id = staff_required_training.employee_id
    )
);

CREATE POLICY "Required training: admin update" ON public.staff_required_training FOR UPDATE USING (
    public.current_user_can_manage_compliance(staff_required_training.school_id)
);

CREATE POLICY "Required training: staff own update while unverified" ON public.staff_required_training FOR UPDATE USING (
    verified = false
    AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND p.employee_id = staff_required_training.employee_id
    )
) WITH CHECK (
    verified = false
    AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND p.employee_id = staff_required_training.employee_id
    )
);

CREATE POLICY "Required training: admin delete" ON public.staff_required_training FOR DELETE USING (
    public.current_user_can_manage_compliance(staff_required_training.school_id)
);

CREATE POLICY "Required training: staff own delete while unverified" ON public.staff_required_training FOR DELETE USING (
    verified = false
    AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND p.employee_id = staff_required_training.employee_id
    )
);

-- ── Storage: training-files (private) ──
-- Path convention mirrors ceu-files: `${school_id}/${training_id}/${timestamp}-${filename}`.
INSERT INTO storage.buckets (id, name, public)
VALUES ('training-files', 'training-files', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Training files storage: admin manage" ON storage.objects;
CREATE POLICY "Training files storage: admin manage" ON storage.objects
    FOR ALL USING (
        bucket_id = 'training-files'
        AND public.current_user_can_manage_compliance(((storage.foldername(name))[1])::uuid)
    );

DROP POLICY IF EXISTS "Training files storage: read own" ON storage.objects;
CREATE POLICY "Training files storage: read own" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'training-files'
        AND EXISTS (
            SELECT 1 FROM public.staff_required_training t
            JOIN public.profiles p ON p.employee_id = t.employee_id
            WHERE t.id::text = (storage.foldername(name))[2]
              AND p.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Training files storage: staff insert own unverified" ON storage.objects;
CREATE POLICY "Training files storage: staff insert own unverified" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'training-files'
        AND EXISTS (
            SELECT 1 FROM public.staff_required_training t
            JOIN public.profiles p ON p.employee_id = t.employee_id
            WHERE t.id::text = (storage.foldername(name))[2]
              AND p.user_id = auth.uid()
              AND t.verified = false
        )
    );

DROP POLICY IF EXISTS "Training files storage: staff delete own unverified" ON storage.objects;
CREATE POLICY "Training files storage: staff delete own unverified" ON storage.objects
    FOR DELETE USING (
        bucket_id = 'training-files'
        AND EXISTS (
            SELECT 1 FROM public.staff_required_training t
            JOIN public.profiles p ON p.employee_id = t.employee_id
            WHERE t.id::text = (storage.foldername(name))[2]
              AND p.user_id = auth.uid()
              AND t.verified = false
        )
    );
