-- ============================================================
-- Perf-only (both already correctly scoped by school_id -- no
-- security issue here, unlike the _admin policies fixed in
-- 20260819000002/3). Same bare auth.uid() re-evaluated-per-row bug.
--
-- carline_calls_read_same_school is the single hottest query in the
-- whole system -- it's what every board, input screen, and kiosk poll
-- actually runs. Fixing it here proactively rather than waiting for
-- the advisor to surface it in a later screenshot.
-- ============================================================

DROP POLICY IF EXISTS carline_calls_read_same_school ON public.carline_calls;
CREATE POLICY carline_calls_read_same_school ON public.carline_calls FOR SELECT USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND (p.is_superadmin = true OR p.school_id = carline_calls.school_id)
  )
);

DROP POLICY IF EXISTS carline_events_read_same_school ON public.carline_events;
CREATE POLICY carline_events_read_same_school ON public.carline_events FOR SELECT USING (
  EXISTS ( SELECT 1 FROM public.profiles p
    WHERE p.user_id = (select auth.uid())
      AND p.status = 'active'
      AND (p.is_superadmin = true OR p.school_id = carline_events.school_id)
  )
);
