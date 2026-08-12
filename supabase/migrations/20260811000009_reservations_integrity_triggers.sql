-- ============================================================
-- Reservations: close RLS gaps found in an audit of the module.
--
-- reservations_insert/reservations_update only check who is making the
-- request, not what they're allowed to change. In particular:
--   1. A caller could INSERT a reservation as status='confirmed' on a
--      resource marked requires_approval, skipping approval entirely.
--   2. An owner could UPDATE their own row to change status, resource_id,
--      starts_at/ends_at, or the decided_by/decided_at approval fields --
--      the UI only ever exposes "Cancel", but RLS alone doesn't enforce
--      that restriction against a direct API call.
--   3. Nothing checked that resource_id belonged to the same school as
--      the reservation, or that the resource was still active.
--
-- These triggers enforce the same rules the UI already assumes.
-- Idempotent: safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_reservation_insert_status()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
declare
  v_privileged          boolean;
  v_requires_approval   boolean;
  v_active              boolean;
  v_resource_school_id  uuid;
begin
  select (p.is_superadmin = true or p.role = 'admin' or p.can_manage_reservations = true)
    into v_privileged
  from profiles p
  where p.user_id = auth.uid();

  select requires_approval, active, school_id
    into v_requires_approval, v_active, v_resource_school_id
  from reservable_resources
  where id = new.resource_id;

  if v_resource_school_id is null or v_resource_school_id <> new.school_id then
    raise exception 'Resource does not belong to this school.';
  end if;

  if not coalesce(v_active, false) then
    raise exception 'This resource is not currently accepting bookings.';
  end if;

  if coalesce(v_privileged, false) then
    return new;
  end if;

  if new.status not in ('pending', 'confirmed') then
    raise exception 'Invalid initial reservation status.';
  end if;

  if coalesce(v_requires_approval, false) and new.status <> 'pending' then
    raise exception 'This resource requires approval -- the reservation must start as pending.';
  end if;

  if new.decided_by is not null or new.decided_at is not null then
    raise exception 'Only an admin can set the decision fields.';
  end if;

  return new;
end;
$$;

DROP TRIGGER IF EXISTS trg_enforce_reservation_insert_status ON public.reservations;
CREATE TRIGGER trg_enforce_reservation_insert_status
  BEFORE INSERT ON public.reservations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_reservation_insert_status();

CREATE OR REPLACE FUNCTION public.enforce_reservation_owner_update()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
declare
  v_privileged boolean;
begin
  select (p.is_superadmin = true or p.role = 'admin' or p.can_manage_reservations = true)
    into v_privileged
  from profiles p
  where p.user_id = auth.uid();

  if coalesce(v_privileged, false) then
    return new;
  end if;

  -- Non-privileged callers only reach here because reservations_update's
  -- USING clause already confirmed they own this row. The UI only ever
  -- lets an owner cancel their own booking, so that's all this allows --
  -- everything else (self-approving a pending request, changing the
  -- resource/time after the client-side overlap check already ran,
  -- forging decided_by/decided_at) is rejected.
  if new.status <> 'cancelled'
     or new.resource_id            is distinct from old.resource_id
     or new.starts_at              is distinct from old.starts_at
     or new.ends_at                is distinct from old.ends_at
     or new.school_id              is distinct from old.school_id
     or new.reserved_by_profile_id is distinct from old.reserved_by_profile_id
     or new.decided_by             is distinct from old.decided_by
     or new.decided_at             is distinct from old.decided_at
  then
    raise exception 'You can only cancel your own reservation.';
  end if;

  return new;
end;
$$;

DROP TRIGGER IF EXISTS trg_enforce_reservation_owner_update ON public.reservations;
CREATE TRIGGER trg_enforce_reservation_owner_update
  BEFORE UPDATE ON public.reservations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_reservation_owner_update();
