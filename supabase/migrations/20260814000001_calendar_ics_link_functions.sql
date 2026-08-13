-- Lets admins get (and regenerate) the ICS subscription link for their
-- school's approved-leave calendar, for pasting into Google Calendar's
-- "From URL" subscribe feature. Backed by the existing pto_calendar_ics
-- edge function, which authenticates via schools.calendar_ics_token in the
-- URL itself (no session/JWT needed for the feed fetch).
--
-- schools has a blanket SELECT RLS policy ("Authenticated users can read
-- schools" USING (true)), so a raw client-side select of calendar_ics_token
-- would risk exposing one school's token to any authenticated user at any
-- school. These SECURITY DEFINER functions avoid that entirely: they never
-- go through a client select of the column, they self-scope to the caller's
-- own profiles.school_id via auth.uid(), and they check permissions
-- server-side before returning or rotating anything.
--
-- Copy is available to admin-tier staff (is_superadmin or can_manage_access).
-- Regenerate is restricted further to is_superadmin or role = 'admin',
-- since rotating the token breaks the feed for everyone already subscribed.

CREATE OR REPLACE FUNCTION public.get_calendar_ics_link()
RETURNS TABLE(school_id uuid, calendar_ics_token uuid)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
SET row_security = off
AS $$
  SELECT s.id, s.calendar_ics_token
  FROM public.schools s
  JOIN public.profiles p ON p.school_id = s.id
  WHERE p.user_id = auth.uid()
    AND p.status = 'active'
    AND (p.is_superadmin = true OR p.can_manage_access = true);
$$;

CREATE OR REPLACE FUNCTION public.regenerate_calendar_ics_token()
RETURNS TABLE(school_id uuid, calendar_ics_token uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  caller_school_id uuid;
BEGIN
  SELECT p.school_id INTO caller_school_id
  FROM public.profiles p
  WHERE p.user_id = auth.uid()
    AND p.status = 'active'
    AND (p.is_superadmin = true OR p.role = 'admin');

  IF caller_school_id IS NULL THEN
    RAISE EXCEPTION 'Not authorized to regenerate the calendar link.';
  END IF;

  RETURN QUERY
  UPDATE public.schools
  SET calendar_ics_token = gen_random_uuid()
  WHERE id = caller_school_id
  RETURNING schools.id, schools.calendar_ics_token;
END;
$$;

REVOKE ALL ON FUNCTION public.get_calendar_ics_link() FROM public;
REVOKE ALL ON FUNCTION public.regenerate_calendar_ics_token() FROM public;
GRANT EXECUTE ON FUNCTION public.get_calendar_ics_link() TO authenticated;
GRANT EXECUTE ON FUNCTION public.regenerate_calendar_ics_token() TO authenticated;
