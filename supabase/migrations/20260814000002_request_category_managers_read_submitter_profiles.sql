-- ======================================================================
-- Request Manager: let a category manager see who submitted a request.
--
-- staff_requests/staff_request_responses already let a category manager
-- read submissions for the categories they manage, but the submitter's
-- name/email come from an embedded profiles join, and profiles has no
-- SELECT policy covering "someone reading a colleague's row to review a
-- request they manage." Without this, the join comes back null and the
-- Request Manager UI shows "Unknown" as the submitter.
-- ======================================================================

CREATE POLICY "Category managers can read submitter profiles" ON public.profiles
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.staff_requests sr
      JOIN public.request_category_managers rcm ON rcm.category_id = sr.category_id
      JOIN public.profiles me ON me.id = rcm.profile_id
      WHERE sr.submitted_by = profiles.id
        AND me.user_id = auth.uid()
    )
  );
