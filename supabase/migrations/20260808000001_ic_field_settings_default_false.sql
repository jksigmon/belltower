-- Belltower is the day-to-day system of record; auto-applying an IC field on an
-- already-linked record should be something a human turns on deliberately, not the
-- out-of-the-box behavior for a school that's never touched this settings panel.

ALTER TABLE public.ic_sync_field_settings
    ALTER COLUMN sync_grade_level SET DEFAULT false,
    ALTER COLUMN sync_date_of_birth SET DEFAULT false,
    ALTER COLUMN sync_student_number SET DEFAULT false,
    ALTER COLUMN sync_email SET DEFAULT false,
    ALTER COLUMN sync_phone SET DEFAULT false;
