-- carline_bus_arrivals
-- Tracks which bus groups have been called during a dismissal event,
-- independently of student assignment. This ensures that buses with
-- no students assigned to them in the system can still be called and
-- visible on all classroom display screens.

CREATE TABLE public.carline_bus_arrivals (
  id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id             uuid NOT NULL REFERENCES public.schools(id),
  carline_event_id      uuid NOT NULL REFERENCES public.carline_events(id),
  bus_group_id          uuid NOT NULL REFERENCES public.bus_groups(id),
  called_at             timestamptz NOT NULL DEFAULT now(),
  called_by_profile_id  uuid REFERENCES public.profiles(id)
);

ALTER TABLE public.carline_bus_arrivals ENABLE ROW LEVEL SECURITY;

-- Any carline viewer can see bus arrivals for their school
CREATE POLICY carline_bus_arrivals_select ON public.carline_bus_arrivals
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = carline_bus_arrivals.school_id
        AND p.status = 'active'
        AND (p.is_superadmin = true OR p.can_view_carline = true)
    )
  );

-- Only carline managers (input page operators) can insert
CREATE POLICY carline_bus_arrivals_insert ON public.carline_bus_arrivals
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = carline_bus_arrivals.school_id
        AND p.status = 'active'
        AND (p.is_superadmin = true OR p.can_manage_carline = true)
    )
  );
