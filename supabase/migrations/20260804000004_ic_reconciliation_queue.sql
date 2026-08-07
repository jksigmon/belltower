-- Staging queue for ambiguous IC-sync matches. Records already linked by ic_sourced_id
-- (or brand-new IC records with no existing match) apply automatically — only the
-- one-time heuristic match against a pre-existing manually-entered record (matched by
-- name+grade for students, email for guardians) needs a human to confirm it's really
-- the same person before anything gets linked/updated.

CREATE TABLE public.ic_reconciliation_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    school_id uuid NOT NULL REFERENCES public.schools (id),
    entity_type text NOT NULL CHECK (entity_type IN ('student', 'guardian')),
    ic_sourced_id text NOT NULL,
    existing_record_id uuid NOT NULL,
    match_reason text NOT NULL,
    existing_data jsonb NOT NULL,
    proposed_data jsonb NOT NULL,
    status text DEFAULT 'pending' NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by uuid REFERENCES auth.users (id)
);

CREATE UNIQUE INDEX ic_reconciliation_candidates_unique
    ON public.ic_reconciliation_candidates (school_id, entity_type, ic_sourced_id)
    WHERE status = 'pending';

ALTER TABLE public.ic_reconciliation_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY ic_reconciliation_candidates_admin_all ON public.ic_reconciliation_candidates
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = auth.uid()
              AND p.school_id = ic_reconciliation_candidates.school_id
              AND p.can_bulk_upload = true
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = auth.uid()
              AND p.school_id = ic_reconciliation_candidates.school_id
              AND p.can_bulk_upload = true
        )
    );

ALTER TABLE public.ic_sync_runs
    ADD COLUMN students_awaiting_review integer DEFAULT 0 NOT NULL,
    ADD COLUMN guardians_awaiting_review integer DEFAULT 0 NOT NULL;
