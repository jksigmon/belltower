-- ============================================================
-- Fix: staff without can_manage_field_trips can never create their
-- first field trip -- "+ New Trip" fails with 42501 (RLS violation)
-- even though ft_insert's own WITH CHECK passes.
--
-- Root cause: admin.field-trips.js creates a trip with
--   supabase.from('field_trips').insert(payload).select().single()
-- which appends RETURNING. Postgres enforces a table's SELECT
-- policies on the returned row of an INSERT ... RETURNING, not just
-- the INSERT policy. ft_select only allows can_manage_field_trips,
-- is_superadmin, or an existing field_trip_managers row for that
-- trip -- but the app inserts the creator's field_trip_managers row
-- in a *second*, separate statement immediately after this one.
-- So a plain teacher creating their first trip can never satisfy
-- ft_select for the row they're inserting: the INSERT itself is
-- rolled back with "new row violates row-level security policy for
-- table field_trips", surfacing to the user as a bare permission
-- denial. can_manage_field_trips/superadmin users never hit this
-- because ft_select passes unconditionally for them.
--
-- Fix: let ft_select also recognize the trip's own creator
-- (field_trips.created_by_profile_id), closing the chicken-and-egg
-- gap -- mirrors the "insert yourself" escape hatch already added
-- for field_trip_managers in field-trips-rls-final-fix.sql.
--
-- While rebuilding this policy: ft_select was still using a raw
-- inline EXISTS(SELECT ... FROM profiles ...), the same
-- non-SECURITY-DEFINER pattern that caused the guardians/families
-- and students/employees/bus_groups statement-timeout incidents
-- earlier today (20260812000001, 20260812000004). The trips list
-- view loads every visible field_trips row in one query, so it's
-- the same hot-path shape -- replaced with a single SECURITY
-- DEFINER STABLE helper that folds the creator check and the
-- existing ft_is_manager() lookup into one profiles read per row.
-- ============================================================

CREATE OR REPLACE FUNCTION public.current_user_can_view_trip(target_school_id uuid, trip_id uuid, trip_creator uuid)
RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
    AS $$
  select coalesce(
    bool_or(
      is_superadmin OR (
        school_id = target_school_id AND status = 'active' AND (
          can_manage_field_trips = true
          OR id = trip_creator
          OR public.ft_is_manager(trip_id, id)
        )
      )
    ),
    false
  )
  from profiles
  where user_id = auth.uid();
$$;

DROP POLICY IF EXISTS ft_select ON public.field_trips;
CREATE POLICY ft_select ON public.field_trips
  FOR SELECT USING (
    public.current_user_can_view_trip(field_trips.school_id, field_trips.id, field_trips.created_by_profile_id)
  );
