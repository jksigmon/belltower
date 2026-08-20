-- Adds a "completed" status to staff_requests, distinct from "resolved"
-- (whose label a category can customize to "Approved"). This lets the
-- person processing a request (e.g. Purchase Requests) track which
-- approved items have actually been ordered/paid vs. still pending action,
-- without changing the meaning of any existing status value.

ALTER TABLE public.staff_requests
  DROP CONSTRAINT staff_requests_status_check;

ALTER TABLE public.staff_requests
  ADD CONSTRAINT staff_requests_status_check
    CHECK (status IN ('pending', 'in_review', 'resolved', 'denied', 'completed'));
