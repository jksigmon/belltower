-- Staff could see their own license info on the staff portal but had no way
-- to open the attached PDF: the storage bucket's read policy was admin-only
-- (can_manage_licensure / superadmin), and there was no self-scoped SELECT
-- policy on staff_license_files for the staff.html query to even fetch the
-- file_path in the first place.
--
-- Also tightens an existing over-broad policy found on this table while
-- fixing the above: "school members can manage their license files" granted
-- every staff member SELECT/INSERT/UPDATE/DELETE on every OTHER staff
-- member's license file metadata row (not the PDFs themselves — the storage
-- bucket was still admin-only — but still a cross-staff privacy leak at the
-- table level). No frontend code relies on it (only admin.licensure.js
-- touches this table, and it never deletes), so it's replaced outright with
-- a properly scoped "read your own" policy instead of widened further.

DROP POLICY IF EXISTS "school members can manage their license files" ON public.staff_license_files;

DROP POLICY IF EXISTS "License files: select own" ON public.staff_license_files;
CREATE POLICY "License files: select own" ON public.staff_license_files
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.staff_licenses sl
      JOIN public.profiles p ON p.employee_id = sl.employee_id
      WHERE sl.id = staff_license_files.license_id
        AND p.user_id = auth.uid()
    )
  );

-- Storage bucket: let a staff member read (download/sign a URL for) a file
-- that belongs to one of their own license records. Path convention is
-- `${school_id}/${license_id}/${timestamp}-${filename}` (see
-- admin.licensure.js uploadLicenseFile), so the license_id is the second
-- path segment.
DROP POLICY IF EXISTS "License files storage: read own" ON storage.objects;
CREATE POLICY "License files storage: read own" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'license-files'
    AND EXISTS (
      SELECT 1 FROM public.staff_licenses sl
      JOIN public.profiles p ON p.employee_id = sl.employee_id
      WHERE sl.id::text = (storage.foldername(name))[2]
        AND p.user_id = auth.uid()
    )
  );
