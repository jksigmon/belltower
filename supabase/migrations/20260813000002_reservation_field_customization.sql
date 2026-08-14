-- ============================================================
-- Reservation booking-field customization
--
-- Lets a resource (or resource group) relabel the reservation "title"
-- field and, optionally, require it to be a bounded number instead of
-- free text -- e.g. a Chromebook cart group asking "Number of
-- Chromebooks Needed" (1-30) instead of a generic meeting title -- and
-- attach a policy blurb that's shown on the booking modal for that
-- resource.
--
-- reservations.title stays a plain text column; a numeric answer is
-- just stored as its string form (e.g. "12"). No schema change needed
-- there.
--
-- Idempotent: safe to re-run.
-- ============================================================

ALTER TABLE public.reservable_resources
  ADD COLUMN IF NOT EXISTS title_label text NOT NULL DEFAULT 'Title',
  ADD COLUMN IF NOT EXISTS title_input_type text NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS title_max_value integer,
  ADD COLUMN IF NOT EXISTS policy_text text;

ALTER TABLE public.reservable_resources
  DROP CONSTRAINT IF EXISTS reservable_resources_title_input_type_check;
ALTER TABLE public.reservable_resources
  ADD CONSTRAINT reservable_resources_title_input_type_check
    CHECK (title_input_type IN ('text', 'number'));

ALTER TABLE public.resource_groups
  ADD COLUMN IF NOT EXISTS title_label text NOT NULL DEFAULT 'Title',
  ADD COLUMN IF NOT EXISTS title_input_type text NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS title_max_value integer,
  ADD COLUMN IF NOT EXISTS policy_text text;

ALTER TABLE public.resource_groups
  DROP CONSTRAINT IF EXISTS resource_groups_title_input_type_check;
ALTER TABLE public.resource_groups
  ADD CONSTRAINT resource_groups_title_input_type_check
    CHECK (title_input_type IN ('text', 'number'));
