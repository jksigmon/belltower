-- ============================================================
-- Required Training becomes its own module, not a Compliance sub-tab.
--
-- 20260920000002 put staff_required_training under can_manage_compliance
-- on the assumption it belonged in the existing Compliance module.
-- Compliance is specifically background checks + volunteer agreements;
-- Required Training (Safe Schools/AED/CPR/Vector completions) is a
-- different concern with no necessary overlap in who manages it, and for
-- multi-school rollout a school should be able to enable/staff one without
-- the other. This gives it its own permission and its own school_modules
-- key ('required_training'), following the exact pattern can_manage_licensure
-- and can_manage_compliance already use.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_required_training boolean DEFAULT false NOT NULL;

-- log_permission_changes() (20260727000001) tracks a fixed field list, not
-- every boolean column -- a new permission has to be added here or its
-- grant/revoke history silently never reaches permission_audit_log.
CREATE OR REPLACE FUNCTION public.log_permission_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  old_json jsonb := to_jsonb(OLD);
  new_json jsonb := to_jsonb(NEW);
  tracked_fields text[] := ARRAY[
    'can_login', 'can_access_admin', 'can_manage_access',
    'can_manage_staff', 'can_manage_students', 'can_manage_placement',
    'can_manage_families', 'can_manage_guardians', 'can_manage_bus_groups',
    'can_manage_carpools', 'can_manage_substitutes',
    'can_view_carline', 'can_manage_carline',
    'can_manage_campuses', 'can_manage_calendar',
    'can_manage_resource_docs', 'can_manage_reservations', 'can_manage_inventory',
    'can_manage_licensure', 'can_manage_compliance', 'can_manage_chaperone_credentials',
    'can_manage_required_training', 'can_manage_field_trips',
    'can_manage_requests', 'can_bulk_upload', 'can_export_data',
    'can_view_pto_calendar', 'can_review_pto', 'can_approve_pto',
    'can_submit_on_behalf', 'is_fallback_approver',
    'can_adjust_pto', 'can_manage_pto_balances', 'can_generate_pto_reports'
  ];
  field text;
  changer_id uuid;
BEGIN
  SELECT id INTO changer_id FROM public.profiles WHERE user_id = auth.uid();

  FOREACH field IN ARRAY tracked_fields LOOP
    IF old_json -> field IS DISTINCT FROM new_json -> field THEN
      INSERT INTO public.permission_audit_log
        (school_id, target_profile_id, changed_by_profile_id, field_name, old_value, new_value)
      VALUES (
        NEW.school_id, NEW.id, changer_id, field,
        (old_json ->> field)::boolean, (new_json ->> field)::boolean
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_user_can_manage_required_training(target_school_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
    AS $$
  select coalesce(
    bool_or(
      status = 'active' AND (
        is_superadmin = true
        OR (can_manage_required_training = true AND school_id = target_school_id)
      )
    ),
    false
  )
  from profiles
  where user_id = auth.uid();
$$;

-- Swap the admin-facing policies on staff_required_training from
-- can_manage_compliance to can_manage_required_training. Staff self-service
-- policies (own select/insert/update/delete while unverified) are unchanged.
DROP POLICY IF EXISTS "Required training: admin select" ON public.staff_required_training;
CREATE POLICY "Required training: admin select" ON public.staff_required_training FOR SELECT USING (
    public.current_user_can_manage_required_training(staff_required_training.school_id)
);

DROP POLICY IF EXISTS "Required training: admin insert" ON public.staff_required_training;
CREATE POLICY "Required training: admin insert" ON public.staff_required_training FOR INSERT WITH CHECK (
    public.current_user_can_manage_required_training(staff_required_training.school_id)
);

DROP POLICY IF EXISTS "Required training: admin update" ON public.staff_required_training;
CREATE POLICY "Required training: admin update" ON public.staff_required_training FOR UPDATE USING (
    public.current_user_can_manage_required_training(staff_required_training.school_id)
);

DROP POLICY IF EXISTS "Required training: admin delete" ON public.staff_required_training;
CREATE POLICY "Required training: admin delete" ON public.staff_required_training FOR DELETE USING (
    public.current_user_can_manage_required_training(staff_required_training.school_id)
);

DROP POLICY IF EXISTS "Training files storage: admin manage" ON storage.objects;
CREATE POLICY "Training files storage: admin manage" ON storage.objects
    FOR ALL USING (
        bucket_id = 'training-files'
        AND public.current_user_can_manage_required_training(((storage.foldername(name))[1])::uuid)
    );

-- Orphaned by the swap above -- nothing references the 1-arg
-- current_user_can_manage_compliance(uuid) added by 20260920000002 anymore.
DROP FUNCTION IF EXISTS public.current_user_can_manage_compliance(uuid);
