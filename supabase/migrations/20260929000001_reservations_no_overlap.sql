-- ============================================================
-- Reservations: make "no double-booking" a database rule.
--
-- Until now the only thing stopping two bookings of the same resource at the
-- same time was a client-side check in the New Reservation modal: read what is
-- already booked, then insert. There is a gap between that read and the
-- insert, so two people booking the same slot at the same moment (or one
-- person double-clicking Reserve) could both be told the slot was free and
-- both succeed. Postgres knew nothing about the rule and accepted both rows.
-- Recurring bookings widen the exposure, since one submission now checks a
-- whole range of dates at once.
--
-- A partial exclusion constraint moves the rule into the database, where that
-- gap does not exist. The client-side check stays, but it becomes a friendly
-- early warning rather than the only protection.
--
-- Scope notes:
--   * Only 'confirmed' and 'pending' rows participate. Cancelling sets status
--     rather than deleting the row, so a cancelled or denied booking drops out
--     of the constraint and frees its slot automatically.
--   * tstzrange defaults to '[)' bounds, so back-to-back bookings (one ends at
--     10:30, the next starts at 10:30) do NOT conflict. That matches the
--     strict < / > comparison the booking modal already uses.
--   * resource_id alone is the equality key. enforce_reservation_insert_status
--     already rejects a reservation whose resource belongs to another school,
--     so adding school_id here would be redundant.
--
-- Checked against both projects on 2026-09-29: zero overlapping active
-- reservations in either, so this applies cleanly. If a new overlap appears
-- before this runs, the ALTER fails loudly and changes nothing -- find the
-- offending pair with the query at the bottom of this file, cancel one of
-- them, then re-run.
--
-- Idempotent: safe to re-run (guards on both the extension and the
-- constraint).
-- ============================================================

-- A gist index cannot mix a plain equality column (resource_id) with a range
-- overlap operator without btree_gist. Created in the extensions schema to
-- match where this project keeps pgcrypto and uuid-ossp.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- The gist operator classes btree_gist provides have to be resolvable while
-- the constraint is being defined.
SET search_path = public, extensions;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reservations_no_overlap'
      AND conrelid = 'public.reservations'::regclass
  ) THEN
    ALTER TABLE public.reservations
      ADD CONSTRAINT reservations_no_overlap
      EXCLUDE USING gist (
        resource_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
      )
      WHERE (status IN ('confirmed', 'pending'));
  END IF;
END
$$;

RESET search_path;

-- If the ALTER above fails with "conflicting key value violates exclusion
-- constraint", this lists the pairs standing in the way:
--
--   SELECT a.id, a.title, a.starts_at, a.ends_at, a.reserved_by_name,
--          b.id, b.title, b.starts_at, b.ends_at, b.reserved_by_name
--   FROM public.reservations a
--   JOIN public.reservations b
--     ON  a.resource_id = b.resource_id
--     AND a.id < b.id
--     AND a.starts_at < b.ends_at
--     AND b.starts_at < a.ends_at
--   WHERE a.status IN ('confirmed', 'pending')
--     AND b.status IN ('confirmed', 'pending');
