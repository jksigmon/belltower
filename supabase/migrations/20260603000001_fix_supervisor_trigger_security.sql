-- The enforce_supervisor_is_pto_approver trigger function runs as the calling
-- user by default (SECURITY INVOKER). Non-admin users can only read their own
-- row in profiles (RLS), so the EXISTS check always returns false for other
-- employees, causing the spurious "supervisor must have PTO approval access"
-- error even when the supervisor is valid.
-- Fix: run as SECURITY DEFINER so the trigger bypasses RLS when checking profiles.

CREATE OR REPLACE FUNCTION public.enforce_supervisor_is_pto_approver()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
begin
  if new.supervisor_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from profiles p
    where p.employee_id = new.supervisor_id
      and p.can_approve_pto = true
  ) then
    raise exception 'Supervisor must have PTO approval access';
  end if;

  return new;
end;
$$;
