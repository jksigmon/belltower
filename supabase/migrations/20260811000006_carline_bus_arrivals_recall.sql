-- Lets a carline operator "unclick" a bus group they tagged by accident.
-- carline_bus_arrivals was append-only (SELECT/INSERT only, no way to
-- mark a call undone) which was correct for its original purpose as a
-- call log, but gives no recourse for a mis-tap that re-announces a bus
-- group's students over the PA. Adds a recalled_at column (mirrors the
-- carline_calls.recalled_at pattern already used for individual student
-- recalls) and an UPDATE policy for can_manage_carline, so a recall sets
-- recalled_at instead of deleting the row -- the original call is still
-- in the log, just marked undone.

ALTER TABLE public.carline_bus_arrivals
  ADD COLUMN IF NOT EXISTS recalled_at timestamp with time zone;

DROP POLICY IF EXISTS carline_bus_arrivals_update ON public.carline_bus_arrivals;
CREATE POLICY carline_bus_arrivals_update ON public.carline_bus_arrivals
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND p.school_id = carline_bus_arrivals.school_id
        AND (p.is_superadmin = true OR p.can_manage_carline = true)
    )
  );
