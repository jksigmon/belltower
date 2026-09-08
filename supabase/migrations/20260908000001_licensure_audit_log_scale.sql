-- Make the licensure Audit Log tab scale.
--
-- Three problems this addresses:
--
-- 1. INDEXES. Both history tables are read as
--    `school_id = $1 ORDER BY changed_at DESC LIMIT n`, and neither was
--    indexed for it. staff_license_history had no school_id index at all
--    (seq scan across every school, then a sort); staff_license_ceu_history
--    had school_id but nothing on changed_at, so it still sorted the whole
--    school's history to find the newest few. That cost is paid on every
--    licensure page load, not just the Audit Log tab, because the Overview
--    "Recent Activity" card runs the same query with limit 3.
--
--    The composite carries id as a third key because the app now orders by
--    (changed_at DESC, id DESC). A tiebreaker is required for correct
--    paging: changed_at is a transaction timestamp, so a license edit and
--    the CEU rows written alongside it share it exactly, and without a
--    stable second key those rows can swap between pages and be shown
--    twice or skipped entirely.
--
-- 2. SELECT POLICY. staff_license_history still used a raw inline
--    EXISTS (SELECT ... FROM profiles), while every other licensure table
--    (including staff_license_ceu_history) uses the
--    current_user_can_manage_licensure() SECURITY DEFINER helper, which
--    exists precisely because these are bulk reads. Aligning the two.
--    Note this is a small behavior change in both directions, matching the
--    CEU history policy exactly: a profile with status <> 'active' loses
--    access, and a superadmin gains it across schools.
--
-- 3. PAGING ACROSS TWO TABLES. The tab merged two separately-limited
--    queries in JavaScript, which caps out at whatever limit was passed
--    (200) with no total count and no way to reach anything older. A
--    UNION ALL view lets PostgREST do range/count/filter in Postgres over
--    the whole log instead. security_invoker so each branch is still
--    subject to its own table's RLS.

-- ── 1. Indexes ──────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_staff_license_history_school_changed
    ON public.staff_license_history USING btree (school_id, changed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_staff_license_ceu_history_school_changed
    ON public.staff_license_ceu_history USING btree (school_id, changed_at DESC, id DESC);

-- Redundant now: the composite above has school_id as its leading column,
-- so it serves every lookup this one did. Dropping it saves the write
-- amplification on a table that is append-only and never updated.
DROP INDEX IF EXISTS public.idx_staff_license_ceu_history_school_id;

-- ── 2. Align the license-history SELECT policy with the CEU one ─────────

DROP POLICY IF EXISTS "License history: admin select" ON public.staff_license_history;
CREATE POLICY "License history: admin select" ON public.staff_license_history FOR SELECT USING (
    public.current_user_can_manage_licensure(staff_license_history.school_id)
);

-- ── 3. Unified audit-log view ──────────────────────────────────────────

CREATE OR REPLACE VIEW public.staff_license_audit_log
WITH (security_invoker = true) AS
    SELECT
        h.id,
        'license'::text AS record_type,
        h.employee_id,
        h.school_id,
        h.changed_by,
        h.changed_at,
        h.change_type,
        h.field_changes
    FROM public.staff_license_history h
    UNION ALL
    SELECT
        c.id,
        'ceu'::text AS record_type,
        c.employee_id,
        c.school_id,
        c.changed_by,
        c.changed_at,
        c.change_type,
        c.field_changes
    FROM public.staff_license_ceu_history c;

COMMENT ON VIEW public.staff_license_audit_log IS
    'Read-only union of staff_license_history and staff_license_ceu_history for the licensure Audit Log tab. security_invoker, so each branch is filtered by its own table RLS. Order by (changed_at DESC, id DESC) when paging: changed_at alone is not unique.';

GRANT SELECT ON public.staff_license_audit_log TO "authenticated";
GRANT SELECT ON public.staff_license_audit_log TO "service_role";
