-- Field trips: custom student rosters.
--
-- 'grades' (default, existing behavior): roster is every active student in
--   field_trips.grade_levels, minus field_trip_students rows with
--   attending = false.
-- 'custom': roster is exactly the students that have a field_trip_students
--   row; attending still toggles whether they are actually going.
--   field_trips.grade_levels is kept in sync with the members' grades so
--   conflict checks and grade pills keep working, but it no longer decides
--   who is on the roster.
--
-- No new table, so no new grants. Existing RLS (fts_all) already covers
-- field_trip_students for admins and trip managers.

ALTER TABLE public.field_trips
  ADD COLUMN IF NOT EXISTS roster_mode text NOT NULL DEFAULT 'grades';

ALTER TABLE public.field_trips
  DROP CONSTRAINT IF EXISTS field_trips_roster_mode_check;

ALTER TABLE public.field_trips
  ADD CONSTRAINT field_trips_roster_mode_check
  CHECK (roster_mode IN ('grades', 'custom'));
