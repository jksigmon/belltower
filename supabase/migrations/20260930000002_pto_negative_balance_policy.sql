-- Per-school control over what happens when a leave request would push an
-- employee's balance negative. Approval already allows it today (there's an
-- existing "negative balances" payroll-deduction report), so this isn't a
-- new hard constraint -- it's a configurable warning/block surfaced to the
-- employee at submission and to the approver at approval time. The actual
-- enforcement lives in app code (staff.html submission, pto.js approval);
-- this column is just the per-school switch.
ALTER TABLE public.school_settings
  ADD COLUMN IF NOT EXISTS negative_balance_policy text NOT NULL DEFAULT 'warn'
    CHECK (negative_balance_policy IN ('allow', 'warn', 'block'));
