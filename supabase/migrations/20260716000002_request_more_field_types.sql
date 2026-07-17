-- ============================================================
-- More request-form field types: date range, time, phone, currency
--
-- All four store their final human-readable string directly in
-- staff_request_responses.value (e.g. "Oct 1 – Oct 3, 2026",
-- "2:30 PM", "(919) 555-1234", "$25.00") — consistent with how
-- every other field type already works. No new columns needed;
-- downstream consumers (manager drawer, email template, history)
-- render value as plain text and need no per-type logic.
-- ============================================================

ALTER TABLE public.request_category_fields
  DROP CONSTRAINT IF EXISTS request_category_fields_field_type_check;
ALTER TABLE public.request_category_fields
  ADD CONSTRAINT request_category_fields_field_type_check
  CHECK (field_type IN (
    'text', 'textarea', 'select', 'date', 'boolean', 'file', 'routing',
    'date_range', 'time', 'phone', 'currency'
  ));
