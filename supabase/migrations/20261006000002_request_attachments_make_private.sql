-- request-attachments was created public (20260528000001) and explicitly
-- re-forced public in 20260528000003 -- the one storage bucket in this repo
-- that isn't private + signed URLs. Any file a staff member attaches to a
-- Requests-module submission was reachable by anyone who ever saw the URL
-- (it gets emailed out verbatim by forward_request / send_request_notification),
-- forever, with no auth and no expiry.
--
-- Flips the bucket private and replaces the public-read policy with one
-- scoped to the request's submitter or anyone who can act on the request --
-- can_action_request() (added in 20260921000001 for the forwarding feature):
-- a manager of the form, a superadmin, or a school-wide reviewer on a
-- non-confidential form.
--
-- Object path is `${school_id}/${request_id}/${field_id}.${ext}`
-- (app/requests.js), so (storage.foldername(name))[2] is the request_id.
--
-- The app side (app/requests.js, app/admin.requests.js, app/requests-manage.js,
-- app/requests.export.js, app/admin.shared.js, and the forward_request /
-- send_request_notification edge functions) was updated in the same change
-- to stop storing/emailing a permanent public URL and instead resolve a
-- short-lived signed URL at render/send time. Rows saved before this change
-- still hold a full public URL rather than a bare path; the app-side helper
-- (requestAttachmentPath() in admin.shared.js) strips the known public-URL
-- prefix so those old rows keep working too.

UPDATE storage.buckets SET public = false WHERE id = 'request-attachments';

DROP POLICY IF EXISTS "request_attachments_read" ON storage.objects;
CREATE POLICY "request_attachments_read" ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'request-attachments'
  AND EXISTS (
    SELECT 1 FROM public.staff_requests sr
    WHERE sr.id::text = (storage.foldername(name))[2]
      AND (
        public.can_action_request(sr.id, auth.uid())
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.user_id = auth.uid() AND p.id = sr.submitted_by
        )
      )
  )
);
