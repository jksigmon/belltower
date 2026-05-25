-- ======================================================================
-- Staff Requests Module
--
-- Creates:
--   1. request_categories        — configurable form types per school
--   2. request_category_fields   — dynamic form fields per category
--   3. request_category_managers — per-category manager assignments
--   4. staff_requests            — staff submissions
--   5. staff_request_responses   — per-field answers per submission
-- ======================================================================


-- ── 1. request_categories ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.request_categories (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  school_id   uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  description text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_by  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT request_categories_pkey PRIMARY KEY (id)
);

ALTER TABLE public.request_categories ENABLE ROW LEVEL SECURITY;
CREATE INDEX ON public.request_categories(school_id);

-- Any authenticated member of the same school can read (needed to render submission form)
CREATE POLICY rc_select ON public.request_categories
  FOR SELECT USING (
    school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
  );

CREATE POLICY rc_insert ON public.request_categories
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (p.is_superadmin OR p.can_access_admin)
        AND p.school_id = request_categories.school_id
    )
  );

CREATE POLICY rc_update ON public.request_categories
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (p.is_superadmin OR p.can_access_admin)
        AND p.school_id = request_categories.school_id
    )
  );

CREATE POLICY rc_delete ON public.request_categories
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (p.is_superadmin OR p.can_access_admin)
        AND p.school_id = request_categories.school_id
    )
  );


-- ── 2. request_category_fields ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.request_category_fields (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  category_id uuid        NOT NULL REFERENCES public.request_categories(id) ON DELETE CASCADE,
  label       text        NOT NULL,
  field_type  text        NOT NULL CHECK (field_type IN ('text', 'textarea', 'select', 'date', 'boolean')),
  options     jsonb,       -- array of strings for 'select' type
  is_required boolean     NOT NULL DEFAULT false,
  sort_order  integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT request_category_fields_pkey PRIMARY KEY (id)
);

ALTER TABLE public.request_category_fields ENABLE ROW LEVEL SECURITY;
CREATE INDEX ON public.request_category_fields(category_id);

CREATE POLICY rcf_select ON public.request_category_fields
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.request_categories rc
      WHERE rc.id = request_category_fields.category_id
        AND rc.school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    )
  );

CREATE POLICY rcf_insert ON public.request_category_fields
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.request_categories rc
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE rc.id = request_category_fields.category_id
        AND rc.school_id = p.school_id
        AND (p.is_superadmin OR p.can_access_admin)
    )
  );

CREATE POLICY rcf_update ON public.request_category_fields
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.request_categories rc
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE rc.id = request_category_fields.category_id
        AND rc.school_id = p.school_id
        AND (p.is_superadmin OR p.can_access_admin)
    )
  );

CREATE POLICY rcf_delete ON public.request_category_fields
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.request_categories rc
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE rc.id = request_category_fields.category_id
        AND rc.school_id = p.school_id
        AND (p.is_superadmin OR p.can_access_admin)
    )
  );


-- ── 3. request_category_managers ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.request_category_managers (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  category_id uuid        NOT NULL REFERENCES public.request_categories(id) ON DELETE CASCADE,
  profile_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  added_by    uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT request_category_managers_pkey PRIMARY KEY (id),
  CONSTRAINT request_category_managers_unique UNIQUE (category_id, profile_id)
);

ALTER TABLE public.request_category_managers ENABLE ROW LEVEL SECURITY;
CREATE INDEX ON public.request_category_managers(category_id);
CREATE INDEX ON public.request_category_managers(profile_id);

-- Admins see all rows; managers see their own entry
CREATE POLICY rcm_select ON public.request_category_managers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.is_superadmin
          OR p.can_access_admin
          OR request_category_managers.profile_id = p.id
        )
    )
  );

CREATE POLICY rcm_insert ON public.request_category_managers
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.request_categories rc
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE rc.id = request_category_managers.category_id
        AND rc.school_id = p.school_id
        AND (p.is_superadmin OR p.can_access_admin)
    )
  );

CREATE POLICY rcm_delete ON public.request_category_managers
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.request_categories rc
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE rc.id = request_category_managers.category_id
        AND rc.school_id = p.school_id
        AND (p.is_superadmin OR p.can_access_admin)
    )
  );


-- ── 4. staff_requests ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.staff_requests (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  school_id     uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  category_id   uuid        NOT NULL REFERENCES public.request_categories(id),
  submitted_by  uuid        NOT NULL REFERENCES public.profiles(id),
  status        text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'in_review', 'resolved')),
  manager_notes text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_requests_pkey PRIMARY KEY (id)
);

ALTER TABLE public.staff_requests ENABLE ROW LEVEL SECURITY;
CREATE INDEX ON public.staff_requests(school_id, created_at DESC);
CREATE INDEX ON public.staff_requests(category_id);
CREATE INDEX ON public.staff_requests(submitted_by);

CREATE POLICY sr_select ON public.staff_requests
  FOR SELECT USING (
    school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    AND (
      -- submitter always sees their own
      submitted_by = (SELECT id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
      -- admins see all
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND (p.is_superadmin OR p.can_access_admin)
      )
      -- category managers see submissions for their categories
      OR EXISTS (
        SELECT 1 FROM public.request_category_managers rcm
        JOIN public.profiles p ON p.id = rcm.profile_id
        WHERE rcm.category_id = staff_requests.category_id AND p.user_id = auth.uid()
      )
    )
  );

CREATE POLICY sr_insert ON public.staff_requests
  FOR INSERT WITH CHECK (
    school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    AND submitted_by = (SELECT id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
  );

-- Managers and admins can update status + notes; submitter cannot self-update status
CREATE POLICY sr_update ON public.staff_requests
  FOR UPDATE USING (
    school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND (p.is_superadmin OR p.can_access_admin)
      )
      OR EXISTS (
        SELECT 1 FROM public.request_category_managers rcm
        JOIN public.profiles p ON p.id = rcm.profile_id
        WHERE rcm.category_id = staff_requests.category_id AND p.user_id = auth.uid()
      )
    )
  );


-- ── 5. staff_request_responses ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.staff_request_responses (
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.staff_requests(id) ON DELETE CASCADE,
  field_id   uuid NOT NULL REFERENCES public.request_category_fields(id),
  value      text,
  CONSTRAINT staff_request_responses_pkey PRIMARY KEY (id),
  CONSTRAINT staff_request_responses_unique UNIQUE (request_id, field_id)
);

ALTER TABLE public.staff_request_responses ENABLE ROW LEVEL SECURITY;
CREATE INDEX ON public.staff_request_responses(request_id);

-- Access mirrors the parent staff_request visibility rules
CREATE POLICY srr_select ON public.staff_request_responses
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.staff_requests sr
      WHERE sr.id = staff_request_responses.request_id
        AND sr.school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
        AND (
          sr.submitted_by = (SELECT id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
          OR EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = auth.uid() AND (p.is_superadmin OR p.can_access_admin)
          )
          OR EXISTS (
            SELECT 1 FROM public.request_category_managers rcm
            JOIN public.profiles p ON p.id = rcm.profile_id
            WHERE rcm.category_id = sr.category_id AND p.user_id = auth.uid()
          )
        )
    )
  );

-- Only the submitter can insert responses at submission time
CREATE POLICY srr_insert ON public.staff_request_responses
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.staff_requests sr
      WHERE sr.id = staff_request_responses.request_id
        AND sr.submitted_by = (SELECT id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    )
  );
