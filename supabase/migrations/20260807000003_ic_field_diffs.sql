-- Persistent audit of fields where Belltower and Infinite Campus both have a value but
-- they disagree, for already-linked people. Distinct from ic_data_gaps (which is IC
-- being blank). Lets a reviewer pull in IC's value for one specific field on one
-- specific record at any time, not just in the narrow window right after approving a
-- match — that one-shot mechanism (ic_reconciliation_candidates.field_overrides) stops
-- being checked the moment a record becomes "linked".

CREATE TABLE public.ic_field_diffs (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    school_id uuid NOT NULL REFERENCES public.schools (id),
    entity_type text NOT NULL CHECK (entity_type IN ('student', 'guardian')),
    entity_id uuid NOT NULL,
    ic_sourced_id text NOT NULL,
    field text NOT NULL,
    belltower_value text,
    ic_value text,
    first_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);

CREATE UNIQUE INDEX ic_field_diffs_unique
    ON public.ic_field_diffs (school_id, entity_type, entity_id, field);

ALTER TABLE public.ic_field_diffs ENABLE ROW LEVEL SECURITY;

CREATE POLICY ic_field_diffs_admin_all ON public.ic_field_diffs
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = auth.uid()
              AND p.school_id = ic_field_diffs.school_id
              AND p.can_bulk_upload = true
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = auth.uid()
              AND p.school_id = ic_field_diffs.school_id
              AND p.can_bulk_upload = true
        )
    );
