-- Street address for a field trip's destination, shown on the Day-of sheet
-- and the Plan Vehicles roster. Existing RLS and grants on field_trips apply.
ALTER TABLE public.field_trips
  ADD COLUMN IF NOT EXISTS destination_address text;
