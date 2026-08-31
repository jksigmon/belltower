-- license-files bucket's allowed_mime_types allowlist (application/pdf,
-- image/jpeg, image/png, image/webp) doesn't include HEIC/HEIF -- the
-- default photo format on iPhone since iOS 11. A staff member snapping a
-- photo of a license/CEU certificate to attach as proof would either not
-- see it in the file picker (accept attribute, fixed client-side in
-- app/staff.html and app/licensure.html) or, once that's fixed, have the
-- upload itself rejected server-side by this bucket-level restriction.
--
-- ceu-files has no allowed_mime_types restriction at all (null = open), so
-- it isn't affected -- this migration only needs to touch license-files.

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif']
WHERE id = 'license-files';
