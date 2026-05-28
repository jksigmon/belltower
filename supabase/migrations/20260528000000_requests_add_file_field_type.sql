-- Allow 'file' as a valid field_type for request category fields
ALTER TABLE public.request_category_fields
  DROP CONSTRAINT IF EXISTS request_category_fields_field_type_check;

ALTER TABLE public.request_category_fields
  ADD CONSTRAINT request_category_fields_field_type_check
  CHECK (field_type IN ('text', 'textarea', 'select', 'date', 'boolean', 'file'));
