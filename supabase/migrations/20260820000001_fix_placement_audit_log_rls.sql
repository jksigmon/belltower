-- placement_audit_log was missed by the August RLS consolidation pass
-- (20260804000002 / 20260804000003) and still carries the original policy from
-- placement-lower-priority-migration.sql:
--
--   USING      (school_id = (SELECT school_id FROM profiles WHERE id = auth.uid()))
--   WITH CHECK (school_id = (SELECT school_id FROM profiles WHERE id = auth.uid()))
--
-- profiles.id is the table's own gen_random_uuid() PK; the auth user is linked
-- via profiles.user_id. So the subquery returns NULL for every caller, the
-- comparison evaluates to NULL, and the policy denies. Elsewhere this same bug
-- was one arm of an OR (dead weight); here it is the only clause, so it is
-- fatal: every insert from logMoves() fails with 42501, and because the policy
-- carries no FOR clause it covers ALL commands, so the audit panel reads back
-- empty as well.
--
-- Split into read + write, matching the sibling placement tables. Write is
-- INSERT-only by design -- an audit log should not be updatable or deletable
-- from the client. FK cascade from placement_sessions is unaffected; Postgres
-- does not apply RLS to referential integrity actions.

DROP POLICY IF EXISTS "placement_audit_log_school_isolation" ON public.placement_audit_log;
DROP POLICY IF EXISTS "placement_audit_log_all" ON public.placement_audit_log;
DROP POLICY IF EXISTS "placement_audit_log_select" ON public.placement_audit_log;
DROP POLICY IF EXISTS "placement_audit_log_read" ON public.placement_audit_log;
DROP POLICY IF EXISTS "placement_audit_log_write" ON public.placement_audit_log;

CREATE POLICY placement_audit_log_read ON public.placement_audit_log FOR SELECT
  USING (school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1));

CREATE POLICY placement_audit_log_write ON public.placement_audit_log FOR INSERT
  WITH CHECK (
    school_id = (SELECT school_id FROM public.profiles WHERE user_id = auth.uid() LIMIT 1)
    AND (
      (SELECT is_superadmin FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
      OR (SELECT role FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = 'admin'
      OR (SELECT can_manage_placement FROM public.profiles WHERE user_id = auth.uid() LIMIT 1) = true
    )
  );
