-- Field trip chaperones could previously only be a guardian (tied to a
-- family) or a staff employee. Outside/community volunteers with no family
-- link and no employment record had nowhere to attach, even though their
-- BG/MVR compliance can already be tracked standalone in
-- compliance_volunteers (guardian_id there is nullable -- see
-- 20260812000002_compliance_volunteers.sql). Add a third option: link the
-- chaperone row directly to a compliance_volunteers record.
--
-- No RLS changes needed: field_trip_chaperones' existing ftc_all policy is
-- keyed off school_id/manager status, not the person columns, and
-- compliance_volunteers already grants field trip managers read access via
-- compliance_volunteers_ft_read (20260812000002).

ALTER TABLE public.field_trip_chaperones
  ADD COLUMN IF NOT EXISTS volunteer_id uuid REFERENCES public.compliance_volunteers(id) ON DELETE CASCADE;

ALTER TABLE public.field_trip_chaperones
  DROP CONSTRAINT IF EXISTS field_trip_chaperones_one_person;

ALTER TABLE public.field_trip_chaperones
  ADD CONSTRAINT field_trip_chaperones_one_person CHECK (
    num_nonnulls(guardian_id, employee_id, volunteer_id) = 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS field_trip_chaperones_volunteer_active_unique
  ON public.field_trip_chaperones (field_trip_id, volunteer_id)
  WHERE removed_at IS NULL;
