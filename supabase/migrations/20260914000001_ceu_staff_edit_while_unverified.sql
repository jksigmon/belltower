-- Staff can now edit their own still-unverified CEU entries in place
-- (staff.html), instead of deleting and re-creating one just to fix a typo
-- or attach the certificate they forgot. Two adjustments are needed for
-- that; the UPDATE policy itself already exists.
--
-- 1. "CEU history: staff own insert" (20260831000001) allows only
--    change_type IN ('created', 'deleted') -- written when the staff-facing
--    UI was add/delete only. writeMyCeuHistory() in staff.html reports RLS
--    failures to console.error and nothing else, so without this every
--    staff edit would save fine while its audit-trail row was silently
--    dropped, which is exactly the failure mode 20260831000001 existed to
--    fix. 'updated' joins the list.
--
-- 2. "CEUs: staff own update while unverified" (20260831000003) was written
--    to unblock the attachment-linking call, which never touches
--    license_id, so it carries no license-ownership clause. Edit mode
--    leaves the license select open for re-linking a general CEU, which
--    makes license_id staff-settable via UPDATE for the first time. The
--    INSERT policy already guards this (20260830000001): the license, when
--    one is given, has to belong to the same employee. Without the matching
--    clause here, a staff member could move their own CEU onto a colleague's
--    license id, where it would show up in the admin panel under that
--    colleague's license. Same clause, copied verbatim, so the two policies
--    can't drift apart again.
--
-- Verified entries stay read-only to staff: both policies still require
-- verified = false in USING and WITH CHECK, so an admin verifying an entry
-- mid-edit makes the update match zero rows (staff.html checks the returned
-- row count and tells the user rather than reporting a phantom success).

DROP POLICY IF EXISTS "CEU history: staff own insert" ON public.staff_license_ceu_history;
CREATE POLICY "CEU history: staff own insert" ON public.staff_license_ceu_history FOR INSERT WITH CHECK (
    changed_by = auth.uid()
    AND change_type IN ('created', 'updated', 'deleted')
    AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND p.employee_id = staff_license_ceu_history.employee_id
          AND p.school_id = staff_license_ceu_history.school_id
    )
);

DROP POLICY IF EXISTS "CEUs: staff own update while unverified" ON public.staff_license_ceus;
CREATE POLICY "CEUs: staff own update while unverified" ON public.staff_license_ceus FOR UPDATE USING (
    verified = false
    AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND p.employee_id = staff_license_ceus.employee_id
    )
) WITH CHECK (
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
