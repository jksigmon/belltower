-- Ensure request-attachments bucket is public so stored URLs are directly accessible.
-- The prior migration used ON CONFLICT DO NOTHING which skipped this if the bucket
-- already existed as private.
UPDATE storage.buckets
SET public = true
WHERE id = 'request-attachments';
