-- ============================================================
-- Fix: current_user_can_ft_read_compliance() (20260922000001) dropped the
-- join to field_trips when it removed the profiles-RLS recursion, on the
-- reasoning that the outer p.school_id = target_school_id check already
-- covered it. It doesn't -- a profile's home school and the schools of
-- the trips they manage are two different things. A profile managing a
-- trip in School B now gets blanket compliance read access to their own
-- home School A, even if they manage nothing there at all, because the
-- EXISTS no longer checks which school the managed trip belongs to.
--
-- Fix: restore the ft.school_id = target_school_id join that the
-- original raw-EXISTS policy had, keeping the SECURITY DEFINER/STABLE
-- wrapper (that part of the perf fix was correct and stays).
-- ============================================================

CREATE OR REPLACE FUNCTION public.current_user_can_ft_read_compliance(target_school_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.school_id = target_school_id
      AND p.status = 'active'
      AND (
        p.can_manage_field_trips = true
        OR p.is_superadmin = true
        OR EXISTS (
          SELECT 1 FROM public.field_trip_managers m
          JOIN public.field_trips ft ON ft.id = m.field_trip_id
          WHERE m.profile_id = p.id AND ft.school_id = target_school_id
        )
      )
  );
$$;
