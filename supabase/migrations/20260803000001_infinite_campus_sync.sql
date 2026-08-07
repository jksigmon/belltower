-- Adds columns needed to sync students/guardians from Infinite Campus (OneRoster v1p2)
-- and a log table for tracking each sync run.

ALTER TABLE public.students
    ADD COLUMN ic_sourced_id text,
    ADD COLUMN date_of_birth date,
    ADD COLUMN last_synced_at timestamp with time zone;

ALTER TABLE public.guardians
    ADD COLUMN ic_sourced_id text,
    ADD COLUMN last_synced_at timestamp with time zone;

-- Partial unique indexes: allows existing/manually-entered rows to keep ic_sourced_id null
-- while still guaranteeing no duplicate sync matches per school once a row is linked to IC.
CREATE UNIQUE INDEX students_school_ic_sourced_id_unique
    ON public.students (school_id, ic_sourced_id)
    WHERE ic_sourced_id IS NOT NULL;

CREATE UNIQUE INDEX guardians_school_ic_sourced_id_unique
    ON public.guardians (school_id, ic_sourced_id)
    WHERE ic_sourced_id IS NOT NULL;

CREATE TABLE public.ic_sync_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    school_id uuid NOT NULL REFERENCES public.schools (id),
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    students_created integer DEFAULT 0 NOT NULL,
    students_updated integer DEFAULT 0 NOT NULL,
    students_deactivated integer DEFAULT 0 NOT NULL,
    guardians_created integer DEFAULT 0 NOT NULL,
    guardians_updated integer DEFAULT 0 NOT NULL,
    families_created integer DEFAULT 0 NOT NULL,
    error_message text,
    dry_run boolean DEFAULT false NOT NULL,
    preview_summary jsonb
);

ALTER TABLE public.ic_sync_runs ENABLE ROW LEVEL SECURITY;

-- Edge function uses the service role key (bypasses RLS by design, same as other functions).
-- Admin UI reads this table for sync history, so allow admins to view it.
CREATE POLICY ic_sync_runs_admin_select ON public.ic_sync_runs
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = auth.uid()
              AND p.school_id = ic_sync_runs.school_id
              AND p.can_access_admin = true
        )
    );
