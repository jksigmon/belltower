-- BUG: staff_license_ceus had no staff UPDATE policy at all (only "CEUs:
-- admin update"). staff.html's CEU save flow uploads the attachment to
-- storage successfully, then runs a second call to link it:
--   await supabase.from('staff_license_ceus').update({file_path, file_name})...
-- That call's result was never checked, so the RLS rejection was silent --
-- the entry saved, a success toast showed, the file sat in storage, but
-- file_path/file_name on the row stayed null forever. Confirmed on prod:
-- every one of the 14 self-service CEU records had file_path IS NULL, and
-- all 14 had a matching file already sitting in storage.google.
--
-- Fixed going forward with a staff-own-while-unverified UPDATE policy
-- (same scope/shape as the existing insert/delete policies -- staff can
-- already achieve an equivalent effect via delete+recreate, so this isn't
-- a new capability, just making the existing upload flow actually work).
--
-- Backfilled below: links the 14 already-uploaded files to their CEU rows
-- using the real object path, so nobody has to re-upload anything that
-- already made it to storage.

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
);

UPDATE public.staff_license_ceus c
SET file_path = o.name,
    file_name = regexp_replace(o.name, '^.*/[0-9]+-', '')
FROM storage.objects o
WHERE o.bucket_id = 'ceu-files'
  AND (storage.foldername(o.name))[2] = c.id::text
  AND c.file_path IS NULL;
