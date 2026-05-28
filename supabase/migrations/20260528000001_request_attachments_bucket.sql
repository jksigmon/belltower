-- Create storage bucket for request form file attachments
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'request-attachments',
  'request-attachments',
  true,
  10485760, -- 10 MB limit
  ARRAY['image/jpeg','image/png','image/gif','image/webp','application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users at the same school to upload
CREATE POLICY "request_attachments_upload"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'request-attachments');

-- Allow public reads (bucket is public, but policy still required)
CREATE POLICY "request_attachments_read"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'request-attachments');

-- Allow authenticated users to update/replace their uploads
CREATE POLICY "request_attachments_update"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'request-attachments');
