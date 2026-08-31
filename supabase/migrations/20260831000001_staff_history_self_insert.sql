-- Staff self-service license/CEU adds (staff.html) never wrote to the audit
-- history tables at all -- writeHistory()/writeCeuHistory() only exist in
-- admin.licensure.js, and staff.html's insert/delete handlers never called
-- an equivalent. Every license or CEU a staff member added directly (as
-- opposed to an admin adding it on their behalf) has been invisible in the
-- Audit Log since staff self-entry launched (20260826000001/20260827000001).
--
-- Confirmed on prod before this migration: staff_license_ceu_history had
-- zero rows despite 3 self-added CEUs existing, and 5 of 9 staff_licenses
-- rows (all created on/after 2026-08-28, all still unverified -- exactly
-- the self-service ones) had no corresponding staff_license_history row.
--
-- staff.html is now wired to call this (writeMyLicenseHistory() /
-- writeMyCeuHistory()) for 'created' and 'deleted' only -- staff can't
-- verify or edit in place, so there's nothing else for them to audit.
-- Composes with the existing admin-only insert policy via OR (Postgres
-- combines multiple permissive policies for the same command).

CREATE POLICY "License history: staff own insert" ON public.staff_license_history FOR INSERT WITH CHECK (
    changed_by = auth.uid()
    AND change_type IN ('created', 'deleted')
    AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND p.employee_id = staff_license_history.employee_id
          AND p.school_id = staff_license_history.school_id
    )
);

CREATE POLICY "CEU history: staff own insert" ON public.staff_license_ceu_history FOR INSERT WITH CHECK (
    changed_by = auth.uid()
    AND change_type IN ('created', 'deleted')
    AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND p.employee_id = staff_license_ceu_history.employee_id
          AND p.school_id = staff_license_ceu_history.school_id
    )
);

-- Backfill the "created" entries that were silently dropped for records
-- that already exist, using their real created_at/created_by so the audit
-- trail reflects what actually happened rather than this migration's
-- run time. Idempotent (safe to re-run) via the NOT EXISTS guard.
INSERT INTO public.staff_license_history (license_id, employee_id, school_id, changed_by, change_type, changed_at)
SELECT sl.id, sl.employee_id, sl.school_id, sl.created_by, 'created', sl.created_at
FROM public.staff_licenses sl
WHERE NOT EXISTS (
    SELECT 1 FROM public.staff_license_history h
    WHERE h.license_id = sl.id AND h.change_type = 'created'
);

INSERT INTO public.staff_license_ceu_history (ceu_id, employee_id, school_id, changed_by, change_type, changed_at)
SELECT c.id, c.employee_id, c.school_id, c.created_by, 'created', c.created_at
FROM public.staff_license_ceus c
WHERE NOT EXISTS (
    SELECT 1 FROM public.staff_license_ceu_history h
    WHERE h.ceu_id = c.id AND h.change_type = 'created'
);
