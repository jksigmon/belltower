-- ======================================================================
-- Field Trips Patch: rename trip_date -> start_date, add end_date
-- Run once in Supabase SQL editor if you already ran the original
-- field-trips-migration.sql (which used trip_date).
-- ======================================================================

ALTER TABLE public.field_trips
  RENAME COLUMN trip_date TO start_date;

ALTER TABLE public.field_trips
  ADD COLUMN IF NOT EXISTS end_date date;
