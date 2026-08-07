-- Extends the reconciliation queue to cover family-level matches too. Pre-existing
-- families (bulk-loaded with real carline tags before any students were linked) can't
-- be recognized by student/guardian-level matching alone — a new household group with
-- no confirmed existing family now gets checked against existing families by name
-- before creating a fresh placeholder, staged here for the same human-approval flow.

ALTER TABLE public.ic_reconciliation_candidates
    DROP CONSTRAINT ic_reconciliation_candidates_entity_type_check;

ALTER TABLE public.ic_reconciliation_candidates
    ADD CONSTRAINT ic_reconciliation_candidates_entity_type_check
    CHECK (entity_type IN ('student', 'guardian', 'family'));
