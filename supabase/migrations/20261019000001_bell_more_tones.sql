-- ============================================================
-- Bell Schedules: more school-style bell sounds
--
-- Adds four sounds closer to a real period change bell:
--   hallway     long ringing hallway bell
--   electronic  two-pitch electronic class bell
--   buzzer      class change buzzer
--   triple      three-note PA chime
--
-- The keys must match TONES in app/bell-tones.js. Existing periods are
-- unaffected; this only widens the list a period may choose from.
--
-- Idempotent: safe to re-run.
-- ============================================================

ALTER TABLE public.bell_periods DROP CONSTRAINT IF EXISTS bell_periods_tone_check;
ALTER TABLE public.bell_periods
  ADD CONSTRAINT bell_periods_tone_check
  CHECK (tone IN (
    'chime', 'classic', 'hallway', 'electronic', 'buzzer', 'triple',
    'dingdong', 'westminster', 'tone', 'soft'
  ));
