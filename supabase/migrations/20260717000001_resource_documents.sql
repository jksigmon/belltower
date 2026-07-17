-- ============================================================
-- Resource Documents
-- Read-only staff quick link to admin-managed PDFs (handbooks,
-- forms, procedures). Staff view/print via a signed URL generated
-- at view time; the storage object itself is never exposed as a
-- permanent public link, and only one file exists per document
-- ("Replace File" overwrites in place) so there's never a stale
-- copy to accidentally view.
-- ============================================================

-- New permission (must exist before the policies below reference it)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_resource_docs boolean NOT NULL DEFAULT false;

CREATE TABLE public.resource_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  title              text NOT NULL,
  file_path          text NOT NULL,
  original_filename  text,
  uploaded_by        uuid REFERENCES public.profiles(id),
  -- Denormalized: profiles SELECT requires can_manage_access to read a
  -- colleague's row (can_manage_resource_docs alone doesn't grant that),
  -- so a join would show NULL for anyone else's uploads. Same pattern
  -- as placement_session_notes.author_name.
  uploaded_by_name   text,
  sort_order         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_resource_documents_school ON public.resource_documents (school_id, sort_order);

ALTER TABLE public.resource_documents ENABLE ROW LEVEL SECURITY;

-- Read: any active, login-enabled staff member at the same school
CREATE POLICY resource_documents_read ON public.resource_documents
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND p.can_login = true
        AND p.school_id = resource_documents.school_id
    )
  );

-- Write (insert/update/delete): superadmin, admin role, or the new
-- can_manage_resource_docs permission — scoped to their own school
CREATE POLICY resource_documents_write ON public.resource_documents
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id = resource_documents.school_id
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
          OR (p.school_id = resource_documents.school_id
              AND (p.role = 'admin' OR p.can_manage_resource_docs = true))
        )
    )
  );

-- ============================================================
-- Storage: private 'resource-docs' bucket
--
-- Object path convention: `${school_id}/${document_id}.pdf`
-- NOTE: this repo has no other storage.objects RLS policies
-- committed anywhere — the existing license-files / school-assets /
-- request-attachments buckets appear to have been configured by
-- hand in the Supabase dashboard. This is a best-effort policy
-- written the same way those likely are; please verify in the
-- dashboard's Storage section that upload/view/delete actually
-- behave as expected before relying on it.
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('resource-docs', 'resource-docs', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "resource_docs_read" ON storage.objects;
CREATE POLICY "resource_docs_read" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'resource-docs'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND p.can_login = true
        AND p.school_id::text = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "resource_docs_write" ON storage.objects;
CREATE POLICY "resource_docs_write" ON storage.objects
  FOR ALL USING (
    bucket_id = 'resource-docs'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id::text = (storage.foldername(name))[1]
              AND (p.role = 'admin' OR p.can_manage_resource_docs = true))
        )
    )
  )
  WITH CHECK (
    bucket_id = 'resource-docs'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.status = 'active'
        AND (
          p.is_superadmin = true
          OR (p.school_id::text = (storage.foldername(name))[1]
              AND (p.role = 'admin' OR p.can_manage_resource_docs = true))
        )
    )
  );
