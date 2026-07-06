-- Soft-delete for placement_sessions.
-- A deleted board is hidden from normal view but not physically removed,
-- so it can be recovered via the Trash toggle in the placement list.
ALTER TABLE public.placement_sessions
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
