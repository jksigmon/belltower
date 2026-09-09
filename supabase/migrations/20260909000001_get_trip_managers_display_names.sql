-- Bug: a teacher who is a trip manager sees only her own name in the
-- Managing Teachers row; every co-manager renders as a blank chip.
--
-- loadManagers() in admin.field-trips.js calls get_trip_managers (SECURITY
-- DEFINER, so the profile ids all come back), then resolves those ids to
-- names with a plain `from('profiles').select('id, display_name, email')`
-- that goes through RLS. profiles only allows SELECT for admins/access
-- managers, request category managers, and "read your own row"
-- (profiles_read_self), so a plain teacher's lookup returns just herself.
-- Every other id falls through to `?? {}` and renders with an empty name.
-- Same class of bug as 20260821000003, which fixed the manager *search*
-- path but not the manager *display* path.
--
-- Fix: return the display fields from the SECURITY DEFINER function itself
-- so the app never needs a direct profiles read. Because the function
-- bypasses RLS and now returns names and emails rather than bare ids, it
-- gets an explicit caller check: the caller must be an active profile in
-- the trip's school (or a superadmin). Anon loses its grant.

DROP FUNCTION IF EXISTS public.get_trip_managers(uuid);

CREATE FUNCTION public.get_trip_managers(trip_id uuid)
RETURNS TABLE(profile_id uuid, display_name text, email text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT m.profile_id, p.display_name, p.email
  FROM public.field_trip_managers m
  LEFT JOIN public.profiles p ON p.id = m.profile_id
  WHERE m.field_trip_id = trip_id
    AND EXISTS (
      SELECT 1 FROM public.profiles v
      WHERE v.user_id = auth.uid()
        AND (
          v.is_superadmin = true
          OR v.school_id = public.ft_get_school_id(trip_id)
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.get_trip_managers(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_trip_managers(uuid) TO service_role;
