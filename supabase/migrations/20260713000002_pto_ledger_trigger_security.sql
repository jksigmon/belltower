-- ============================================================
-- Fix: non-admin approvers cannot approve balance-counting leave
--
-- handle_pto_status_change() runs with INVOKER rights, so its
-- INSERT INTO pto_ledger is subject to the caller's RLS. The
-- pto_ledger INSERT policies only allow role IN ('admin','hr'),
-- so a front-office user with can_approve_pto = true fails the
-- ledger write and the whole approval UPDATE errors out.
--
-- The ledger write is system bookkeeping, not a user action:
-- make the trigger SECURITY DEFINER (runs as function owner,
-- who owns the tables and therefore bypasses RLS), with a
-- pinned search_path per SECURITY DEFINER best practice.
-- Who may flip request status remains governed by the RLS
-- UPDATE policies on pto_requests — unchanged.
-- ============================================================

ALTER FUNCTION public.handle_pto_status_change() SECURITY DEFINER;
ALTER FUNCTION public.handle_pto_status_change() SET search_path = public;
