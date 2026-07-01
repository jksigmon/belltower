-- ============================================================
-- Submit leave on behalf of staff
-- Adds submitted_by column to pto_requests and
-- can_submit_on_behalf permission to profiles.
-- ============================================================

-- 1. Track who proxied the submission
ALTER TABLE public.pto_requests
  ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES public.employees(id);

-- 2. New permission flag
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_submit_on_behalf boolean DEFAULT false NOT NULL;

-- 3. RLS: allow INSERT for proxy submitters
--    The submitter must have can_submit_on_behalf + can_approve_pto,
--    and submitted_by must equal their own employee_id.
CREATE POLICY pto_requests_submit_on_behalf
  ON public.pto_requests
  FOR INSERT
  WITH CHECK (
    submitted_by IS NOT NULL
    AND submitted_by = (
      SELECT p.employee_id
      FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
      LIMIT 1
    )
    AND (
      SELECT p.can_submit_on_behalf AND p.can_approve_pto
      FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = pto_requests.school_id
        AND p.status = 'active'
      LIMIT 1
    ) = true
  );
