-- Add ON DELETE CASCADE to staff_request_responses.field_id so that
-- deleting a form field (during form rebuild on save) removes orphaned responses.
ALTER TABLE public.staff_request_responses
  DROP CONSTRAINT staff_request_responses_field_id_fkey;

ALTER TABLE public.staff_request_responses
  ADD CONSTRAINT staff_request_responses_field_id_fkey
    FOREIGN KEY (field_id)
    REFERENCES public.request_category_fields(id)
    ON DELETE CASCADE;
