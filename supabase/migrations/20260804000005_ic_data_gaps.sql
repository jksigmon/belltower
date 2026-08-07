-- Tracks fields Infinite Campus is currently missing for a linked person, where
-- Belltower already has a value we're preserving (see preferExistingWhenBlank in
-- sync_infinite_campus). Gives staff a concrete, ongoing audit list to hand to
-- whoever manages data quality in Infinite Campus, rather than silently masking
-- the gap forever.

CREATE TABLE public.ic_data_gaps (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    school_id uuid NOT NULL REFERENCES public.schools (id),
    entity_type text NOT NULL CHECK (entity_type IN ('student', 'guardian')),
    entity_id uuid NOT NULL,
    ic_sourced_id text NOT NULL,
    field text NOT NULL,
    belltower_value text,
    first_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);

CREATE UNIQUE INDEX ic_data_gaps_unique
    ON public.ic_data_gaps (school_id, entity_type, entity_id, field);

ALTER TABLE public.ic_data_gaps ENABLE ROW LEVEL SECURITY;

CREATE POLICY ic_data_gaps_admin_all ON public.ic_data_gaps
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = auth.uid()
              AND p.school_id = ic_data_gaps.school_id
              AND p.can_bulk_upload = true
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = auth.uid()
              AND p.school_id = ic_data_gaps.school_id
              AND p.can_bulk_upload = true
        )
    );
