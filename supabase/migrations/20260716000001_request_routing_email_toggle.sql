-- ============================================================
-- Staff request routing + per-form email toggle
--
-- 1. New 'routing' field type: a form may carry one dropdown whose
--    options each map a display label to one of the form's managers
--    (options jsonb: [{ "label": "K-5", "manager_id": "<profile uuid>" }]).
-- 2. staff_requests.assigned_manager_id: which manager a submission
--    was routed to. NULL = broadcast to all managers (exactly the
--    pre-existing behavior, so no backfill is needed).
-- 3. request_categories.notify_managers: per-form switch for manager
--    notification emails. Submitter confirmations always send.
-- ============================================================

-- 'routing' joins the allowed field types
ALTER TABLE public.request_category_fields
  DROP CONSTRAINT IF EXISTS request_category_fields_field_type_check;
ALTER TABLE public.request_category_fields
  ADD CONSTRAINT request_category_fields_field_type_check
  CHECK (field_type IN ('text', 'textarea', 'select', 'date', 'boolean', 'file', 'routing'));

-- Routed recipient (NULL = all managers)
ALTER TABLE public.staff_requests
  ADD COLUMN IF NOT EXISTS assigned_manager_id uuid REFERENCES public.profiles(id);

-- Per-form manager email switch
ALTER TABLE public.request_categories
  ADD COLUMN IF NOT EXISTS notify_managers boolean NOT NULL DEFAULT true;
