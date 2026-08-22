-- ============================================================
-- Advisor: "Substitutes: read by school" re-evaluates auth.uid()
-- per row via the correlated profiles subquery. Same bare
-- auth.uid() re-evaluated-per-row bug as prior _rls_perf fixes.
-- All four substitutes policies share the identical pattern, so
-- fixing them together rather than waiting for the advisor to
-- flag insert/update/delete separately.
-- ============================================================

DROP POLICY IF EXISTS "Substitutes: read by school" ON public.substitutes;
CREATE POLICY "Substitutes: read by school" ON public.substitutes FOR SELECT USING (
  school_id = ( SELECT profiles.school_id FROM public.profiles
    WHERE profiles.user_id = (select auth.uid()) )
);

DROP POLICY IF EXISTS "Substitutes: insert for own school" ON public.substitutes;
CREATE POLICY "Substitutes: insert for own school" ON public.substitutes FOR INSERT WITH CHECK (
  school_id = ( SELECT profiles.school_id FROM public.profiles
    WHERE profiles.user_id = (select auth.uid()) )
);

DROP POLICY IF EXISTS "Substitutes: update for own school" ON public.substitutes;
CREATE POLICY "Substitutes: update for own school" ON public.substitutes FOR UPDATE USING (
  school_id = ( SELECT profiles.school_id FROM public.profiles
    WHERE profiles.user_id = (select auth.uid()) )
);

DROP POLICY IF EXISTS "Substitutes: delete for own school" ON public.substitutes;
CREATE POLICY "Substitutes: delete for own school" ON public.substitutes FOR DELETE USING (
  school_id = ( SELECT profiles.school_id FROM public.profiles
    WHERE profiles.user_id = (select auth.uid()) )
);
