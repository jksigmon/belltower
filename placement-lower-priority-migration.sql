-- ======================================================================
-- Placement module: lower-priority features migration
-- Adds: audit log table, session archiving, flag soft-delete
-- Run once in Supabase SQL editor.
-- ======================================================================

-- ── 1. Audit log ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.placement_audit_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid        NOT NULL REFERENCES public.placement_sessions(id) ON DELETE CASCADE,
  school_id      uuid        NOT NULL REFERENCES public.schools(id),
  student_id     uuid        NOT NULL,
  student_name   text        NOT NULL,
  from_teacher_id   uuid,
  from_teacher_name text,
  to_teacher_id     uuid,
  to_teacher_name   text,
  changed_by_id  uuid,
  changed_by_name text,
  changed_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.placement_audit_log ENABLE ROW LEVEL SECURITY;

-- Policies live in supabase/migrations/20260820000001_fix_placement_audit_log_rls.sql.
-- The policy that used to be defined here matched profiles on the wrong column
-- (profiles.id instead of profiles.user_id) and denied every read and write.
-- Run that migration after this script; until then the table is deny-all.

CREATE INDEX IF NOT EXISTS idx_placement_audit_log_session
  ON public.placement_audit_log (session_id, changed_at DESC);


-- ── 2. Session archiving ──────────────────────────────────────────────
ALTER TABLE public.placement_sessions
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;


-- ── 3. Flag soft-delete ───────────────────────────────────────────────
ALTER TABLE public.placement_flags
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
