-- Let a leave balance manager change the leave type of an already-approved
-- request (e.g. Personal -> Professional).
--
-- Approval debits the ledger against the request's pto_type, and
-- handle_pto_status_change only fires on status changes, so a bare UPDATE of
-- pto_type would leave the old balance charged and the new one untouched.
-- This function does the whole move in one transaction instead:
--   1. credit back whatever the request currently has charged to the old type
--   2. debit the new type (if it counts against balance)
--   3. update pto_requests.pto_type
-- Ledger rows are append-only, so the change stays auditable.
--
-- Allowed on past leave. No notification is sent (status does not change, so
-- notify_pto_event does not fire).

CREATE OR REPLACE FUNCTION public.change_pto_request_type(
  p_request_id uuid,
  p_new_type   text,
  p_reason     text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $$
DECLARE
  v_req       public.pto_requests%ROWTYPE;
  v_actor     uuid;
  v_old_type  text;
  v_old_net   numeric;
  v_new_count boolean;
  v_reason    text;
BEGIN
  SELECT * INTO v_req
  FROM public.pto_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Leave request not found';
  END IF;

  SELECT p.employee_id INTO v_actor
  FROM public.profiles p
  WHERE p.user_id = auth.uid()
    AND p.status = 'active'
    AND p.school_id = v_req.school_id
    AND (p.can_manage_pto_balances = true OR p.is_superadmin = true);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to change leave types';
  END IF;

  IF v_req.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Only approved leave can have its type changed';
  END IF;

  v_old_type := v_req.pto_type;

  IF p_new_type IS NULL OR p_new_type = v_old_type THEN
    RAISE EXCEPTION 'Choose a different leave type';
  END IF;

  SELECT t.counts_against_balance INTO v_new_count
  FROM public.school_pto_types t
  WHERE t.school_id = v_req.school_id
    AND t.pto_type = p_new_type
    AND t.enabled = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That leave type is not enabled for this school';
  END IF;

  v_reason := format('REQUEST TYPE CHANGED (%s to %s)', v_old_type, p_new_type)
              || CASE WHEN nullif(btrim(p_reason), '') IS NOT NULL
                      THEN ': ' || btrim(p_reason) ELSE '' END;

  -- Net amount currently charged to the old type for this request. Using the
  -- ledger (not the type's counts_against_balance flag) keeps this correct for
  -- requests approved before a type's setting changed, and after earlier
  -- type changes.
  SELECT COALESCE(SUM(l.delta_hours), 0) INTO v_old_net
  FROM public.pto_ledger l
  WHERE l.related_request_id = v_req.id
    AND l.pto_type = v_old_type;

  IF v_old_net < 0 THEN
    INSERT INTO public.pto_ledger
      (school_id, employee_id, pto_type, delta_hours, reason, related_request_id, created_by)
    VALUES
      (v_req.school_id, v_req.employee_id, v_old_type, -v_old_net, v_reason, v_req.id, v_actor);
  END IF;

  IF v_new_count THEN
    INSERT INTO public.pto_ledger
      (school_id, employee_id, pto_type, delta_hours, reason, related_request_id, created_by)
    VALUES
      (v_req.school_id, v_req.employee_id, p_new_type, -v_req.requested_hours, v_reason, v_req.id, v_actor);
  END IF;

  PERFORM set_config('belltower.allow_pto_type_change', 'on', true);

  UPDATE public.pto_requests
  SET pto_type = p_new_type
  WHERE id = v_req.id;
END;
$$;

REVOKE ALL ON FUNCTION public.change_pto_request_type(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_pto_request_type(uuid, text, text) TO authenticated, service_role;

-- Block direct pto_type edits on decided requests. The update policies let any
-- approver change any column, which would desync the ledger. The function above
-- sets a transaction-local flag to pass through.
CREATE OR REPLACE FUNCTION public.guard_pto_type_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.pto_type IS DISTINCT FROM OLD.pto_type
     AND OLD.status <> 'PENDING'
     AND current_setting('belltower.allow_pto_type_change', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Leave type on a decided request can only be changed through change_pto_request_type()';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_pto_type_change ON public.pto_requests;
CREATE TRIGGER trg_guard_pto_type_change
  BEFORE UPDATE OF pto_type ON public.pto_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_pto_type_change();
