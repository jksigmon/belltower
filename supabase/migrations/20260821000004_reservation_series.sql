-- ============================================================
-- Reservation series (multi-day / multi-block time-block bookings)
--
-- Time-block resources (e.g. Chromebook carts) book a single preset
-- period on a single date via reservations.starts_at/ends_at, which
-- has no room to express "Blocks 1-3, every day this week." To support
-- that, a multi-day and/or multi-block booking is inserted as one
-- reservations row per date x block, all sharing a series_id, so the
-- UI can offer "cancel just this one" vs. "cancel the whole series."
-- Bookings made the old way (free-form datetime, or a single date +
-- single block) leave series_id null and are unaffected.
--
-- Idempotent: safe to re-run (guards on columns and indexes).
-- ============================================================

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS series_id uuid;

CREATE INDEX IF NOT EXISTS idx_reservations_series ON public.reservations (series_id) WHERE series_id IS NOT NULL;
