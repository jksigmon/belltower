-- Allow CEU entries to be logged without a linked license.
--
-- staff_license_ceus.license_id was NOT NULL, so a CEU could only ever be
-- recorded against an existing staff_licenses row. Some PD (e.g. general
-- district training) doesn't map to any one license, and staff who haven't
-- had a license verified yet still want to start a running log. This makes
-- license_id optional; admin.licensure.js and staff.html now offer a
-- "No linked license (general CEU)" option alongside the existing per-license
-- flows.
--
-- "CEUs: staff own insert" (20260826000001) required an EXISTS match against
-- staff_licenses for the given license_id -- that check now only applies
-- when license_id is provided, so it can't be used to smuggle in a CEU
-- against someone else's license by passing a stranger's license_id with a
-- forged employee_id (the two other AND clauses already guard that; this
-- just adds the null case).

ALTER TABLE public.staff_license_ceus ALTER COLUMN license_id DROP NOT NULL;

DROP POLICY IF EXISTS "CEUs: staff own insert" ON public.staff_license_ceus;
CREATE POLICY "CEUs: staff own insert" ON public.staff_license_ceus FOR INSERT WITH CHECK (
    verified = false
    AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND p.employee_id = staff_license_ceus.employee_id
    )
    AND (
        staff_license_ceus.license_id IS NULL
        OR EXISTS (
            SELECT 1 FROM public.staff_licenses sl
            WHERE sl.id = staff_license_ceus.license_id
              AND sl.employee_id = staff_license_ceus.employee_id
        )
    )
);
