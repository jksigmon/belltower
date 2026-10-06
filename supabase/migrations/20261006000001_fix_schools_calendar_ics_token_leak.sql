-- schools.calendar_ics_token is the sole auth mechanism for the public PTO
-- calendar ICS feed (pto_calendar_ics edge function, app/pto.js). It was
-- readable by anyone, including fully unauthenticated requests: "schools"
-- has a blanket "Authenticated users can read schools" SELECT policy
-- (USING (true)), and separately a "schools_anon_read" policy granting the
-- same blanket read to the anon role -- not mentioned anywhere in version
-- control, and not covered by the threat model in 20260814000001, which
-- only accounted for "any authenticated user at any school".
--
-- 20260814000001 already added get_calendar_ics_link() /
-- regenerate_calendar_ics_token() as the safe, SECURITY DEFINER way to
-- read/rotate this token -- they run with row_security off, as the function
-- owner (postgres), so they're unaffected by anything below regardless of
-- what anon/authenticated can select directly.
--
-- Fix, in two parts:
--
-- 1. Drop schools_anon_read outright. Grepping the whole repo (app/*.js,
--    every *.html) turns up no client-side query against `schools` made by
--    an anon-role (fully unauthenticated) session -- every call site either
--    requires an existing login (admin.*, calendar-strip.js, setup.js) or,
--    for the one pre-login case (auth/callback.html's email-domain lookup
--    on first sign-in), runs as an authenticated-but-no-profile-yet
--    session, which is the `authenticated` role, not `anon`. This policy
--    has no legitimate caller and is strictly worse than the authenticated
--    one. (With this policy gone, `anon` has no permissive SELECT policy
--    left on `schools` at all -- schools_read_my_school requires an active
--    profile row, which auth.uid() can't produce for an anon session -- so
--    RLS alone now blocks every row for anon, independent of part 2.)
--
-- 2. For `authenticated`, "Authenticated users can read schools" is
--    intentionally left in place as a ROW-level policy: auth/callback.html
--    depends on it to look up a brand-new user's school by email_domain
--    before any `profiles` row exists for them (schools_read_my_school
--    requires an existing active profile, which a first-time signup
--    doesn't have yet). Dropping it would break onboarding for every new
--    user. Instead, calendar_ics_token is hidden at the COLUMN-privilege
--    level, which is a separate mechanism from RLS entirely.
--
--    IMPORTANT, and the reason this is split into two statements rather
--    than one column-level REVOKE: a role's table-level SELECT privilege
--    (both anon and authenticated hold "GRANT ALL ON TABLE schools" from
--    the original schema dump) authorizes selecting *every* column on its
--    own, completely independent of any column-level REVOKE targeting one
--    column -- a column-level REVOKE only has any effect on a role that
--    lacks the table-level privilege in the first place. So the table-level
--    SELECT has to be revoked first, and then re-granted column-by-column
--    for every column except calendar_ics_token, or the token stays
--    reachable via the table-level grant regardless of the column REVOKE.
--    (Caught by actually testing `SET ROLE authenticated; SELECT
--    calendar_ics_token FROM schools;` against a column-REVOKE-only
--    version of this migration on belltower-dev before this version ran
--    anywhere else -- it returned the token. This version was verified the
--    same way to return `permission denied for table schools` instead,
--    while `SELECT id, name FROM schools` as authenticated still succeeds.)
--
--    No existing query is affected: grep confirms nothing in app/*.js or
--    auth/callback.html ever selects calendar_ics_token directly, and
--    nothing calls bare `.select()` (which would expand to `*` and fail
--    against a table with column-level-only grants) against `schools`.
--
--    Maintenance note for later: a future column added to `schools` is NOT
--    selectable by anon/authenticated until it's added to the GRANT SELECT
--    list below -- this is the tradeoff for this table defaulting closed
--    instead of open. Whoever adds a new non-sensitive column to `schools`
--    needs to also add it here, or the app will silently fail to read it.

DROP POLICY IF EXISTS "schools_anon_read" ON public.schools;

REVOKE SELECT ON public.schools FROM anon, authenticated;
GRANT SELECT (
  id, name, short_name, created_at, email_domain, deletable, logo_url,
  grade_levels, terminal_grade, uses_homerooms, require_mvr_for_drivers,
  pto_from_email, pto_reply_to, weather_lat, weather_lon, phone, address,
  city, state, zip, timezone, notifications_from_email,
  notifications_reply_to, calendar_pdf_url, current_academic_year
) ON public.schools TO anon, authenticated;
