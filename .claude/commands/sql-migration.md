Generate a complete, ready-to-run Supabase SQL migration for the Belltower project. The user will provide a table name and brief description as arguments (e.g. `/sql-migration incident_reports tracks student discipline incidents`).

Parse the table name and description from the invocation. If not provided, ask for them.

## Step 1 — Check schema.sql

Read `schema.sql` and search for the table name to confirm it doesn't already exist. Also look for any related tables or FKs that might be relevant to this new table.

## Step 2 — Generate the migration

Use this exact RLS policy pattern — never use `is_admin` (that column does not exist on profiles):

```sql
CREATE TABLE public.[table_name] (
  id         uuid DEFAULT gen_random_uuid() NOT NULL,
  school_id  uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- columns based on the description
  CONSTRAINT [table_name]_pkey PRIMARY KEY (id)
);

ALTER TABLE public.[table_name] ENABLE ROW LEVEL SECURITY;

-- All active same-school users can read
CREATE POLICY "[table_name]_select" ON public.[table_name] FOR SELECT
  USING (public.current_user_is_active_in_school([table_name].school_id));

-- Only role='admin' or superadmin can write
CREATE POLICY "[table_name]_all" ON public.[table_name] FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (p.is_superadmin = true OR (p.role = 'admin' AND p.school_id = [table_name].school_id))
  ));
```

**Never write the SELECT policy as a raw `EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid() ...)`.** That pattern isn't `SECURITY DEFINER`, so it re-enters `profiles`' own RLS policies on every row of the outer query — cheap for a single-row admin action, but it took down prod twice in one day (2026-08-12) once tables using it got joined into list queries (Student Directory joining `families`/`students`/`employees`/`bus_groups`). Always use the `current_user_is_active_in_school(school_id)` helper (`SECURITY DEFINER STABLE`, defined in `20260812000001_fix_guardians_families_rls_perf.sql`) for the same-school-read case instead. The write/`FOR ALL` policy can keep the raw `EXISTS` form since admin writes are single-row and not the hot path — but if a new table's write policy also needs to key off a specific permission flag (e.g. `can_manage_x`) and will be read in bulk/joined contexts, add a matching `current_user_can_manage_x(target_school_id)` helper following the same pattern rather than inlining raw `EXISTS`.

If the table doesn't have a direct `school_id` column (e.g. it joins through a parent table), adapt the policy to JOIN to the parent table to reach `school_id` — follow the pattern used in the `placement_assignments` policy in the existing codebase.

## Step 3 — Present the result

Output the full SQL block ready to paste into the Supabase SQL editor. Note any FK dependencies the user needs to be aware of before running it.
