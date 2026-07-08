-- ============================================================
-- School calendar events: time + location + user-added "event" type
-- and a dedicated can_manage_calendar permission
--
-- Adds optional start/end time and a location to calendar events,
-- and a generic 'event' type for entries added from the dashboard
-- quick-add form. Introduces can_manage_calendar so calendar
-- management can be granted to non-admins (e.g. front office),
-- and rewrites the write policy to honor it.
-- ============================================================

ALTER TABLE public.school_calendar_events
  ADD COLUMN IF NOT EXISTS start_time time,
  ADD COLUMN IF NOT EXISTS end_time   time,
  ADD COLUMN IF NOT EXISTS location   text;

-- Extend the event_type CHECK to allow generic 'event' entries
ALTER TABLE public.school_calendar_events
  DROP CONSTRAINT IF EXISTS school_calendar_events_event_type_check;
ALTER TABLE public.school_calendar_events
  ADD CONSTRAINT school_calendar_events_event_type_check
  CHECK (event_type IN (
    'no_school','holiday','pd_day','early_release',
    'break','quarter_end','first_last_day','event'
  ));

-- Dedicated permission so calendar management isn't limited to admins
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_calendar boolean NOT NULL DEFAULT false;

-- Superadmins manage any school's calendar; admins and anyone granted
-- can_manage_calendar may manage their own school's calendar.
DROP POLICY IF EXISTS "Admins manage calendar events" ON public.school_calendar_events;
CREATE POLICY "Calendar managers manage calendar events"
ON public.school_calendar_events FOR ALL
USING (
    EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND (
            p.is_superadmin = true
            OR (p.school_id = school_calendar_events.school_id
                AND (p.role = 'admin' OR p.can_manage_calendar = true))
          )
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND (
            p.is_superadmin = true
            OR (p.school_id = school_calendar_events.school_id
                AND (p.role = 'admin' OR p.can_manage_calendar = true))
          )
    )
);
