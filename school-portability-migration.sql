-- ======================================================================
-- Multi-school portability migration
-- Addresses: grade levels, carline optional, homeroom optional,
--            PTO type enum -> text, supervisor constraint, MVR setting,
--            school email config.
-- Run once in Supabase SQL editor.
-- ======================================================================

-- ── 1. School configuration columns ──────────────────────────────────
ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS grade_levels           text[]  DEFAULT ARRAY['PK','K','1','2','3','4','5','6','7','8','9','10','11','12'],
  ADD COLUMN IF NOT EXISTS terminal_grade         text    DEFAULT '12',
  ADD COLUMN IF NOT EXISTS uses_homerooms         boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS require_mvr_for_drivers boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS pto_from_email         text,
  ADD COLUMN IF NOT EXISTS pto_reply_to           text;


-- ── 2. Seed pilot school data ─────────────────────────────────────────
-- Defaults for grade_levels/terminal_grade/uses_homerooms/require_mvr
-- are already correct for a K-12 school. Only need to set email config.
-- Targets the first school created (adjust WHERE if you have multiple).
UPDATE public.schools
SET
  pto_from_email = 'Belltower PTO <pto@belltower.school>',
  pto_reply_to   = 'no-reply@belltower.school'
WHERE id = (SELECT id FROM public.schools ORDER BY created_at LIMIT 1);


-- ── 3. Migrate pto_type from ENUM to TEXT ─────────────────────────────
-- Three views reference pto_type and cast to ::public.pto_status.
-- Drop them in dependency order, alter the columns, then recreate.

-- Drop dependent views first
DROP VIEW IF EXISTS public.v_pending_coverage_days;       -- depends on v_pto_coverage_days_approved
DROP VIEW IF EXISTS public.v_pto_coverage_days_approved;
DROP VIEW IF EXISTS public.v_pending_cancellation_days;

-- Alter the three tables that use the ENUM column
ALTER TABLE public.pto_requests
  ALTER COLUMN pto_type TYPE text USING pto_type::text;

ALTER TABLE public.pto_balances
  ALTER COLUMN pto_type TYPE text USING pto_type::text;

ALTER TABLE public.pto_ledger
  ALTER COLUMN pto_type TYPE text USING pto_type::text;

-- Drop the ENUM type (no remaining column dependencies)
DROP TYPE IF EXISTS public.pto_type;

-- Recreate views without the now-gone ::public.pto_status casts
CREATE VIEW public.v_pending_cancellation_days AS
 SELECT pr.id AS pto_request_id,
    pr.school_id,
    pr.employee_id AS out_employee_id,
    e.first_name AS out_first_name,
    e.last_name AS out_last_name,
    pr.pto_type,
    pr.notes,
    pr.status,
    (gs.gs)::date AS coverage_date,
    sa.id AS assignment_id,
    sa.substitute_id,
    sa.employee_id AS covering_employee_id,
    sa.start_time,
    sa.end_time,
    sa.reason,
    sa.status AS assignment_status
   FROM (((public.pto_requests pr
     JOIN public.employees e ON ((e.id = pr.employee_id)))
     CROSS JOIN LATERAL generate_series((pr.start_date)::timestamp with time zone, (pr.end_date)::timestamp with time zone, '1 day'::interval) gs(gs))
     JOIN public.substitute_assignments sa ON (((sa.pto_request_id = pr.id) AND (sa.start_date = (gs.gs)::date) AND (sa.end_date = (gs.gs)::date) AND (sa.status = 'scheduled'::text))))
  WHERE ((pr.needs_sub_coverage = true) AND (pr.status = 'CANCELLED') AND (EXTRACT(dow FROM gs.gs) <> ALL (ARRAY[(0)::numeric, (6)::numeric])) AND ((gs.gs)::date > CURRENT_DATE));

CREATE VIEW public.v_pto_coverage_days_approved AS
 SELECT pr.id AS pto_request_id,
    pr.school_id,
    pr.employee_id AS out_employee_id,
    e.first_name AS out_first_name,
    e.last_name AS out_last_name,
    pr.pto_type,
    pr.notes,
    pr.status,
    (gs.gs)::date AS coverage_date,
        CASE
            WHEN ((pr.start_date = pr.end_date) AND (pr.partial_day = true)) THEN pr.start_time
            ELSE NULL::time without time zone
        END AS start_time,
        CASE
            WHEN ((pr.start_date = pr.end_date) AND (pr.partial_day = true)) THEN pr.end_time
            ELSE NULL::time without time zone
        END AS end_time
   FROM ((public.pto_requests pr
     JOIN public.employees e ON ((e.id = pr.employee_id)))
     CROSS JOIN LATERAL generate_series((pr.start_date)::timestamp with time zone, (pr.end_date)::timestamp with time zone, '1 day'::interval) gs(gs))
  WHERE ((pr.needs_sub_coverage = true) AND (pr.status = 'APPROVED') AND (EXTRACT(dow FROM gs.gs) <> ALL (ARRAY[(0)::numeric, (6)::numeric])));

CREATE VIEW public.v_pending_coverage_days AS
 SELECT v.pto_request_id,
    v.school_id,
    v.out_employee_id,
    v.out_first_name,
    v.out_last_name,
    v.pto_type,
    v.notes,
    v.status,
    v.coverage_date,
    v.start_time,
    v.end_time,
    sa.id AS assignment_id
   FROM (public.v_pto_coverage_days_approved v
     LEFT JOIN public.substitute_assignments sa ON (((sa.pto_request_id = v.pto_request_id) AND (sa.start_date = v.coverage_date) AND (sa.end_date = v.coverage_date) AND (sa.status = 'scheduled'::text))))
  WHERE ((sa.id IS NULL) AND (v.coverage_date >= CURRENT_DATE));


-- ── 4. Fix supervisor constraint: skip when PTO module is disabled ────
CREATE OR REPLACE FUNCTION public.enforce_supervisor_is_pto_approver()
RETURNS trigger LANGUAGE plpgsql AS $$
begin
  -- Allow null supervisor always
  if new.supervisor_id is null then
    return new;
  end if;

  -- Skip enforcement when PTO module is not enabled for this school.
  -- Schools without PTO should still be able to assign supervisors.
  if not exists (
    select 1 from public.school_modules
    where school_id = new.school_id
      and module = 'pto'
      and enabled = true
  ) then
    return new;
  end if;

  -- PTO is enabled: require the supervisor to be a PTO approver
  if not exists (
    select 1 from public.profiles p
    where p.employee_id = new.supervisor_id
      and p.can_approve_pto = true
  ) then
    raise exception 'Supervisor must have PTO approval access';
  end if;

  return new;
end;
$$;
