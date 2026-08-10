-- Lets each request category customize the wording of its "completed"
-- status (e.g. "Approved" for a Purchase Request form vs "Resolved" for
-- Maintenance), and optionally opt in to a "denied" status for forms that
-- are genuinely approve/deny (Field Trips, Activity Approval) rather than
-- just resolve/no-resolve (Maintenance, Feedback).

ALTER TABLE public.request_categories
  ADD COLUMN resolved_label text,
  ADD COLUMN allow_denial    boolean NOT NULL DEFAULT false,
  ADD COLUMN denied_label    text;

ALTER TABLE public.staff_requests
  DROP CONSTRAINT staff_requests_status_check;

ALTER TABLE public.staff_requests
  ADD CONSTRAINT staff_requests_status_check
    CHECK (status IN ('pending', 'in_review', 'resolved', 'denied'));
