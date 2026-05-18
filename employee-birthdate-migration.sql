-- Add birthdate to employees table for staff birthday display
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS birthdate date;
