-- ============================================================
-- Bell Schedules: a bell sound per period
--
-- Each period can ring with its own sound (a softer one for lunch, the
-- classic bell for the end of the day). Every period starts on the
-- default, 'chime'. One tone covers both of a period's bells; when one
-- period ends at the instant the next begins, that single bell uses
-- the starting period's tone.
--
-- The keys match TONES in app/bell-tones.js, which synthesizes them.
-- Adding a tone means adding it in both places.
--
-- Idempotent: safe to re-run.
-- ============================================================

ALTER TABLE public.bell_periods
  ADD COLUMN IF NOT EXISTS tone text NOT NULL DEFAULT 'chime';

ALTER TABLE public.bell_periods DROP CONSTRAINT IF EXISTS bell_periods_tone_check;
ALTER TABLE public.bell_periods
  ADD CONSTRAINT bell_periods_tone_check
  CHECK (tone IN ('chime', 'classic', 'dingdong', 'westminster', 'tone', 'soft'));

-- Same function as 20261013000001 with 'tone' added to each period.
-- The bell_board edge function passes the timeline through untouched,
-- so it does not need a redeploy.

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
               'tone',       p.tone,
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
