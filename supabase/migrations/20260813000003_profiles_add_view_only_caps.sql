-- View-only access to the Students and Families admin tabs, distinct from
-- can_manage_students / can_manage_families (full read-write). Lets an
-- admin grant a staff member visibility into these tabs without also
-- handing out edit/delete rights.
--
-- No RLS changes needed: students_read_same_school / families_read_same_school
-- already allow any active same-school profile to SELECT these tables, and
-- the existing write policies (gated on can_manage_students/can_manage_families,
-- role = 'admin', or is_superadmin) are untouched, so a view-only profile's
-- writes are already rejected server-side regardless of what the UI shows.

ALTER TABLE public.profiles
  ADD COLUMN can_view_students boolean NOT NULL DEFAULT false,
  ADD COLUMN can_view_families boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.can_view_students IS
  'View-only access to the Students tab. Superseded by can_manage_students (full read-write) when that is also true.';
COMMENT ON COLUMN public.profiles.can_view_families IS
  'View-only access to the Families tab. Superseded by can_manage_families (full read-write) when that is also true.';
