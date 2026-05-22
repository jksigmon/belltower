-- Replaces the previous get_trip_managers function.
-- Returns only profile_id (no JOIN, no table.id reference) so it can be
-- pasted into the Supabase SQL editor without angle-bracket corruption.
-- The JS fetches display names in a separate profiles query.

CREATE OR REPLACE FUNCTION public.get_trip_managers(trip_id uuid)
RETURNS TABLE(profile_id uuid)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT profile_id FROM public.field_trip_managers WHERE field_trip_id = trip_id;
$$;
