-- Creates a SECURITY DEFINER RPC that reads field_trip_managers + profiles
-- without going through RLS. Called from the app as supabase.rpc('get_trip_managers').
-- This is the same pattern used by ft_get_school_id / ft_is_manager.

CREATE OR REPLACE FUNCTION public.get_trip_managers(trip_id uuid)
RETURNS TABLE(profile_id uuid, display_name text, email text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    ftm.profile_id,
    p.display_name,
    p.email
  FROM public.field_trip_managers ftm
  JOIN public.profiles p ON p.id = ftm.profile_id
  WHERE ftm.field_trip_id = trip_id;
$$;
