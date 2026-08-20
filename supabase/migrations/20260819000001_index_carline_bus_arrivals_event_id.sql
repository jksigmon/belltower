-- carline_bus_arrivals had no index beyond its primary key. loadBusArrivals()
-- in both carline.html and carline-input.html filters this table by
-- carline_event_id (plus recalled_at IS NULL, ordered by called_at) on every
-- 8s poll cycle, for every board and input screen -- the same poll cadence as
-- carline_calls, which just took the database down on 8/19 because its
-- equivalent query wasn't properly indexed for the filter it actually runs.
-- Bus-arrival volume is lower than call volume so this hasn't failed yet, but
-- it accumulates a new batch of rows every dismissal day the same way calls
-- do, and was headed for the identical failure mode.
CREATE INDEX IF NOT EXISTS carline_bus_arrivals_event_recalled_called_idx
    ON public.carline_bus_arrivals (carline_event_id, recalled_at, called_at);
