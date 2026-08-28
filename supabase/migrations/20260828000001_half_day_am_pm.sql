-- Half Day AM/PM period, so the substitute coordinator can tell which half of
-- the day a sub is needed for, and so the pending-subs list can tell a true
-- Half Day request apart from a manually time-boxed Partial Day request.
--
-- Previously both v_pto_coverage_days_approved and v_pending_coverage_days only
-- exposed start_time/end_time when partial_day = true, and app/substitutes.html's
-- covDurationBadge() labeled anything with a start_time/end_time "Half day" and
-- everything else "Full day" -- so a real Half Day request (partial_day = false,
-- no start_time/end_time) showed up on the subs list as "Full day", and a custom
-- Partial Day request of any length (even 1 hour) showed up as "Half day".
--
-- New columns (partial_day, half_day_period) are appended at the END of each
-- view's column list on purpose -- CREATE OR REPLACE VIEW requires existing
-- columns to keep the same name/position/type; it only allows adding columns
-- after the existing ones, not inserting them in the middle.

ALTER TABLE public.pto_requests
  ADD COLUMN half_day_period text
  CHECK (half_day_period IN ('AM', 'PM'));

CREATE OR REPLACE VIEW public.v_pto_coverage_days_approved AS
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
            WHEN ((pr.start_date = pr.end_date) AND (pr.partial_day = true OR pr.half_day_period IS NOT NULL)) THEN pr.start_time
            ELSE NULL::time without time zone
        END AS start_time,
        CASE
            WHEN ((pr.start_date = pr.end_date) AND (pr.partial_day = true OR pr.half_day_period IS NOT NULL)) THEN pr.end_time
            ELSE NULL::time without time zone
        END AS end_time,
    pr.partial_day,
    pr.half_day_period
   FROM ((public.pto_requests pr
     JOIN public.employees e ON ((e.id = pr.employee_id)))
     CROSS JOIN LATERAL generate_series((pr.start_date)::timestamp with time zone, (pr.end_date)::timestamp with time zone, '1 day'::interval) gs(gs))
  WHERE ((pr.needs_sub_coverage = true) AND (pr.status = 'APPROVED'::public.pto_status) AND (EXTRACT(dow FROM gs.gs) <> ALL (ARRAY[(0)::numeric, (6)::numeric])));

CREATE OR REPLACE VIEW public.v_pending_coverage_days AS
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
    sa.id AS assignment_id,
    v.partial_day,
    v.half_day_period
   FROM (public.v_pto_coverage_days_approved v
     LEFT JOIN public.substitute_assignments sa ON (((sa.pto_request_id = v.pto_request_id) AND (sa.start_date = v.coverage_date) AND (sa.end_date = v.coverage_date) AND (sa.status = 'scheduled'::text))))
  WHERE ((sa.id IS NULL) AND (v.coverage_date >= CURRENT_DATE));
