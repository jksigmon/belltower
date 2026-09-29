-- One-off data fix: field_trip_vehicle_assignments rows left behind after a
-- chaperone was removed from a trip. removeChaperone() only soft-deleted the
-- field_trip_chaperones row (removed_at) and never cleared that chaperone's
-- vehicle assignments. Since chaperone_id is NOT NULL, those rows couldn't be
-- "unassigned" in place -- they just kept pointing at a chaperone who no
-- longer renders a column on Plan Vehicles. Result: the student isn't shown
-- in any vehicle (driver's column is gone) and isn't shown in Unassigned
-- (their assignment row still exists), so they look deleted.
--
-- The application code fix (admin.field-trips.js) now deletes these rows
-- automatically going forward. Steps 1-2 below were the one-time backfill,
-- already run. Step 3 is a targeted lookup for one student who is still
-- missing after the backfill, to see what's actually going on with her.

-- 1. Inspect affected rows (already run: returned 7 rows)
SELECT
  ft.name                            AS trip_name,
  s.first_name || ' ' || s.last_name AS student_name,
  ftva.id                            AS assignment_id,
  ftva.chaperone_id,
  ftc.removed_at                     AS chaperone_removed_at
FROM field_trip_vehicle_assignments ftva
JOIN field_trip_chaperones ftc ON ftc.id = ftva.chaperone_id
JOIN field_trips ft ON ft.id = ftva.field_trip_id
JOIN students s ON s.id = ftva.student_id
WHERE ftc.removed_at IS NOT NULL
ORDER BY ft.name, student_name;

-- 2. Delete the orphaned rows so these students fall back into Unassigned
--    (already run: 7 rows deleted, confirmed by re-running #1 -> 0 rows)
DELETE FROM field_trip_vehicle_assignments ftva
USING field_trip_chaperones ftc
WHERE ftc.id = ftva.chaperone_id
  AND ftc.removed_at IS NOT NULL;

-- 3. Targeted lookup: find Saoirse Parsons specifically on the Oct 2 2nd
--    grade trip and show everything that determines whether Plan Vehicles
--    will place her in a vehicle, in Unassigned, or nowhere.
SELECT
  s.id                AS student_id,
  s.first_name,
  s.last_name,
  s.grade_level,
  s.active            AS student_active,
  s.school_id         AS student_school_id,
  ft.id               AS trip_id,
  ft.name             AS trip_name,
  ft.start_date,
  ft.grade_levels     AS trip_grade_levels,
  ft.school_id        AS trip_school_id,
  fts.attending        AS attending_override_row,   -- NULL = no override row = defaults to attending
  ftva.id              AS vehicle_assignment_id,      -- should now be NULL
  ftva.chaperone_id    AS vehicle_assignment_chaperone_id
FROM students s
JOIN field_trips ft
  ON ft.school_id = s.school_id
  AND ft.start_date = '2026-10-02'
LEFT JOIN field_trip_students fts
  ON fts.field_trip_id = ft.id AND fts.student_id = s.id
LEFT JOIN field_trip_vehicle_assignments ftva
  ON ftva.field_trip_id = ft.id AND ftva.student_id = s.id
WHERE s.first_name ILIKE 'saoirse'
  AND s.last_name ILIKE 'parsons';
