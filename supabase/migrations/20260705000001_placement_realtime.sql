-- ============================================================
-- Real-time collaboration on class placement boards
-- Adds the placement tables to the Supabase Realtime publication
-- so multiple users can see each other's changes live.
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.placement_assignments;
ALTER PUBLICATION supabase_realtime ADD TABLE public.placement_session_teachers;
