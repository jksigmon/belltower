-- Add school-level email config for non-PTO notifications (requests, alerts, etc.)
ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS notifications_from_email text,
  ADD COLUMN IF NOT EXISTS notifications_reply_to   text;

COMMENT ON COLUMN public.schools.notifications_from_email IS
  'From address for general notifications (requests, alerts). Falls back to pto_from_email, then the system default.';
COMMENT ON COLUMN public.schools.notifications_reply_to IS
  'Reply-to for general notifications. Falls back to pto_reply_to, then the system default.';
