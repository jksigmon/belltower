-- Staff self-entry for license records — mirrors 20260826000001_staff_ceu_self_entry.sql.
--
-- Root cause of the "We are unable to upload to Belltower" report: staff_license_ceus.license_id
-- is NOT NULL, so a CEU entry can't exist without a staff_licenses row, and staff_licenses only had
-- admin insert/select/update/delete policies -- staff could only ever SELECT their own rows. Most
-- schools never had an admin manually create a license record for every employee (Revolution Academy
-- had 4 of 119), so almost no one could log CEUs at all.
--
-- Staff can now add their own license record and upload its supporting file, but can never set
-- verified = true themselves -- that stays admin-only via admin.licensure.js's existing verify
-- workflow ("Licenses: admin update"). Staff can delete their own license (and its file) only while
-- it's still unverified, same as the CEU entries attached to it -- once an admin verifies it, it
-- becomes read-only to them. No staff UPDATE policy -- add/delete only, not edit-in-place.
--
-- CEUs can already be logged against an unverified license today ("CEUs: staff own insert" only
-- checks that the license belongs to the same employee, not that it's verified) -- staff don't have
-- to wait on admin review before starting to track CEUs.

CREATE POLICY "Licenses: staff own insert" ON public.staff_licenses FOR INSERT WITH CHECK (
    verified = false
    AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND p.employee_id = staff_licenses.employee_id
          AND p.school_id = staff_licenses.school_id
    )
);

CREATE POLICY "Licenses: staff own delete while unverified" ON public.staff_licenses FOR DELETE USING (
    verified = false
    AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND p.employee_id = staff_licenses.employee_id
    )
);

-- staff_license_files: let staff attach a file to their own still-unverified license. Table already
-- has "License files: select own" for staff reads; only insert/delete were admin-only.
CREATE POLICY "License files: staff insert own unverified" ON public.staff_license_files FOR INSERT WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.staff_licenses sl
        JOIN public.profiles p ON p.employee_id = sl.employee_id
        WHERE sl.id = staff_license_files.license_id
          AND p.user_id = auth.uid()
          AND sl.verified = false
    )
);

CREATE POLICY "License files: staff delete own unverified" ON public.staff_license_files FOR DELETE USING (
    EXISTS (
        SELECT 1 FROM public.staff_licenses sl
        JOIN public.profiles p ON p.employee_id = sl.employee_id
        WHERE sl.id = staff_license_files.license_id
          AND p.user_id = auth.uid()
          AND sl.verified = false
    )
);

-- Storage: path convention matches admin.licensure.js's uploadLicenseFile():
-- ${school_id}/${license_id}/${timestamp}-${filename}, so the license id is the second path
-- segment (mirrors the existing "License files storage: read own" policy).
CREATE POLICY "License files storage: staff insert own unverified" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'license-files'
        AND EXISTS (
            SELECT 1 FROM public.staff_licenses sl
            JOIN public.profiles p ON p.employee_id = sl.employee_id
            WHERE sl.id::text = (storage.foldername(name))[2]
              AND p.user_id = auth.uid()
              AND sl.verified = false
        )
    );

CREATE POLICY "License files storage: staff delete own unverified" ON storage.objects
    FOR DELETE USING (
        bucket_id = 'license-files'
        AND EXISTS (
            SELECT 1 FROM public.staff_licenses sl
            JOIN public.profiles p ON p.employee_id = sl.employee_id
            WHERE sl.id::text = (storage.foldername(name))[2]
              AND p.user_id = auth.uid()
              AND sl.verified = false
        )
    );
