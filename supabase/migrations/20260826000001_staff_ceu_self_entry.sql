-- Staff self-entry for CEUs — the piece 20260812000006_staff_license_ceus.sql
-- deferred: "Staff self-entry (staff logging their own PD, admin verifies)
-- is intentionally NOT included yet -- only a staff read-own SELECT policy
-- is added below. Add a 'CEUs: staff own insert' policy alongside the
-- staff-facing 'Add CEU' UI when that's built." That UI now exists on
-- staff.html.
--
-- Staff can log CEUs toward a license they hold, but can never set
-- verified = true themselves -- that stays admin-only via
-- admin.licensure.js's existing verify workflow ("CEUs: admin update").
-- Staff can delete an entry only while it's still unverified (so a typo
-- doesn't require an admin round-trip); once an admin verifies it, it
-- becomes read-only to them. No staff UPDATE policy -- the staff-facing UI
-- is add/delete only, not edit-in-place.
--
-- These are single-row, user-initiated policies (not joined into bulk list
-- queries the way Student Directory-style reads are), so they follow the
-- existing "CEUs: staff own select" policy's raw EXISTS(...profiles...)
-- pattern rather than adding a new SECURITY DEFINER helper.

CREATE POLICY "CEUs: staff own insert" ON public.staff_license_ceus FOR INSERT WITH CHECK (
    verified = false
    AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND p.employee_id = staff_license_ceus.employee_id
    )
    AND EXISTS (
        SELECT 1 FROM public.staff_licenses sl
        WHERE sl.id = staff_license_ceus.license_id
          AND sl.employee_id = staff_license_ceus.employee_id
    )
);

CREATE POLICY "CEUs: staff own delete while unverified" ON public.staff_license_ceus FOR DELETE USING (
    verified = false
    AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND p.employee_id = staff_license_ceus.employee_id
    )
);

-- Storage: let staff upload their own CEU attachment, and clean it up when
-- they delete the still-unverified entry it belongs to (avoids orphaning
-- the file in the bucket). Path convention matches admin.licensure.js's
-- uploadCeuFile(): ${school_id}/${ceu_id}/${timestamp}-${filename}, so the
-- CEU id is the second path segment (mirrors "CEU files storage: read own").
CREATE POLICY "CEU files storage: staff insert own unverified" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'ceu-files'
        AND EXISTS (
            SELECT 1 FROM public.staff_license_ceus c
            JOIN public.profiles p ON p.employee_id = c.employee_id
            WHERE c.id::text = (storage.foldername(name))[2]
              AND p.user_id = auth.uid()
              AND c.verified = false
        )
    );

CREATE POLICY "CEU files storage: staff delete own unverified" ON storage.objects
    FOR DELETE USING (
        bucket_id = 'ceu-files'
        AND EXISTS (
            SELECT 1 FROM public.staff_license_ceus c
            JOIN public.profiles p ON p.employee_id = c.employee_id
            WHERE c.id::text = (storage.foldername(name))[2]
              AND p.user_id = auth.uid()
              AND c.verified = false
        )
    );
