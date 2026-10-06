# Belltower Platform Audit

_Audit date: 2026-09-30. Read-only review of the codebase at the current `main` branch state (schema.sql last dumped 2026-08-24; migrations current through 2026-09-29). No code was changed as part of this audit._

## Top 5 things to fix first

1. **[Critical]** `schools.calendar_ics_token` is readable by *anyone, including unauthenticated users* via a blanket `USING (true)` SELECT policy (one of them granted to the `anon` role). This defeats the token's entire purpose and lets anyone harvest every school's private PTO calendar feed. See Security §1.
2. **[High]** `request-attachments` storage bucket is fully public with no expiry or revocation, the one exception to an otherwise-consistent "private bucket + signed URL" pattern used everywhere else in the app. Any leaked link is permanent, unauthenticated access to whatever staff attached to a Requests-module submission. See Security §3.
3. **[High]** `pto_calendar_ics` is fetched by external calendar apps with no Authorization header, but it is *not* declared `verify_jwt = false` in `supabase/config.toml` the way `pto_decision_handler` is. A routine redeploy will silently 401 every subscribed calendar across every school — this is the exact "verify_jwt gotcha" already known to bite this project, just on a different function. See Security §2.
4. **[High]** `bulk_upload_commit` inserts/updates one row at a time in a sequential loop for every entity type (Families, Bus Groups, Students, Guardians, Staff) instead of batching, unlike its sibling `bulk_upload_preview` and `sync_infinite_campus`, which already batch. A large back-to-school import risks edge-function timeouts. See Performance §1.
5. **[High]** No backup strategy exists independent of Supabase's own platform backups: no object versioning on any bucket, no scheduled export job, no documented restore procedure, and `bulk_upload_rollback` hard-deletes rows with no snapshot. A vendor-level incident or a bad rollback has no independent recovery path. See Storage §1–2.

---

## 1. Security red flags

### [Critical] `schools` table leaks `calendar_ics_token` to unauthenticated users
**File:** `schema.sql:6858` (`"Authenticated users can read schools" ... USING (true)`), `schema.sql:9370` (`"schools_anon_read" ... TO "anon" USING (true)`), `schema.sql:9386` (`"schools_read_my_school"`, correctly scoped but dead), column at `schema.sql:3028`.

`schools` has three overlapping SELECT policies. Postgres RLS ORs all applicable permissive policies together, so the two `USING (true)` policies (one for `authenticated`, one for `anon`) make the properly-scoped `schools_read_my_school` policy irrelevant. Because RLS is row-level, not column-level, this means literal anonymous requests can `select('*')` (or specifically `select('calendar_ics_token')`) from `schools` and get every school's row, including `calendar_ics_token` — the secret used by `pto_calendar_ics` as the *sole* authentication for reading a school's approved-leave calendar feed (see `app/pto.js:244-245`, `supabase/functions/pto_calendar_ics/index.ts:64-71`).

