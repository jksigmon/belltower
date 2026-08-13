-- ============================================================
-- Request-form field type: Link (URL)
--
-- Stores the raw URL string in staff_request_responses.value, same as
-- every other field type -- no new columns. Downstream consumers
-- (admin Requests view, manager drawer) render it as a clickable
-- <a href> instead of plain text.
-- ============================================================

ALTER TABLE public.request_category_fields
  DROP CONSTRAINT IF EXISTS request_category_fields_field_type_check;
ALTER TABLE public.request_category_fields
  ADD CONSTRAINT request_category_fields_field_type_check
  CHECK (field_type IN (
    'text', 'textarea', 'select', 'date', 'boolean', 'file', 'routing',
    'date_range', 'time', 'phone', 'currency', 'url'
  ));
