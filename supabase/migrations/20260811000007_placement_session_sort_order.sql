-- Add manual drag-to-reorder support for the Class Placement session list.

ALTER TABLE public.placement_sessions
  ADD COLUMN sort_order integer;

-- Backfill so existing boards keep their current visual order (created_at
-- DESC, the query's prior default) instead of jumping around once the UI
-- switches to ordering by sort_order.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY school_id ORDER BY created_at DESC
  ) - 1 AS rn
  FROM public.placement_sessions
)
UPDATE public.placement_sessions ps
SET sort_order = ranked.rn
FROM ranked
WHERE ps.id = ranked.id;

ALTER TABLE public.placement_sessions
  ALTER COLUMN sort_order SET NOT NULL,
  ALTER COLUMN sort_order SET DEFAULT 0;
