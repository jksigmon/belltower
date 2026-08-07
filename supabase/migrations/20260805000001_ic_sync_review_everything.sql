-- Two changes to support "review everything, sync only what we're told to" workflow:
--
-- 1. Brand-new students/guardians (never seen before, no existing Belltower record at
--    all) now get staged for accept/reject too, instead of auto-creating. There's no
--    existing_record_id to reference for these, so it becomes nullable.
--
-- 2. Per-school toggles for which fields the sync is allowed to write on already-linked
--    people at all. Belltower is the system of record day-to-day (IC requires emailing
--    a third party to change anything), so most fields should stay report-only —
--    surfaced in the diff export, never silently overwritten.

ALTER TABLE public.ic_reconciliation_candidates
    ALTER COLUMN existing_record_id DROP NOT NULL;

CREATE TABLE public.ic_sync_field_settings (
    school_id uuid NOT NULL PRIMARY KEY REFERENCES public.schools (id),
    sync_grade_level boolean DEFAULT true NOT NULL,
    sync_date_of_birth boolean DEFAULT true NOT NULL,
    sync_student_number boolean DEFAULT true NOT NULL,
    sync_email boolean DEFAULT true NOT NULL,
    sync_phone boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.ic_sync_field_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY ic_sync_field_settings_admin_all ON public.ic_sync_field_settings
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = auth.uid()
              AND p.school_id = ic_sync_field_settings.school_id
              AND p.can_bulk_upload = true
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = auth.uid()
              AND p.school_id = ic_sync_field_settings.school_id
              AND p.can_bulk_upload = true
        )
    );
