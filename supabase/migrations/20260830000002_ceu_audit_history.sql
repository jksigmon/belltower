-- Audit trail for staff_license_ceus, mirroring staff_license_history --
-- plus a fix to staff_license_history uncovered while building it.
--
-- BUG FIX: staff_license_history.license_id was `ON DELETE CASCADE`
-- against staff_licenses(id). deleteLicense() in admin.licensure.js writes
-- a 'deleted' history row *before* deleting the license row -- but since the
-- FK cascades, that delete immediately wipes out not just the row it just
-- wrote, but the license's ENTIRE prior history (every created/updated/
-- verified entry too). The one event an audit trail most needs to survive
-- is the deletion itself. Fixed by denormalizing employee_id onto the
-- history row (so it stays meaningful without the join) and changing the
-- FK to ON DELETE SET NULL (the history row survives, license_id just goes
-- null). Existing rows are backfilled from their still-intact license.
--
-- staff_license_ceu_history is built the same way from day one: ceu_id is
-- nullable with ON DELETE SET NULL, employee_id is captured directly and,
-- like staff_license_history.employee_id above, deliberately carries no FK
-- -- so the audit trail also survives the employee record itself later
-- being deleted, not just the license/CEU it was attached to.
--
-- RLS FIX: "License history: insert" (licensure-migration.sql) only checked
-- that school_id matched the caller's own profile -- no can_manage_licensure
-- check, and no verification that changed_by or employee_id were truthful.
-- Any authenticated staff member could write a fabricated audit-trail row
-- for their own school: a fake "verified" entry, or one attributed to a
-- different admin via changed_by. Since the whole point of an audit trail
-- is that it can be trusted, this tightens it to require licensure-admin
-- access, changed_by matching the caller, and employee_id (when set)
-- actually belonging to that school. staff_license_ceu_history's own insert
-- policy below is written the same way from day one.

ALTER TABLE public.staff_license_history ADD COLUMN IF NOT EXISTS employee_id uuid;

UPDATE public.staff_license_history h
SET employee_id = sl.employee_id
FROM public.staff_licenses sl
WHERE sl.id = h.license_id
  AND h.employee_id IS NULL;

ALTER TABLE public.staff_license_history ALTER COLUMN license_id DROP NOT NULL;

ALTER TABLE public.staff_license_history
    DROP CONSTRAINT IF EXISTS staff_license_history_license_id_fkey;
ALTER TABLE public.staff_license_history
    ADD CONSTRAINT staff_license_history_license_id_fkey
    FOREIGN KEY (license_id) REFERENCES public.staff_licenses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_staff_license_history_employee_id
    ON public.staff_license_history USING btree (employee_id);

DROP POLICY IF EXISTS "License history: insert" ON public.staff_license_history;
CREATE POLICY "License history: insert" ON public.staff_license_history FOR INSERT WITH CHECK (
    public.current_user_can_manage_licensure(staff_license_history.school_id)
    AND changed_by = auth.uid()
    AND (
        employee_id IS NULL
        OR EXISTS (
            SELECT 1 FROM public.employees e
            WHERE e.id = staff_license_history.employee_id
              AND e.school_id = staff_license_history.school_id
        )
    )
);

-- ── staff_license_ceu_history ───────────────────────────────────────────

CREATE TABLE public.staff_license_ceu_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ceu_id uuid,
    employee_id uuid NOT NULL,
    school_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    changed_by uuid,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    change_type text NOT NULL,
    field_changes jsonb,
    CONSTRAINT staff_license_ceu_history_pkey PRIMARY KEY (id),
    CONSTRAINT staff_license_ceu_history_ceu_id_fkey
        FOREIGN KEY (ceu_id) REFERENCES public.staff_license_ceus(id) ON DELETE SET NULL
);

CREATE INDEX idx_staff_license_ceu_history_ceu_id      ON public.staff_license_ceu_history USING btree (ceu_id);
CREATE INDEX idx_staff_license_ceu_history_employee_id ON public.staff_license_ceu_history USING btree (employee_id);
CREATE INDEX idx_staff_license_ceu_history_school_id   ON public.staff_license_ceu_history USING btree (school_id);

ALTER TABLE public.staff_license_ceu_history ENABLE ROW LEVEL SECURITY;

-- SELECT uses the SECURITY DEFINER helper (not a raw inline EXISTS) since
-- the Audit Log tab loads up to 200 rows across the whole school in one
-- query -- the same bulk-read shape that motivated
-- current_user_can_manage_licensure() for staff_license_ceus itself.
CREATE POLICY "CEU history: admin select" ON public.staff_license_ceu_history FOR SELECT USING (
    public.current_user_can_manage_licensure(staff_license_ceu_history.school_id)
);

-- Requires licensure-admin access (not just same-school), changed_by to
-- match the caller (no attributing a change to a different admin), and
-- employee_id to actually belong to this school -- see the RLS FIX note
-- above. Inserts only ever happen from the licensure-gated admin page code
-- path (writeCeuHistory() in admin.licensure.js), which already satisfies
-- all three.
CREATE POLICY "CEU history: insert" ON public.staff_license_ceu_history FOR INSERT WITH CHECK (
    public.current_user_can_manage_licensure(staff_license_ceu_history.school_id)
    AND changed_by = auth.uid()
    AND EXISTS (
        SELECT 1 FROM public.employees e
        WHERE e.id = staff_license_ceu_history.employee_id
          AND e.school_id = staff_license_ceu_history.school_id
    )
);
