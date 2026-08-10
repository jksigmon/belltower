-- Lets a request form (request_categories row) be restricted to a specific
-- list of people instead of visible to the whole school — e.g. a Purchase
-- Request form that only a handful of budget owners should see or submit.
--
-- Mirrors the existing request_category_managers pattern: a join table plus
-- an is_restricted flag. Enforced in RLS (not just hidden in the UI) so a
-- restricted form's rows can't be read or submitted-to by anyone outside
-- the allowlist, admins, or the form's own managers, even via direct API
-- calls that bypass the staff request page.
--
-- NOTE: the manager/visibility membership checks below go through
-- SECURITY DEFINER helper functions rather than a raw correlated EXISTS
-- against request_category_managers / request_category_visibility. Those
-- two tables' own INSERT/DELETE policies read request_categories (to check
-- the category's school_id) — if request_categories' own SELECT policy
-- read them back directly, that's a circular RLS dependency between the
-- two tables, which Postgres refuses to evaluate ("infinite recursion
-- detected in policy for relation ..."). The helper functions run with the
-- privileges of their (superuser) owner and bypass RLS internally, so
-- reading through them doesn't re-enter the policy chain.

ALTER TABLE public.request_categories
  ADD COLUMN IF NOT EXISTS is_restricted boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.request_category_visibility (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  category_id uuid        NOT NULL REFERENCES public.request_categories(id) ON DELETE CASCADE,
  profile_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  added_by    uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT request_category_visibility_pkey PRIMARY KEY (id),
  CONSTRAINT request_category_visibility_unique UNIQUE (category_id, profile_id)
);

ALTER TABLE public.request_category_visibility ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS request_category_visibility_category_id_idx ON public.request_category_visibility(category_id);
CREATE INDEX IF NOT EXISTS request_category_visibility_profile_id_idx ON public.request_category_visibility(profile_id);

-- ── RLS-bypassing membership checks (breaks the recursion described above) ──

CREATE OR REPLACE FUNCTION public.is_request_category_manager(p_category_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.request_category_managers rcm
    JOIN public.profiles p ON p.id = rcm.profile_id
    WHERE rcm.category_id = p_category_id AND p.user_id = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_request_category_visible_to(p_category_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.request_category_visibility rcv
    JOIN public.profiles p ON p.id = rcv.profile_id
    WHERE rcv.category_id = p_category_id AND p.user_id = p_user_id
  );
$$;

REVOKE ALL ON FUNCTION public.is_request_category_manager(uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION public.is_request_category_visible_to(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_request_category_manager(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_request_category_visible_to(uuid, uuid) TO authenticated;

-- Admins see all rows; a listed person can see their own entry
DROP POLICY IF EXISTS rcv_select ON public.request_category_visibility;
CREATE POLICY rcv_select ON public.request_category_visibility
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.is_superadmin
          OR p.can_access_admin
          OR request_category_visibility.profile_id = p.id
        )
    )
  );

DROP POLICY IF EXISTS rcv_insert ON public.request_category_visibility;
CREATE POLICY rcv_insert ON public.request_category_visibility
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.request_categories rc
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE rc.id = request_category_visibility.category_id
        AND rc.school_id = p.school_id
        AND (p.is_superadmin OR p.can_access_admin)
    )
  );

DROP POLICY IF EXISTS rcv_delete ON public.request_category_visibility;
CREATE POLICY rcv_delete ON public.request_category_visibility
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.request_categories rc
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE rc.id = request_category_visibility.category_id
        AND rc.school_id = p.school_id
        AND (p.is_superadmin OR p.can_access_admin)
    )
  );

-- Extend request_categories read access: a restricted form is only
-- readable by admins, its own managers, and profiles on its visibility list.
DROP POLICY IF EXISTS rc_select ON public.request_categories;
CREATE POLICY rc_select ON public.request_categories
  FOR SELECT USING (
    school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    AND (
      is_restricted = false
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND (p.is_superadmin OR p.can_access_admin)
      )
      OR public.is_request_category_manager(request_categories.id, auth.uid())
      OR public.is_request_category_visible_to(request_categories.id, auth.uid())
    )
  );

-- Close the direct-insert bypass: submitting to a restricted category's id
-- directly (without it ever being visible in the UI) must be blocked too.
-- Also scopes the category to the submitter's own school (the prior version
-- of this policy never checked that at all).
DROP POLICY IF EXISTS sr_insert ON public.staff_requests;
CREATE POLICY sr_insert ON public.staff_requests
  FOR INSERT WITH CHECK (
    school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    AND submitted_by = (SELECT id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    AND EXISTS (
      SELECT 1 FROM public.request_categories rc
      WHERE rc.id = staff_requests.category_id
        AND rc.school_id = staff_requests.school_id
        AND (
          rc.is_restricted = false
          OR EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = auth.uid() AND (p.is_superadmin OR p.can_access_admin)
          )
          OR public.is_request_category_manager(rc.id, auth.uid())
          OR public.is_request_category_visible_to(rc.id, auth.uid())
        )
    )
  );
