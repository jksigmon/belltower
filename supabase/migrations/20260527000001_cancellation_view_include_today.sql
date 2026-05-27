-- Include today's coverage dates so day-of rescissions appear in the Cancellations screen.
-- Previously > CURRENT_DATE excluded same-day assignments; sub manager needs to see those too.
CREATE OR REPLACE VIEW public.v_pending_cancellation_days AS
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
  WHERE ((pr.needs_sub_coverage = true)
    AND (pr.status IN ('CANCELLED'::public.pto_status, 'RESCINDED'::public.pto_status))
    AND (EXTRACT(dow FROM gs.gs) <> ALL (ARRAY[(0)::numeric, (6)::numeric]))
    AND ((gs.gs)::date >= CURRENT_DATE));
