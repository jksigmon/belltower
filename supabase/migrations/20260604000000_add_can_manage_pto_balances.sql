-- Adds can_manage_pto_balances to profiles.
-- can_adjust_pto  = deduction/docking only (principals, APs)
-- can_manage_pto_balances = full add + deduct + allotments + policies + rollover
--                           + can see full PTO ledger history for any employee
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_pto_balances boolean NOT NULL DEFAULT false;
