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

DROP POLICY IF EXISTS "placement_audit_log_school_isolation" ON public.placement_audit_log;
CREATE POLICY "placement_audit_log_school_isolation"
  ON public.placement_audit_log
  USING (school_id = (SELECT school_id FROM public.profiles WHERE id = auth.uid()))
  WITH CHECK (school_id = (SELECT school_id FROM public.profiles WHERE id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_placement_audit_log_session
  ON public.placement_audit_log (session_id, changed_at DESC);


-- ── 2. Session archiving ──────────────────────────────────────────────
ALTER TABLE public.placement_sessions
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;


-- ── 3. Flag soft-delete ───────────────────────────────────────────────
ALTER TABLE public.placement_flags
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
