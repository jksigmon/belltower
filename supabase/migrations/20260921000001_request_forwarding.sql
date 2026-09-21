-- ============================================================
-- Forward a request to an approved outside address
-- ============================================================
-- A manager who receives a request meant for someone else (a facilities
-- ticket that is really an IT issue) can forward it by email. Recipients
-- are limited to a saved list of destinations that form builders maintain,
-- so a manager can't send submission details to a mistyped or unapproved
-- address.
--
--   request_forward_destinations  the approved list (name + email), per school
--   request_forwards              a log of every forward that was sent
--
-- Sending happens in the forward_request edge function, which checks the
-- caller with can_action_request() and writes the log row with the service
-- role. Users have no insert/update/delete path into request_forwards.
-- ============================================================


-- ── Who may act on a request ────────────────────────────────
-- Mirrors sr_update from 20260902000001: a manager of the form, a
-- superadmin, or a school-wide reviewer (except on confidential forms).
-- SECURITY DEFINER so policies can call it without re-entering the RLS of
-- profiles / request_categories (the recursion class fixed in
-- 20260808000003 and 20260814000003).
CREATE OR REPLACE FUNCTION public.can_action_request(p_request_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff_requests sr
    JOIN public.profiles p ON p.user_id = p_user_id
    WHERE sr.id = p_request_id
      AND sr.school_id = p.school_id
      AND (
        p.is_superadmin
        OR EXISTS (
          SELECT 1 FROM public.request_category_managers rcm
          WHERE rcm.category_id = sr.category_id AND rcm.profile_id = p.id
        )
        OR (
          p.can_review_all_requests
          AND NOT COALESCE(
            (SELECT rc.is_confidential FROM public.request_categories rc WHERE rc.id = sr.category_id),
            false
          )
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.can_action_request(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.can_action_request(uuid, uuid) TO authenticated, service_role;


-- Anyone who can work the request queue in some capacity: enough to see the
-- list of destinations in the Forward picker.
CREATE OR REPLACE FUNCTION public.is_request_queue_user(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = p_user_id
      AND (
        p.is_superadmin
        OR p.can_manage_requests
        OR p.can_review_all_requests
        OR EXISTS (
          SELECT 1 FROM public.request_category_managers rcm WHERE rcm.profile_id = p.id
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_request_queue_user(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_request_queue_user(uuid) TO authenticated, service_role;


-- ── request_forward_destinations ────────────────────────────
CREATE TABLE IF NOT EXISTS public.request_forward_destinations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  email       text NOT NULL CHECK (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS request_forward_destinations_school_email_key
  ON public.request_forward_destinations (school_id, lower(email));

ALTER TABLE public.request_forward_destinations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rfd_select ON public.request_forward_destinations;
CREATE POLICY rfd_select ON public.request_forward_destinations FOR SELECT USING (
  school_id = (SELECT p.school_id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1)
  AND public.is_request_queue_user(auth.uid())
);

-- Same builder set as the form-config policies (20260903000002).
DROP POLICY IF EXISTS rfd_insert ON public.request_forward_destinations;
CREATE POLICY rfd_insert ON public.request_forward_destinations FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.is_superadmin OR p.can_manage_requests)
      AND p.school_id = request_forward_destinations.school_id
  )
);

DROP POLICY IF EXISTS rfd_update ON public.request_forward_destinations;
CREATE POLICY rfd_update ON public.request_forward_destinations FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.is_superadmin OR p.can_manage_requests)
      AND p.school_id = request_forward_destinations.school_id
  )
);

DROP POLICY IF EXISTS rfd_delete ON public.request_forward_destinations;
CREATE POLICY rfd_delete ON public.request_forward_destinations FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.is_superadmin OR p.can_manage_requests)
      AND p.school_id = request_forward_destinations.school_id
  )
);


-- ── request_forwards (log) ──────────────────────────────────
-- Name and email are copied onto the row so the history stays accurate if a
-- destination is later renamed, retargeted, or deleted.
CREATE TABLE IF NOT EXISTS public.request_forwards (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  request_id         uuid NOT NULL REFERENCES public.staff_requests(id) ON DELETE CASCADE,
  forwarded_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  destination_id     uuid REFERENCES public.request_forward_destinations(id) ON DELETE SET NULL,
  destination_name   text NOT NULL,
  destination_email  text NOT NULL,
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS request_forwards_request_idx
  ON public.request_forwards (request_id, created_at DESC);

ALTER TABLE public.request_forwards ENABLE ROW LEVEL SECURITY;

-- Read-only for users, and only for people who can act on the request. The
-- submitter is deliberately not included: the destination address is
-- internal. No insert/update/delete policies exist; the edge function
-- writes rows with the service role.
DROP POLICY IF EXISTS rf_select ON public.request_forwards;
CREATE POLICY rf_select ON public.request_forwards FOR SELECT USING (
  public.can_action_request(request_id, auth.uid())
);
