-- ============================================================
-- Placement board notes
-- Free-form, attributed notes on a placement session: pairing
-- conflicts, parent requests, teacher input. Discrete rows (not
-- one shared blob) so simultaneous collaborators never clobber
-- each other and every note has an author.
-- ============================================================

CREATE TABLE public.placement_session_notes (
  id          uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES public.placement_sessions(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Denormalized: profiles SELECT is self-only under RLS, so an embed
  -- can't resolve colleagues' names. Captured at insert time.
  author_name text NOT NULL DEFAULT '',
  body        text NOT NULL,
  created_at  timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX idx_placement_notes_session
  ON public.placement_session_notes (session_id, created_at);

ALTER TABLE public.placement_session_notes ENABLE ROW LEVEL SECURITY;

-- Read: anyone in the session's school (mirrors placement_session_teachers)
CREATE POLICY placement_session_notes_read ON public.placement_session_notes
  FOR SELECT USING (
    session_id IN (
      SELECT id FROM public.placement_sessions
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    )
  );

-- Insert: anyone who can open the board (superadmin / admin /
-- can_manage_placement), and only as themselves.
CREATE POLICY placement_session_notes_insert ON public.placement_session_notes
  FOR INSERT WITH CHECK (
    session_id IN (
      SELECT id FROM public.placement_sessions
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    )
    AND author_id = (SELECT id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    AND (
      (SELECT is_superadmin FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
      OR (SELECT role FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = 'admin'
      OR (SELECT can_manage_placement FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
    )
  );

-- Delete: your own notes; admins and superadmins can remove any.
CREATE POLICY placement_session_notes_delete ON public.placement_session_notes
  FOR DELETE USING (
    session_id IN (
      SELECT id FROM public.placement_sessions
      WHERE school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    )
    AND (
      author_id = (SELECT id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
      OR (SELECT is_superadmin FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
      OR (SELECT role FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = 'admin'
    )
  );

-- Live sync: notes appear instantly for everyone viewing the board
ALTER PUBLICATION supabase_realtime ADD TABLE public.placement_session_notes;
