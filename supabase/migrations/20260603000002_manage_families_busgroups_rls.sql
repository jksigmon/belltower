-- bus_groups and families only had admin-only write policies.
-- Users with can_manage_bus_groups / can_manage_families need INSERT and UPDATE too.
-- (Guardians already has correct can_manage_guardians policies — no change needed.)

CREATE POLICY bus_groups_insert_manage_bus_groups ON public.bus_groups FOR INSERT
  WITH CHECK ((EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND p.school_id = bus_groups.school_id
      AND p.can_manage_bus_groups = true
  )));

CREATE POLICY bus_groups_update_manage_bus_groups ON public.bus_groups FOR UPDATE
  USING ((EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND p.school_id = bus_groups.school_id
      AND p.can_manage_bus_groups = true
  )))
  WITH CHECK ((EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND p.school_id = bus_groups.school_id
      AND p.can_manage_bus_groups = true
  )));


CREATE POLICY families_insert_manage_families ON public.families FOR INSERT
  WITH CHECK ((EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND p.school_id = families.school_id
      AND p.can_manage_families = true
  )));

CREATE POLICY families_update_manage_families ON public.families FOR UPDATE
  USING ((EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND p.school_id = families.school_id
      AND p.can_manage_families = true
  )))
  WITH CHECK ((EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND p.school_id = families.school_id
      AND p.can_manage_families = true
  )));
