-- ============================================================
-- Operations Manual: categories + per-teacher bookmarks
--
-- Two additions to the resource-documents module:
--
--   1. Admin-managed categories (Schedules, Policies, Maps, ...)
--      that documents can be filed under and filtered by. One
--      category per document -- a plain FK, not a join table, so
--      the staff-side sidebar counts sum cleanly to the total.
--
--   2. Per-teacher bookmarks ("pinned" documents), shown in a
--      strip at the top of the staff Resources page.
--
-- Note the ON DELETE behavior, which is doing real work here:
--   * category_id  ON DELETE SET NULL -- deleting a category must
--     never delete documents; they fall back to "Uncategorized".
--   * document_id  ON DELETE CASCADE  -- when an admin deletes a
--     document, every teacher's pin to it disappears on its own.
--     This is the whole "removed documents shouldn't linger in
--     someone's pinned list" requirement, handled by the database
--     rather than by cleanup code that can be forgotten.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ── 1. Categories ───────────────────────────────────────────
-- Modeled on public.request_categories (20260525000000), which is
-- the established per-school configurable-list pattern in this repo.

CREATE TABLE IF NOT EXISTS public.resource_document_categories (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  -- Chip color on the staff/admin cards. Nullable: the UI falls back to a
  -- deterministic palette pick keyed off the category id when unset, so a
  -- school that never touches colors still gets a sensible varied look.
  color       text,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_by  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resource_doc_categories_school
  ON public.resource_document_categories (school_id, sort_order);

-- Case-insensitive uniqueness per school: "Schedules" and "schedules"
-- would otherwise both appear in the sidebar as separate buckets.
CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_doc_categories_school_name
  ON public.resource_document_categories (school_id, lower(name));

ALTER TABLE public.resource_document_categories ENABLE ROW LEVEL SECURITY;

-- Read: any active, login-enabled staff member at the same school.
-- Must match resource_documents_read exactly -- the staff page embeds
-- the category via a PostgREST join, so a narrower policy here would
-- silently render every category chip as null.
DROP POLICY IF EXISTS resource_doc_categories_read ON public.resource_document_categories;
CREATE POLICY resource_doc_categories_read ON public.resource_document_categories
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND p.can_login = true
        AND p.school_id = resource_document_categories.school_id
    )
  );

-- Write: superadmin, admin role, or can_manage_resource_docs --
-- the same set that may manage the documents themselves.
DROP POLICY IF EXISTS resource_doc_categories_write ON public.resource_document_categories;
CREATE POLICY resource_doc_categories_write ON public.resource_document_categories
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = resource_document_categories.school_id
              AND (p.role = 'admin' OR p.can_manage_resource_docs = true))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = resource_document_categories.school_id
              AND (p.role = 'admin' OR p.can_manage_resource_docs = true))
        )
    )
  );


-- ── 2. Document -> category ─────────────────────────────────

ALTER TABLE public.resource_documents
  ADD COLUMN IF NOT EXISTS category_id uuid
    REFERENCES public.resource_document_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_resource_documents_category
  ON public.resource_documents (category_id);


-- ── 3. Per-teacher bookmarks ────────────────────────────────

-- Re-declared defensively so this migration is self-contained: the
-- bookmark policies below depend on it, and it was introduced in a
-- same-day hotfix (20260814000003). SECURITY DEFINER with row_security
-- off, so referencing it from a policy can't re-enter RLS on profiles
-- -- the recursion trap this repo has now hit twice (20260808000003,
-- 20260814000003). Do not inline a "SELECT id FROM profiles" here.
CREATE OR REPLACE FUNCTION public.current_user_profile_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT id
  FROM public.profiles
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.current_user_profile_id() FROM public;
GRANT EXECUTE ON FUNCTION public.current_user_profile_id() TO authenticated;

CREATE TABLE IF NOT EXISTS public.resource_document_bookmarks (
  profile_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  document_id uuid        NOT NULL REFERENCES public.resource_documents(id) ON DELETE CASCADE,
  -- Lets a teacher reorder their own pinned strip ("Manage Pinned").
  sort_order  integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, document_id)
);

-- The PK already covers (profile_id, ...) for the "my bookmarks" lookup.
-- This one covers the reverse direction, used by the cascade on document
-- delete and by any future "how many people pinned this?" admin readout.
CREATE INDEX IF NOT EXISTS idx_resource_doc_bookmarks_document
  ON public.resource_document_bookmarks (document_id);

ALTER TABLE public.resource_document_bookmarks ENABLE ROW LEVEL SECURITY;

-- A teacher may only ever see or modify their own bookmarks. There is
-- deliberately no admin-visibility policy: what someone pins is a
-- personal convenience, not something the school needs to audit.
--
-- No school_id column and no school scoping needed -- document_id FKs
-- into resource_documents, whose own RLS is already school-scoped, so a
-- bookmark can't be created against another school's document.
DROP POLICY IF EXISTS resource_doc_bookmarks_own ON public.resource_document_bookmarks;
CREATE POLICY resource_doc_bookmarks_own ON public.resource_document_bookmarks
  FOR ALL USING (
    profile_id = public.current_user_profile_id()
  )
  WITH CHECK (
    profile_id = public.current_user_profile_id()
  );
