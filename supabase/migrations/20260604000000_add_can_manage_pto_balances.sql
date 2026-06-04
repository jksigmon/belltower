-- Adds can_manage_pto_balances to profiles.
-- can_adjust_pto          = deduction/docking only (principals, APs)
-- can_manage_pto_balances = full add + deduct + allotments + policies + rollover
--                           + full PTO ledger history for any employee
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_pto_balances boolean NOT NULL DEFAULT false;

-- Backfill: anyone who could already adjust PTO balances (the old broad permission)
-- keeps full access. Going forward, can_adjust_pto is deduction-only.
UPDATE public.profiles
  SET can_manage_pto_balances = true
  WHERE can_adjust_pto = true;
