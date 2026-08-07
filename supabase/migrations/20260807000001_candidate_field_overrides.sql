-- Lets a reviewer pull in specific changed fields for one matched record (e.g. "yes,
-- take IC's DOB and student number for this kid") without enabling that field globally
-- for every other confirmed match via Field Sync Settings.

ALTER TABLE public.ic_reconciliation_candidates
    ADD COLUMN field_overrides jsonb DEFAULT '[]'::jsonb NOT NULL;
