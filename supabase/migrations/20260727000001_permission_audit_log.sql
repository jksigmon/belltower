-- ============================================================
-- Permission change audit log
-- ============================================================
-- Logs every change to a permission boolean on profiles: who changed it,
-- whose permission it was, which field, and the old/new value. Implemented
-- as a trigger (not application-level logging) so it can't be bypassed or
-- forgotten by a future code path that updates profiles directly — the
-- new bulk permissions grid and the existing per-user editor both flow
-- through the same ordinary UPDATE, so both get logged automatically.
--
-- is_superadmin is intentionally NOT tracked here — it isn't toggleable
-- from any admin UI (no checkbox exists for it) and is treated as a
-- separate, more sensitive flag managed outside this system.
-- ============================================================

CREATE TABLE public.permission_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  target_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  changed_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  field_name text NOT NULL,
  old_value boolean,
  new_value boolean,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX permission_audit_log_school_idx ON public.permission_audit_log (school_id, changed_at DESC);
CREATE INDEX permission_audit_log_target_idx ON public.permission_audit_log (target_profile_id, changed_at DESC);

ALTER TABLE public.permission_audit_log ENABLE ROW LEVEL SECURITY;

-- Only people who can themselves manage access can view the log. No
-- INSERT/UPDATE/DELETE policy for regular users — only the SECURITY
-- DEFINER trigger function below writes to this table.
CREATE POLICY pal_select ON public.permission_audit_log FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.school_id = permission_audit_log.school_id
      AND (p.is_superadmin OR p.can_manage_access)
  )
);


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
    'can_manage_licensure', 'can_manage_compliance', 'can_manage_field_trips',
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

DROP TRIGGER IF EXISTS trg_log_permission_changes ON public.profiles;
CREATE TRIGGER trg_log_permission_changes
  AFTER UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.log_permission_changes();
