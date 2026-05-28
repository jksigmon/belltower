-- students: most common query is school_id + active = true.
-- Existing index is school_id alone, causing a heap scan over inactive students.
-- Composite covers both the common (active=true) and admin (active=false) cases.
CREATE INDEX IF NOT EXISTS idx_students_school_active
  ON public.students (school_id, active);

-- field_trips: no non-PK indexes at all.
-- loadTrips() always filters school_id and orders by start_date desc.
CREATE INDEX IF NOT EXISTS idx_field_trips_school_date
  ON public.field_trips (school_id, start_date DESC);