The developers were aware of exactly this risk: `supabase/migrations/20260814000001_calendar_ics_link_functions.sql` explicitly says *"schools has a blanket SELECT RLS policy ... so a raw client-side select of calendar_ics_token would risk exposing one school's token to any authenticated user at any school. These SECURITY DEFINER functions avoid that entirely."* They built `get_calendar_ics_link()` / `regenerate_calendar_ics_token()` as safe accessors — but never revoked the underlying column-level SELECT privilege on `schools.calendar_ics_token`, so the raw path they identified as dangerous is still wide open, and the `anon`-role policy (added separately, not even mentioned in that migration's threat model, and not tracked in any migration file) makes it worse than "any authenticated user" — it's "anyone on the internet."

**Why it matters:** any script kiddie can enumerate every Belltower school's calendar feed token with one unauthenticated REST call and read every school's approved PTO/leave events indefinitely (tokens don't expire and this bypasses `regenerate_calendar_ics_token()`'s intended rotation-on-suspicion flow, since a leaked token via this path wouldn't even be noticed as "leaked").

**Fix:** `REVOKE SELECT (calendar_ics_token) ON public.schools FROM anon, authenticated;` and drop the two `USING (true)` SELECT policies, keeping only the school-scoped one plus the SECURITY DEFINER functions for the ICS-link use case.

---

### [High] `pto_calendar_ics` not declared `verify_jwt = false`, unlike its sibling `pto_decision_handler`
**Files:** `supabase/config.toml` (only entry: `[functions.pto_decision_handler] verify_jwt = false`), `app/pto.js:244-245`, `supabase/functions/pto_calendar_ics/index.ts`.

`pto_calendar_ics` is designed to be pasted into Google Calendar / Outlook as a raw subscription URL (`${SUPABASE_URL}/functions/v1/pto_calendar_ics?school_id=...&token=...`). Third-party calendar software fetches this URL directly with no `Authorization` header — the same situation that required `pto_decision_handler` to be explicitly exempted from the Supabase gateway's JWT check. `pto_calendar_ics` has no such exemption recorded anywhere in version control.

**Why it matters:** this project has a documented history of the verify_jwt gateway setting silently resetting to "on" after a plain `supabase functions deploy`. If that happens to `pto_calendar_ics` (which isn't protected by an explicit `config.toml` entry the way `pto_decision_handler` is), every school's subscribed calendar breaks with a 401 and nothing in the codebase would explain why — the exact failure mode this project has hit before.

**Fix:** add `[functions.pto_calendar_ics]\nverify_jwt = false` to `supabase/config.toml`, and confirm in the live dashboard that it currently matches (it may already be set there and just undocumented — worth verifying either way).

---

### [High] `request-attachments` storage bucket is public with no expiry, the one exception to an otherwise-private pattern
**Files:** `supabase/migrations/20260528000001_request_attachments_bucket.sql:1-25`, `supabase/migrations/20260528000003_request_attachments_make_public.sql`, `app/requests.js:379-391`.

The bucket was created with `public = true` and a `CREATE POLICY "request_attachments_read" ON storage.objects FOR SELECT TO public USING (bucket_id = 'request-attachments')`. Any file a staff member attaches to a Requests-module submission (file-field type, added in `20260528000000_requests_add_file_field_type.sql`) is reachable by anyone with the URL, forever, with zero authentication. The object path is `${school_id}/${request_id}/${field_id}.${ext}` (`app/requests.js:380`) — all UUIDs, so it isn't enumerable — but the URL itself gets emailed out verbatim by `forward_request` (per CLAUDE.md, "email a request's full submission to an admin-approved destination"), so any forwarded email, browser history entry, or copy-pasted link is a permanent, unrevokable credential.

Every other file-bearing feature in the codebase (licensure files, CEU files, volunteer credentials, resource docs) deliberately uses a private bucket with RLS-scoped reads or short-lived signed URLs — this is the sole outlier, and the Requests module is generic enough that staff could attach medical documentation, financial/reimbursement receipts, or HR-adjacent material.

**Why it matters:** unlike the other buckets, there is no path-guessing barrier being relied on as a second layer — a leak of any single URL is total, permanent, and silent (no access logging visible from the app layer).

**Fix:** flip the bucket to private, switch `getPublicUrl()` (`app/requests.js:388-391`) to `createSignedUrl()` with a short TTL (matching `license-files`' pattern), and gate reads with an RLS policy scoped to the request's `school_id` plus manager/submitter identity.

---

### [Medium] CLAUDE.md's TECH_DEBT note about the committed `.env` service-role key is stale
**Files:** `/Users/justin/Belltower/CLAUDE.md` ("known open item"), `TECH_DEBT.md` ("✅ Not an issue" — confirmed via `git ls-files`), verified independently here via `git log --all --full-history -- supabase/functions/.env` (empty) and `git ls-files | grep functions/.env` (empty).

I independently re-verified: `supabase/functions/.env` does not exist on disk, is not tracked by git now, and has never appeared anywhere in git history. `.gitignore` correctly excludes it. This matches `TECH_DEBT.md`'s later, more detailed finding, not `CLAUDE.md`'s framing of it as a still-open, deferred item requiring "key rotation + git filter-repo."

**Why it matters:** the discrepancy between the two docs could cause a future engineer (or agent) to either waste time chasing a git-history purge that was never needed, or worse, to under-react to a *real* future leak because "the .env thing" is filed away as "already known, deferred."

**Fix:** update the CLAUDE.md line to reflect the confirmed non-issue status. Rotating the service-role key is still cheap, harmless hygiene and can be done opportunistically, but it is not an active leak.

---

### [Medium] `grade_check` table: RLS-enabled-but-policy-less scratch table with `GRANT ALL ... TO anon`
**File:** `schema.sql:2144-2154` (table def, no `school_id`, columns are just `first_name`/`last_name`/`intended_grade`), `schema.sql:10296-10298` (`GRANT ALL ON TABLE grade_check TO anon`).

RLS is enabled with zero policies, so in practice `anon`/`authenticated` get nothing (default-deny) despite the `GRANT ALL` — not currently exploitable, but it's dead surface area (looks like a leftover ad hoc admissions/placement scratch table) with a needlessly broad grant.

**Fix:** drop the table if unused, or document its purpose and tighten the grant regardless.

---

### [Medium] `license-files` and `school-assets` storage buckets exist only via hand-configured dashboard settings, not in any migration
**File:** comment in `supabase/migrations/20260717000001_resource_documents.sql:80-87`: *"this repo has no other storage.objects RLS policies committed anywhere — the existing license-files / school-assets / request-attachments buckets appear to have been configured by hand in the Supabase dashboard."*

Confirmed no `INSERT INTO storage.buckets` for `license-files` or `school-assets` exists anywhere in `supabase/migrations/` or the root-level ad hoc `*.sql` scripts. `app/admin.licensure.js:566,1012,1062,1076` confirms `license-files` is treated as private (uses `createSignedUrl` with a 1-hour expiry) — the *behavior* looks correct, but its public/private flag and RLS policies live only in the dashboard, invisible to code review and unreproducible if the project were ever rebuilt from this repo.

**Fix:** pull the actual current bucket config and `storage.objects` policies for these two buckets into a migration file (even retroactively), matching the documented pattern used for `ceu-files` / `volunteer-credential-files`.

---

### [Low] Compliance/guardian-intake form link tokens use a fragile custom encoding
**File:** `app/admin.compliance.forms.js:268-270`.
```js
const bytes = new Uint8Array(24);
crypto.getRandomValues(bytes);
const token = Array.from(bytes).map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 32);
```
This generates 24 cryptographically random bytes but discards roughly a third of them in the final `.slice(0, 32)` (only the first 16 of 24 bytes survive the base-36, 2-chars-per-byte encoding before truncation). Not a practical brute-force risk today (~128 bits remain), but it's an unusual, easy-to-misunderstand pattern that a future "simplify this" edit could weaken without anyone noticing the entropy loss. Token validation itself is otherwise sound: length-checked (`=== 32`), joined against an indexed unique column, and correctly checks `active`/`expires_at` before accepting a submission (`compliance_form_lookup/index.ts:59-86`, `compliance_form_submit/index.ts:71-84`). These are shared campaign links by design (multiple people sign against one link), so the lack of single-use enforcement is intentional, not a gap.

**Fix:** use `crypto.randomUUID()` (or two, concatenated) for clarity instead of the manual base-36 re-encoding.

---

### [Low / confirmed clean] `esc()` XSS coverage
Grepped every `app/*.js` file for `.innerHTML` assignments containing template-literal interpolation (`${...}`) with no `esc(` call anywhere on the line — **zero matches across the entire frontend**. The two issues logged in `TECH_DEBT.md` (`admin.access.js:167-175,314-316` and `admin.licensure.js:153-312`) are confirmed fixed on inspection (`app/admin.access.js:233-238`, `app/admin.licensure.js:284-298,318+` all wrap every interpolated DB field in `esc()`), and no regressions exist in any of the newer modules built since (`admin.requests.js`, `admin.training.js`, `admin.ic-sync.js`, `admin.compliance.*.js`, `admin.field-trips.js`, `admin.reservations.js` all checked directly). Noted here so this doesn't get re-flagged as an open item in a future audit.

---

## 2. Code consolidation opportunities

### [Medium] Inline debounce has regressed into 6 newer modules since the May fix
**Files:** `app/admin.compliance.grants.js:93,147`, `app/admin.compliance.forms.js:640`, `app/admin.compliance.requests.js:924,1027`, `app/admin.requests.js:470,479`, `app/admin.training.js:366`, `app/admin.ic-sync.js:519`.

`TECH_DEBT.md` logged this exact pattern as fixed in May 2026 ("all use shared debounce()"). It has since reappeared in every module built after that date for the Compliance, Requests, and Training areas — each defines its own `let searchTimer; clearTimeout(searchTimer); searchTimer = setTimeout(...)` instead of importing `debounce` from `admin.shared.js`. Notably, `admin.compliance.requests.js` and `admin.requests.js` both *already import* `debounce` from `admin.shared.js` for other purposes but still hand-roll it at these specific call sites — a copy-paste-from-an-older-module problem, not a missing-import problem.

**Fix:** convert all 6 call sites to `input.addEventListener('input', debounce(fn, 300))`; consider having the `new-admin-module` scaffold skill default to this pattern so it doesn't keep reappearing.

### [Medium] No `supabase/functions/_shared/` module despite heavy duplication
**Files:** CORS header block duplicated verbatim in ~20 of 26 functions; `fetchAllRows()` pagination helper duplicated verbatim in `admin_export/index.ts`, `compliance_report/index.ts`, `bulk_upload_preview/index.ts`, `send_license_alerts/index.ts`, `guardian_intake_submit/index.ts`, and `pto_calendar_ics/index.ts`; Resend API calling code duplicated across `send_pto_notifications`, `send_license_alerts`, `send_license_submission_notification`, `send_license_verification_notification`, `send_request_notification`, `send_request_update_notification`, and `forward_request`.

Every one of the current `fetchAllRows()` copies is correct and consistent (all guard against PostgREST's 1000-row unranged-select cap the same way), but that's exactly the risk: if the pagination-cap logic ever needs a fix, it needs to be applied in 6 separate files, and missing even one silently reintroduces the exact row-truncation bug the helper exists to prevent.

**Fix:** create `supabase/functions/_shared/{cors.ts,fetchAllRows.ts,email.ts}` and import via relative paths (Deno edge functions support this) from each function.

### [Medium] `select('*')` still present in 4 current call sites
**Files:** `app/admin.compliance.volunteers.js:231`, `app/admin.ic-sync.js:43`, `app/admin.ic-sync.js:901`, `app/admin.field-trips.js:2688`.

The May fix converted `staff_licenses`, `profiles`, and `campuses` to explicit column lists per `TECH_DEBT.md`, but these 4 (two of them in the newer IC-sync integration module) were never converted.

**Fix:** replace with explicit column lists per the established convention.

### [Low] `createDirectory()` adoption is inconsistent across newer list-view modules
**Files:** `app/admin.compliance.attention.js`, `app/admin.compliance.forms.js`, `app/admin.compliance.requests.js`, `app/admin.compliance.volunteers.js`, `app/admin.field-trips.js`, `app/admin.tag-availability.js`, `app/admin.training.js` all hand-roll their own `.range()`-based pagination rather than using the shared `createDirectory()` abstraction used by `admin.staff.js`, `admin.students.js`, `admin.families.js`, `admin.guardians.js`, `admin.busgroups.js`, `admin.carpools.js`, and `admin.licensure.js`.

Some of these likely have legitimate reasons to differ (multi-entity drawers, master-detail views that don't fit `createDirectory`'s single-table config shape), so this needs a case-by-case look rather than a blanket refactor — but `admin.compliance.requests.js` and `admin.training.js` in particular look like straightforward filterable list views that would fit the existing abstraction.

**Fix:** audit these 7 modules individually; migrate the ones that are simple list/filter/paginate views.

### [Low] `GRADE_ORDER` duplication — confirmed fixed, no regression
Checked all 9 non-`admin.shared.js` files referencing `GRADE_ORDER` (`admin.data-collection.js`, `admin.families.js`, `admin.exports.js`, `admin.field-trips.js`, `admin.placement.js`, `admin.promotion.js`, `admin.placement.sessions.js`, `admin.students.js`, `admin.staff.js`) — all import it from `admin.shared.js`, none redefine it locally. The May fix has held. Noted so it isn't re-flagged.

---

## 3. Performance

### [High] `bulk_upload_commit` inserts/updates rows one at a time in sequential loops
**File:** `supabase/functions/bulk_upload_commit/index.ts:81` (Families), `:165` (Students), `:211` (Guardians), `:234` (Staff), and the Bus Groups block in between.

Every entity type is committed via a `for (const row of ...)` loop with an individually `await`-ed `.insert()`/`.update()`/`.select().single()` call per row (e.g. `index.ts:175-179` for a single student insert). There is no batching anywhere in this function, in contrast to `bulk_upload_preview/index.ts` and `supabase/functions/sync_infinite_campus/index.ts`, both of which already chunk inserts/upserts into batches (e.g. `sync_infinite_campus/index.ts:119-120,158-159`).

**Why it matters:** a realistic back-to-school bulk import of several hundred students, each requiring its own row-level round trip, risks hitting the edge function's execution time limit and makes every commit noticeably slower than it needs to be — especially since the *preview* step for the same data already proved batching works fine here.

**Fix:** switch to chunked `.insert(rows)` / `.upsert(rows)` calls per entity type (e.g. batches of 500), matching the pattern already in use elsewhere in this same codebase.

### [Medium] Dead `postgres_changes` realtime listeners in carline pages waste connections
**Files:** `app/carline.html:1672-1798`, `app/carline-input.html:793-884`; publication membership confirmed via `supabase/migrations/20260705000001_placement_realtime.sql:7-8` and `20260714000001_placement_session_notes.sql:65` (only `placement_assignments`, `placement_session_teachers`, `placement_session_notes` are in `supabase_realtime` — no carline table ever has been).

Both files still open a `.channel(...).on('postgres_changes', ...)` subscription against `carline_calls`/`carline_bus_arrivals`, which can never fire since neither table is in the realtime publication. The code has its own comment acknowledging this (`app/carline-input.html:901-902`: *"carline_calls is not in the supabase_realtime publication so the postgres_changes listener above never fires"*) and correctly relies on an 8-10s poller plus a broadcast channel as the real mechanism (`app/carline-input.html:910-918`, `app/carline.html:1833,1870`).

**Why it matters:** every open carline/dismissal screen still opens and holds a websocket subscription that will never deliver anything — pure overhead. This matters specifically at the scale this app already runs at (the "first live dismissal" event had 50+ boards live across 2 campuses simultaneously), where each one is an unnecessary realtime connection.

**Fix:** either add the carline tables to the `supabase_realtime` publication and drop the poller, or delete the dead `postgres_changes` listeners entirely and keep only the documented poll+broadcast mechanism.

### [Medium] `pto_calendar_ics` has no date-range filter
**File:** `supabase/functions/pto_calendar_ics/index.ts:20-22` (comment: *"This feed has no date filter — it's every APPROVED PTO request ever"*).

The function already defends against PostgREST's 1000-row cap via its own `fetchAllRows()`, but the underlying query itself is unbounded — an established school's calendar feed will keep growing every year with no pruning, increasing response size and generation time indefinitely.

**Fix:** filter to a rolling window (e.g., 90 days back to 365 days forward) unless a full historical export is a specific requirement.

### [Low / confirmed clean] Indexing
Spot-checked `students`, `employees`, `staff_requests`, `staff_license_ceu_history`, `staff_required_training`, and `profiles` (including `profiles.user_id`, which nearly every RLS policy in the schema joins against via `p.user_id = auth.uid()`). All carry appropriate `school_id` and composite indexes; this matches the fixes already logged in `TECH_DEBT.md` (`idx_students_grade_level`, `idx_employees_school_active`, `idx_employees_email_lower`) plus good practice in newer migrations (e.g. `staff_required_training` ships with `(school_id)` and `(school_id, expires_date)` indexes in the same migration that creates the table). No index gaps found on the tables sampled.

### [Low / confirmed clean] Script tag count
`app/admin.html` loads only 2 top-level `<script type="module">` tags; other standalone pages (`pto.html`, `staff.html`, `carline.html`, `compliance.html`, `volunteer.html`) each load exactly 1. Tab/module code is loaded via dynamic `import()` from those entry points rather than one `<script>` tag per module, so the "excessive separate script tags" pattern named in the audit brief doesn't apply here.

---

## 4. Attachment storage & backup resilience

**Storage backend assumption, confirmed:** grepped the entire repo (`app/`, `supabase/`, all config/JSON files) for R2/Cloudflare/S3-endpoint/AWS_S3 patterns — zero real hits. There is no evidence anywhere in version control of a custom S3-compatible backend. **This confirms plain Supabase-managed Storage is in use**, not a custom Cloudflare R2 setup. If the user believes R2 (or any other S3-compatible backend) is configured, that configuration does not exist in this repository — it would have to be either a dashboard-only setting invisible to code review, or a mistaken belief that should be corrected before planning backup strategy around it.

### Bucket inventory
| Bucket | Public? | RLS / access pattern | Source |
|---|---|---|---|
| `request-attachments` | **Public** | `SELECT TO public USING (bucket_id = ...)` — no auth needed | `20260528000001`, `20260528000003` |
| `resource-docs` | Private | RLS scoped by `school_id` path segment + `can_manage_resource_docs` | `20260717000001` |
| `ceu-files` | Private | RLS scoped by `school_id` + `can_manage_licensure` or owning staff member | `20260812000006` |
| `staff-required-training` files | Private | Same pattern; staff can self-manage while unverified | `20260920000002` |
| `volunteer-credential-files` | Private | RLS scoped by `school_id` + `can_manage_compliance`/`can_manage_chaperone_credentials`; explicitly documented as always accessed via short-lived signed URL | `20260922000001` |
| `license-files` | Private (behaviorally confirmed via `createSignedUrl`, 1hr TTL) | **Not in any migration** — dashboard-configured | inferred from `app/admin.licensure.js:566,1012,1062,1076` |
| `school-assets` | Unknown | **Not in any migration** — dashboard-configured, unverifiable from repo | comment in `20260717000001` |
| — (signed compliance agreements) | N/A | **Not a bucket at all** — signature PNG stored as base64 directly in `compliance_agreements.signature_data` (Postgres column) | `compliance_form_submit/index.ts` |

### [High] No backup strategy independent of Supabase's own platform backups
No evidence anywhere in the repo of: object versioning or object-lock on any bucket, a scheduled export/snapshot job (no cron edge function, no CI job, nothing under `supabase/functions/` that exports to a second location), or a documented restore procedure. Nearly every edge function uses the service-role client (by design, per CLAUDE.md), which bypasses RLS entirely — meaning a bug or bad actor with function-invoke access could mass-modify or mass-delete data with no independent recovery path outside whatever Supabase itself retains.

**Fix:** stand up a scheduled job (cron-triggered edge function or external CI) that periodically runs `pg_dump` and syncs all storage buckets to a **second, independent provider** — not the same vendor/account as primary storage, so a Supabase-account-level incident doesn't take out both copies. Test a full restore at least once; a backup that has never been restored is a hypothesis, not a plan.

### [High] `bulk_upload_rollback` hard-deletes with no snapshot or edit-check
**File:** `supabase/functions/bulk_upload_rollback/index.ts:87`: `await admin.from(table).delete().eq("id", row.inserted_id)`.

Every row a `bulk_upload_commit` inserted is permanently deleted on rollback, with no soft-delete, no snapshot taken first, and no check for whether the row has been edited since the original import (e.g., an admin corrects a newly-imported student's grade level five minutes after the import, then someone rolls the import back — that correction, and the student record itself, is gone with no recovery path short of a full database restore).

**Fix:** snapshot rows into a rollback-audit table before deleting, or compare current row state to the state captured at commit time and warn/skip rows modified since.

### [Medium] Three upload paths overwrite files with no version retained
**Files:** `app/admin.resource-docs.js:635-663` (explicitly documented: *"Normally overwrites the same storage path in place... rather than accumulating versions"*), `app/admin.compliance.main.js:177`, `app/requests.js:379-391` (all use `{ upsert: true }`).

This is a deliberate design choice for resource-docs (keeps the "current" file simple, per its own comment), but it means any replacement — intentional or accidental — destroys the only copy of the prior version with no retention window, across three different features (resource library docs, a compliance-module file, and Requests-module attachments).

**Fix:** for anything with legal/audit weight (compliance docs, request attachments used as evidence in a decision), write to a timestamped path and update a pointer rather than overwriting in place, so the prior version survives a mistaken replace.

### [Medium] Signed compliance agreements live only in Postgres, with no object-storage redundancy
**File:** `supabase/functions/compliance_form_submit/index.ts` — `signature_data` is validated as a base64 PNG capped at ~1MB and inserted directly into the `compliance_agreements.signature_data` column.

Every other file-bearing feature in the app stores files in a bucket and references them by path; signed agreements — arguably the most legally significant artifact in the compliance module — are the exception, living entirely inside the primary database row. This inflates primary-database size/backup time as agreement volume grows and ties these records' durability entirely to whatever backup story exists for Postgres itself (see finding above), with tighter coupling than every other attachment type in the app.

**Fix:** consider moving signature images to a private bucket referenced by path, for consistency with the rest of the app and to decouple database backup size from agreement volume.

### [Low] Two buckets have no reproducible record of their own existence
`license-files` and `school-assets` (also flagged in Security §above) were configured entirely by hand in the dashboard. Beyond the security/audit concern, this is also a disaster-recovery gap: if the Supabase project were ever rebuilt from this repo's schema and migrations alone, these two buckets' existence, public/private flag, and access policies would be completely unrecoverable — there is nothing in version control to reconstruct them from.

**Fix:** capture their current live configuration into a migration file (even retroactively), the same way `ceu-files` and `volunteer-credential-files` already are.
