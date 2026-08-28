-- 20260828000001_half_day_am_pm.sql fixed covDurationBadge()/covTimeLabel() for
-- Half Day requests going forward, but Half Day requests submitted before that
-- migration have half_day_period = NULL and partial_day = false (the old form
-- never asked for AM/PM or recorded start_time/end_time for Half Day), so they
-- still fall through to "Full day" on the pending subs list.
--
-- requested_duration_label was already set to 'Half Day' at submission time for
-- these rows (see app/staff.html's durationLabel logic) -- surface it through the
-- coverage views so the subs list can fall back to it when half_day_period and
-- partial_day both say "not half day, not partial day, must be full day" but the
-- label says otherwise.
--
-- New column appended at the END of each view's column list, per CREATE OR REPLACE
-- VIEW rules (see 20260828000001_half_day_am_pm.sql for the same note).

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
    pr.half_day_period,
    pr.requested_duration_label
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
    v.half_day_period,
    v.requested_duration_label
   FROM (public.v_pto_coverage_days_approved v
     LEFT JOIN public.substitute_assignments sa ON (((sa.pto_request_id = v.pto_request_id) AND (sa.start_date = v.coverage_date) AND (sa.end_date = v.coverage_date) AND (sa.status = 'scheduled'::text))))
  WHERE ((sa.id IS NULL) AND (v.coverage_date >= CURRENT_DATE));
