-- On-site trips (or ones that genuinely don't need chaperones) had no way
-- to say so -- the trip drawer always showed Max chaperones/Drivers needed,
-- and the trip list always showed a chaperone count of 0 for them, making
-- them indistinguishable from a trip that does need chaperones but hasn't
-- had any assigned yet. Defaults to true so existing trips keep behaving
-- exactly as they do today; admins opt individual trips out going forward.

ALTER TABLE public.field_trips
  ADD COLUMN chaperones_needed boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.field_trips.chaperones_needed IS
  'When false, this trip does not need chaperones -- the trip drawer hides chaperone-specific fields and the trip list shows N/A instead of a count.';
