-- Scopes the "completed" status (added in 20260820000002) to only the
-- request categories that opt in, same pattern as allow_denial: forms
-- like Purchase Requests can track ordered/paid-vs-not after approval,
-- while categories that don't need that extra step are unaffected.

ALTER TABLE public.request_categories
  ADD COLUMN allow_completed boolean NOT NULL DEFAULT false;
