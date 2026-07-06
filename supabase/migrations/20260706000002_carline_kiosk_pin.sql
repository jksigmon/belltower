-- Add kiosk PIN column to school_settings.
-- Allows carline managers to set a shared 6-digit PIN that substitutes
-- enter on the /app/carline-kiosk.html page to access the read-only
-- dismissal display without a Supabase auth account.
ALTER TABLE public.school_settings
  ADD COLUMN IF NOT EXISTS carline_kiosk_pin text;
