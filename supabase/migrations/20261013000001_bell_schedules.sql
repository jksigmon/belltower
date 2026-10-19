-- ============================================================
-- Bell Schedules (module key: bells)
--
-- A school can run several bell schedules at once (e.g. "Middle
-- School 6-8" and "High School 9-12"). Each schedule owns a set of
-- DAY TYPES (Regular, Early Release, 2-Hour Delay, ...), each day
-- type owns its PERIODS, and a weekday map says which day type runs
-- on which day of the week. A dated override swaps the day type (or
-- silences bells) for one schedule on one date.
--
-- Bell pages never read these tables at ring time. They fetch a
-- resolved timeline (absolute instants, computed here in the school's
-- timezone) through the bell_board edge function, then ring locally.
-- That keeps bell traffic to one small cached read per minute per
-- schedule regardless of how many screens are open, and none of it
-- touches the carline tables or Realtime.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- New permission (must exist before the helper below references it)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_bells boolean NOT NULL DEFAULT false;

-- ── Tables ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.bell_schedules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  campus_id    uuid REFERENCES public.campuses(id) ON DELETE SET NULL,
  name         text NOT NULL,
  grade_label  text,
  is_active    boolean NOT NULL DEFAULT true,
  -- Opaque handle a bell page polls with, so the per-minute change
  -- check needs no auth round-trip. Bell times are not sensitive, and
  -- the token can be rotated to cut off a screen.
  feed_token   uuid NOT NULL DEFAULT gen_random_uuid(),
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bell_schedules_school ON public.bell_schedules (school_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bell_schedules_feed_token ON public.bell_schedules (feed_token);

CREATE TABLE IF NOT EXISTS public.bell_day_types (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id  uuid NOT NULL REFERENCES public.bell_schedules(id) ON DELETE CASCADE,
  name         text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Target for the composite FKs below, which stop a weekday or an
  -- override on one schedule from pointing at another schedule's day type.
  UNIQUE (id, schedule_id)
);

CREATE INDEX IF NOT EXISTS idx_bell_day_types_schedule ON public.bell_day_types (schedule_id, sort_order);

CREATE TABLE IF NOT EXISTS public.bell_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_type_id  uuid NOT NULL REFERENCES public.bell_day_types(id) ON DELETE CASCADE,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'class'
                 CHECK (kind IN ('class', 'homeroom', 'lunch', 'break', 'other')),
  -- Wall-clock times in the school's timezone (schools.timezone).
  start_time   time NOT NULL,
  end_time     time NOT NULL,
  ring_start   boolean NOT NULL DEFAULT true,
  ring_end     boolean NOT NULL DEFAULT true,
  CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_bell_periods_day_type ON public.bell_periods (day_type_id, start_time);

-- Which day type runs on which weekday. dow follows Postgres
-- extract(dow): 0 = Sunday ... 6 = Saturday. No row = no bells that day.
CREATE TABLE IF NOT EXISTS public.bell_schedule_weekdays (
  schedule_id  uuid NOT NULL REFERENCES public.bell_schedules(id) ON DELETE CASCADE,
  dow          smallint NOT NULL CHECK (dow BETWEEN 0 AND 6),
  day_type_id  uuid NOT NULL,
  PRIMARY KEY (schedule_id, dow),
  FOREIGN KEY (day_type_id, schedule_id)
    REFERENCES public.bell_day_types (id, schedule_id) ON DELETE CASCADE
);

-- One-date exception for one schedule. day_type_id NULL = no bells.
-- An override wins over both the weekday map and the school calendar,
-- so a Saturday make-up day or a school day that falls inside a
-- calendar "break" entry can still ring.
CREATE TABLE IF NOT EXISTS public.bell_overrides (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id    uuid NOT NULL REFERENCES public.bell_schedules(id) ON DELETE CASCADE,
  override_date  date NOT NULL,
  day_type_id    uuid,
  note           text,
  created_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, override_date),
  FOREIGN KEY (day_type_id, schedule_id)
    REFERENCES public.bell_day_types (id, schedule_id) ON DELETE CASCADE
);

-- ── Grants ───────────────────────────────────────────────────
-- Supabase no longer auto-grants Data API access to new tables.
-- No anon grant: anonymous screens go through the bell_board edge
-- function (service role), never PostgREST.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.bell_schedules,
  public.bell_day_types,
  public.bell_periods,
  public.bell_schedule_weekdays,
  public.bell_overrides
TO authenticated, service_role;

-- ── RLS helpers ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.current_user_can_view_bells(target_school_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $$
  select coalesce(
    bool_or(status = 'active' AND (is_superadmin = true OR school_id = target_school_id)),
    false
  )
  from profiles
  where user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.current_user_can_manage_bells(target_school_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $$
  select coalesce(
    bool_or(
      status = 'active'
      AND (
        is_superadmin = true
        OR (school_id = target_school_id AND (role = 'admin' OR can_manage_bells = true))
      )
    ),
    false
  )
  from profiles
  where user_id = auth.uid();
$$;

-- Children are scoped through their schedule's school.
CREATE OR REPLACE FUNCTION public.bell_schedule_school_id(p_schedule_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $$
  select school_id from bell_schedules where id = p_schedule_id;
$$;

CREATE OR REPLACE FUNCTION public.bell_day_type_school_id(p_day_type_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $$
  select s.school_id
  from bell_day_types dt
  join bell_schedules s on s.id = dt.schedule_id
  where dt.id = p_day_type_id;
$$;

REVOKE ALL ON FUNCTION public.current_user_can_view_bells(uuid)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_user_can_manage_bells(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bell_schedule_school_id(uuid)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bell_day_type_school_id(uuid)       FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_can_view_bells(uuid)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_user_can_manage_bells(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bell_schedule_school_id(uuid)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bell_day_type_school_id(uuid)       TO authenticated, service_role;

-- ── RLS ──────────────────────────────────────────────────────
-- Read: any active staff member of the school (teachers launch the
-- bell page from the Staff Portal). Write: admins and can_manage_bells.

ALTER TABLE public.bell_schedules         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bell_day_types         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bell_periods           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bell_schedule_weekdays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bell_overrides         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bell_schedules_read ON public.bell_schedules;
CREATE POLICY bell_schedules_read ON public.bell_schedules
  FOR SELECT TO authenticated
  USING ((SELECT public.current_user_can_view_bells(school_id)));

DROP POLICY IF EXISTS bell_schedules_insert ON public.bell_schedules;
CREATE POLICY bell_schedules_insert ON public.bell_schedules
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.current_user_can_manage_bells(school_id)));

DROP POLICY IF EXISTS bell_schedules_update ON public.bell_schedules;
CREATE POLICY bell_schedules_update ON public.bell_schedules
  FOR UPDATE TO authenticated
  USING ((SELECT public.current_user_can_manage_bells(school_id)))
  WITH CHECK ((SELECT public.current_user_can_manage_bells(school_id)));

DROP POLICY IF EXISTS bell_schedules_delete ON public.bell_schedules;
CREATE POLICY bell_schedules_delete ON public.bell_schedules
  FOR DELETE TO authenticated
  USING ((SELECT public.current_user_can_manage_bells(school_id)));

DROP POLICY IF EXISTS bell_day_types_read ON public.bell_day_types;
CREATE POLICY bell_day_types_read ON public.bell_day_types
  FOR SELECT TO authenticated
  USING (public.current_user_can_view_bells(public.bell_schedule_school_id(schedule_id)));

DROP POLICY IF EXISTS bell_day_types_insert ON public.bell_day_types;
CREATE POLICY bell_day_types_insert ON public.bell_day_types
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_can_manage_bells(public.bell_schedule_school_id(schedule_id)));

DROP POLICY IF EXISTS bell_day_types_update ON public.bell_day_types;
CREATE POLICY bell_day_types_update ON public.bell_day_types
  FOR UPDATE TO authenticated
  USING (public.current_user_can_manage_bells(public.bell_schedule_school_id(schedule_id)))
  WITH CHECK (public.current_user_can_manage_bells(public.bell_schedule_school_id(schedule_id)));

DROP POLICY IF EXISTS bell_day_types_delete ON public.bell_day_types;
CREATE POLICY bell_day_types_delete ON public.bell_day_types
  FOR DELETE TO authenticated
  USING (public.current_user_can_manage_bells(public.bell_schedule_school_id(schedule_id)));

DROP POLICY IF EXISTS bell_periods_read ON public.bell_periods;
CREATE POLICY bell_periods_read ON public.bell_periods
  FOR SELECT TO authenticated
  USING (public.current_user_can_view_bells(public.bell_day_type_school_id(day_type_id)));

DROP POLICY IF EXISTS bell_periods_insert ON public.bell_periods;
CREATE POLICY bell_periods_insert ON public.bell_periods
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_can_manage_bells(public.bell_day_type_school_id(day_type_id)));

DROP POLICY IF EXISTS bell_periods_update ON public.bell_periods;
CREATE POLICY bell_periods_update ON public.bell_periods
  FOR UPDATE TO authenticated
  USING (public.current_user_can_manage_bells(public.bell_day_type_school_id(day_type_id)))
  WITH CHECK (public.current_user_can_manage_bells(public.bell_day_type_school_id(day_type_id)));

DROP POLICY IF EXISTS bell_periods_delete ON public.bell_periods;
CREATE POLICY bell_periods_delete ON public.bell_periods
  FOR DELETE TO authenticated
  USING (public.current_user_can_manage_bells(public.bell_day_type_school_id(day_type_id)));

DROP POLICY IF EXISTS bell_schedule_weekdays_read ON public.bell_schedule_weekdays;
CREATE POLICY bell_schedule_weekdays_read ON public.bell_schedule_weekdays
  FOR SELECT TO authenticated
  USING (public.current_user_can_view_bells(public.bell_schedule_school_id(schedule_id)));

DROP POLICY IF EXISTS bell_schedule_weekdays_insert ON public.bell_schedule_weekdays;
CREATE POLICY bell_schedule_weekdays_insert ON public.bell_schedule_weekdays
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_can_manage_bells(public.bell_schedule_school_id(schedule_id)));

DROP POLICY IF EXISTS bell_schedule_weekdays_update ON public.bell_schedule_weekdays;
CREATE POLICY bell_schedule_weekdays_update ON public.bell_schedule_weekdays
  FOR UPDATE TO authenticated
  USING (public.current_user_can_manage_bells(public.bell_schedule_school_id(schedule_id)))
  WITH CHECK (public.current_user_can_manage_bells(public.bell_schedule_school_id(schedule_id)));

DROP POLICY IF EXISTS bell_schedule_weekdays_delete ON public.bell_schedule_weekdays;
CREATE POLICY bell_schedule_weekdays_delete ON public.bell_schedule_weekdays
  FOR DELETE TO authenticated
  USING (public.current_user_can_manage_bells(public.bell_schedule_school_id(schedule_id)));

DROP POLICY IF EXISTS bell_overrides_read ON public.bell_overrides;
CREATE POLICY bell_overrides_read ON public.bell_overrides
  FOR SELECT TO authenticated
  USING (public.current_user_can_view_bells(public.bell_schedule_school_id(schedule_id)));

DROP POLICY IF EXISTS bell_overrides_insert ON public.bell_overrides;
CREATE POLICY bell_overrides_insert ON public.bell_overrides
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_can_manage_bells(public.bell_schedule_school_id(schedule_id)));

DROP POLICY IF EXISTS bell_overrides_update ON public.bell_overrides;
CREATE POLICY bell_overrides_update ON public.bell_overrides
  FOR UPDATE TO authenticated
  USING (public.current_user_can_manage_bells(public.bell_schedule_school_id(schedule_id)))
  WITH CHECK (public.current_user_can_manage_bells(public.bell_schedule_school_id(schedule_id)));

DROP POLICY IF EXISTS bell_overrides_delete ON public.bell_overrides;
CREATE POLICY bell_overrides_delete ON public.bell_overrides
  FOR DELETE TO authenticated
  USING (public.current_user_can_manage_bells(public.bell_schedule_school_id(schedule_id)));

-- ── Resolved timeline ────────────────────────────────────────
-- Everything a bell page needs for the next p_days school-local days,
-- with each bell already converted to an absolute instant (epoch ms).
-- The page does no timezone math and never trusts its own clock for
-- "what time is it at school": AT TIME ZONE here handles DST.
--
-- Precedence per date: override, then school calendar closure, then
-- the weekday map. Called only by the bell_board edge function
-- (service role); returns NULL for an unknown or inactive token, or
-- when the school's bells module is off.

CREATE OR REPLACE FUNCTION public.bell_timeline(p_feed_token uuid, p_days integer DEFAULT 2)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_sched   public.bell_schedules%ROWTYPE;
  v_school  text;
  v_tz      text;
  v_today   date;
  v_date    date;
  v_days    jsonb := '[]'::jsonb;
  v_ovr     public.bell_overrides%ROWTYPE;
  v_has_ovr boolean;
  v_closure text;
  v_dt_id   uuid;
  v_dt_name text;
  v_periods jsonb;
  v_status  text;
  v_label   text;
BEGIN
  SELECT * INTO v_sched FROM bell_schedules
  WHERE feed_token = p_feed_token AND is_active = true;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM school_modules
    WHERE school_id = v_sched.school_id AND module = 'bells' AND enabled = true
  ) THEN
    RETURN NULL;
  END IF;

  SELECT name, coalesce(nullif(timezone, ''), 'America/New_York')
    INTO v_school, v_tz
  FROM schools WHERE id = v_sched.school_id;

  v_today := (now() AT TIME ZONE v_tz)::date;

  FOR i IN 0 .. greatest(least(coalesce(p_days, 2), 7), 1) - 1 LOOP
    v_date    := v_today + i;
    v_dt_id   := NULL;
    v_dt_name := NULL;
    v_label   := NULL;
    v_periods := '[]'::jsonb;

    SELECT * INTO v_ovr FROM bell_overrides
    WHERE schedule_id = v_sched.id AND override_date = v_date;
    v_has_ovr := FOUND;

    IF v_has_ovr THEN
      v_dt_id := v_ovr.day_type_id;
      v_label := v_ovr.note;
      v_status := CASE WHEN v_dt_id IS NULL THEN 'silenced' ELSE 'bells' END;
    ELSE
      SELECT title INTO v_closure FROM school_calendar_events
      WHERE school_id = v_sched.school_id
        AND event_type IN ('no_school', 'holiday', 'break', 'pd_day')
        AND v_date BETWEEN event_date AND coalesce(end_date, event_date)
      ORDER BY event_date
      LIMIT 1;

      IF FOUND THEN
        v_status := 'closed';
        v_label  := v_closure;
      ELSE
        SELECT day_type_id INTO v_dt_id FROM bell_schedule_weekdays
        WHERE schedule_id = v_sched.id AND dow = extract(dow FROM v_date)::int;
        v_status := CASE WHEN v_dt_id IS NULL THEN 'none' ELSE 'bells' END;
      END IF;
    END IF;

    IF v_dt_id IS NOT NULL THEN
      SELECT name INTO v_dt_name FROM bell_day_types WHERE id = v_dt_id;

      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'name',       p.name,
               'kind',       p.kind,
               'start',      (extract(epoch FROM ((v_date + p.start_time) AT TIME ZONE v_tz)) * 1000)::bigint,
               'end',        (extract(epoch FROM ((v_date + p.end_time)   AT TIME ZONE v_tz)) * 1000)::bigint,
               'ring_start', p.ring_start,
               'ring_end',   p.ring_end
             ) ORDER BY p.start_time), '[]'::jsonb)
        INTO v_periods
      FROM bell_periods p
      WHERE p.day_type_id = v_dt_id;
    END IF;

    v_days := v_days || jsonb_build_object(
      'date',     v_date,
      'status',   v_status,
      'label',    v_label,
      'day_type', v_dt_name,
      'periods',  v_periods
    );
  END LOOP;

  RETURN jsonb_build_object(
    'school',      v_school,
    'schedule',    v_sched.name,
    'grade_label', v_sched.grade_label,
    'timezone',    v_tz,
    'days',        v_days
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bell_timeline(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bell_timeline(uuid, integer) TO service_role;

-- ── Permission audit ─────────────────────────────────────────
-- log_permission_changes() tracks a fixed field list, so a new
-- permission has to be added here or its grant/revoke history never
-- reaches permission_audit_log. This also restores
-- can_review_all_requests, which 20260902000001 added and the two
-- later rewrites of this function (20260909000004, 20260920000003)
-- dropped.

CREATE OR REPLACE FUNCTION public.log_permission_changes() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  old_json jsonb := to_jsonb(OLD);
  new_json jsonb := to_jsonb(NEW);
  tracked_fields text[] := ARRAY[
    'can_login', 'can_access_admin', 'can_manage_access',
    'can_manage_staff', 'can_manage_students', 'can_manage_placement',
    'can_manage_families', 'can_manage_guardians', 'can_manage_bus_groups',
    'can_manage_carpools', 'can_manage_substitutes',
    'can_view_carline', 'can_manage_carline',
    'can_manage_campuses', 'can_manage_calendar',
    'can_manage_resource_docs', 'can_manage_reservations', 'can_manage_inventory',
    'can_manage_bells',
    'can_manage_licensure', 'can_manage_compliance', 'can_manage_chaperone_credentials',
    'can_manage_required_training', 'can_manage_field_trips',
    'can_manage_requests', 'can_review_all_requests', 'can_bulk_upload', 'can_export_data',
    'can_view_pto_calendar', 'can_review_pto', 'can_approve_pto',
    'can_submit_on_behalf', 'is_fallback_approver',
    'can_adjust_pto', 'can_manage_pto_balances', 'can_generate_pto_reports'
  ];
  field text;
  changer_id uuid;
BEGIN
  SELECT id INTO changer_id FROM public.profiles WHERE user_id = auth.uid();

  FOREACH field IN ARRAY tracked_fields LOOP
    IF old_json -> field IS DISTINCT FROM new_json -> field THEN
      INSERT INTO public.permission_audit_log
        (school_id, target_profile_id, changed_by_profile_id, field_name, old_value, new_value)
      VALUES (
        NEW.school_id, NEW.id, changer_id, field,
        (old_json ->> field)::boolean, (new_json ->> field)::boolean
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;
