# Belltower Tech Debt Report
_Generated: 2026-05-17 · Last remediation: 2026-05-26_

## Final Resolution Status

| Item | Status |
|---|---|
| **SECURITY** | |
| `.env` service-role key committed to git | ✅ **Not an issue** — confirmed via `git ls-files` that `supabase/functions/.env` was never committed. File is correctly listed in `.gitignore`. No git history purge needed. Service role key rotation is desirable hygiene but not urgent (no actual leak occurred). Defer rotation to when Supabase Pro is set up before going live. |
| `PTO_APPROVAL_HMAC_SECRET` same value on dev and production | ✅ Fixed (2026-05-26) — production secret updated to a unique value via `supabase secrets set`. Dev and prod HMAC secrets are now distinct. |
| `config.js` — misleading "do not commit" comment on intentionally-public anon key | ✅ Fixed — comment now correctly documents anon key is safe to commit |
| XSS: `admin.access.js` — display_name/email unescaped in innerHTML | ✅ Fixed |
| XSS: `admin.licensure.js` — all table/audit fields unescaped | ✅ Fixed |
| `admin.placement.js` — students UPDATE missing school_id filter | ✅ Fixed |
| `admin.promotion.js` — bulk UPDATE missing school_id filter | ✅ Fixed |
| `admin.access.js` toggleAccessPermission — missing school_id guard | ✅ Fixed |
| RLS missing on placement / promotion / staff_license_files tables | ✅ SQL run |
| `school_settings` SELECT policy world-readable | ✅ SQL run |
| `bulk_upload_logs` missing SELECT policy | ✅ SQL run |
| `schools` SELECT policy world-readable (USING true) | ✅ Intentionally left open — required for school-switcher dropdown; no sensitive data |
| **ERROR HANDLING** | |
| `admin.licensure.js` — loadLicenses() silent error | ✅ Fixed — renders error row in tbody |
| `admin.licensure.js` — loadAuditLog() silent error | ✅ Fixed — renders error row in tbody |
| `admin.promotion.js` — audit log write failure silent | ✅ Fixed |
| `admin.placement.js` — session teachers insert no error check | ✅ Fixed |
| `admin.placement.js` — assignment pre-population no error check | ✅ Fixed |
| `admin.placement.js` — auto-save "Save failed" cleared too quickly | ✅ Fixed — error stays visible until next successful save |
| **ARCHITECTURE** | |
| `admin.carpools.js` — duplicate avatarColor() | ✅ Fixed |
| GRADE_ORDER / nextGrade / gradeLabel duplicated across modules | ✅ Fixed — extracted to admin.shared.js |
| Inline debounce pattern in 5 modules | ✅ Fixed — all use shared debounce() |
| `admin.placement.js` — local escHtml() instead of esc() | ✅ Fixed |
| `admin.licensure.js` — dead showModal/hideModal | ✅ Fixed |
| `admin.licensure.js` — dead ternary in populateCampusSelects | ✅ Fixed |
| `admin.promotion.js` — draftKey() re-reads DOM each call | ✅ Fixed — _draftCampusId captured at load time |
| `admin.core.js` — quick-action buttons via innerHTML | ✅ Fixed — uses createElement + textContent |
| `admin.staff.js` — load monkey-patch pattern | ✅ Fixed — replaced with onBeforeLoad config |
| `admin.directory.js` — no onBeforeLoad callback | ✅ Fixed |
| `send_pto_notifications` — dead helpers, inline logic duplicated twice | ✅ Fixed — helpers wired up, sendSubCoverageNoLongerNeeded added |
| Page init auth guard duplicated in 4+ pages | ✅ Fixed — admin.auth.js created; licensure.js, substitutes.html, staff.html, pto.js updated |
| `select('*')` on campuses | ✅ Fixed — explicit column list |
| `select('*')` on staff_licenses | ✅ Fixed — explicit column list |
| `select('*')` on profiles in loadAccessProfile | ✅ Fixed — explicit column list of all permission fields |
| **MISSING DB INDEXES** | |
| students.grade_level | ✅ SQL run |
| employees.active (school_id composite) | ✅ SQL run |
| employees.email lower() | ✅ SQL run |
| **CSS / UI** | |
| z-index magic numbers — no layer system | ✅ Fixed — CSS custom properties in :root |
| confirm-modal-overlay at z-index 700 (below open drawer) | ✅ Fixed — now var(--z-modal) = 1200 |
| Inline style.color in admin.core.js | ✅ Fixed — uses .status-success / .status-danger / .status-muted CSS classes |
| Status color CSS utility classes missing | ✅ Fixed — added to admin-ui.css |
| **ACCESSIBILITY** | |
| Drawers have no focus trap | ✅ Fixed — Tab/Shift+Tab constrained to open drawer |
| Confirm modals missing role/aria attributes | ✅ Fixed — all 3 modals updated |
| licensure.html Flatpickr labels missing for= | ✅ Fixed |
| Birthday list uses bare div without list semantics | ✅ Fixed — wrapped in ul/li |
| **DEAD CODE** | |
| admin.licensure.js — showModal/hideModal dead | ✅ Fixed |
| admin.placement.js — escHtml() dead | ✅ Fixed |
| send_pto_notifications — dead helpers never called | ✅ Fixed — now wired |

**No open security items.** The `.env` service-role key was confirmed never committed to git (non-issue). The PTO HMAC secret was updated to a unique production value on 2026-05-26. Service role key rotation remains desirable hygiene — defer to Supabase Pro setup before going live.

---


## Summary

Belltower is a well-structured vanilla JS / Supabase application. The module-based lazy-loading pattern, the shared `createDirectory` abstraction, and the `esc()` helper in `admin.shared.js` are all solid foundations. The biggest systemic issues are: (1) **a committed `.env` file containing a live service-role key and project URL**, which is an immediate credential leak; (2) **unescaped user-controlled fields in several `innerHTML` blocks** in `admin.access.js` and `admin.licensure.js`; (3) **several tables created after the initial schema dump have no RLS policies** (placement, promotion, staff license files); and (4) **debounce is applied inconsistently** — four modules inline their own `clearTimeout` pattern instead of using the shared `debounce()` utility. The codebase otherwise shows good discipline: every Supabase query filters by `school_id`, the directory abstraction eliminates N+1 patterns in list views, and auth is checked at the top of every page entry point.

---

## High Priority

### SECURITY

**[supabase/functions/.env:1–18] — Live service-role key and project URL committed to git**

The file `supabase/functions/.env` is tracked in the repository (confirmed by `git status` showing it was not in `.gitignore` at the time of auditing). It contains:
- `SUPABASE_URL=https://lmvpjbzwdyfziedpeytd.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…` (full JWT)
- `PTO_APPROVAL_HMAC_SECRET=dev-hmac-secret-change-in-production` (this comment suggests it may still be the production value)

The service-role key bypasses all RLS and grants full database access to anyone who can read the repo. Rotate the key immediately in Supabase → Settings → API, then add `supabase/functions/.env` to `.gitignore` and remove it from git history with `git filter-repo` or BFG.

---

**[app/config.js:2–3] — Supabase URL and anon key hardcoded in a committed JS file**

`config.js` contains:
```js
export const SUPABASE_URL = 'https://lmvpjbzwdyfziedpeytd.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…';
```
The anon key is public by design and safe for the browser, but the comment on line 1 says "Auto-generated at build time — do not edit or commit." The file is in the repo and the URL exposes your project ref to anyone reading the source. Move key injection to a Vercel environment variable (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) and generate `config.js` at build time so it is listed in `.gitignore`. This is lower-severity than the service-role key but important for hygiene.

---

**[app/admin.access.js:167–168, 172–175, 314–316] — `innerHTML` with unescaped profile fields (XSS)**

Three locations in `admin.access.js` write `p.display_name` and `p.email` directly into `innerHTML` without calling `esc()`:

```js
// Line 167-168
document.getElementById('accessUserMeta').innerHTML = `
  <strong>${p.display_name ?? '—'}</strong><br>${p.email}
`;

// Line 172-175 (appends again)
document.getElementById('accessUserMeta').innerHTML += `
  <p style="...">This person has a profile…</p>
`;

// Line 314-316 (pending users table)
tr.innerHTML = `
  <td>${p.display_name ?? '—'}</td>
  <td>${p.email}</td>
`;
```

`display_name` and `email` come directly from the `profiles` table. Any admin can set their `display_name` to `<img src=x onerror=alert(1)>` and it will execute in the access management panel of every other admin who views it. Wrap all of these with `esc()` from `admin.shared.js` (already imported in sister modules — needs to be imported here too).

---

**[app/admin.licensure.js:153–158, 222–228, 307–312] — `innerHTML` with unescaped DB fields (XSS)**

`admin.licensure.js` does not import `esc()` at all and renders database fields directly into HTML in three places:

- **Line 153**: `employeeLookup[lic.employee_id]`, `lic.license_type`, `lic.license_area` injected raw into the alert list `.innerHTML`.
- **Line 222–228**: `employeeLookup[lic.employee_id]`, `lic.license_number`, `lic.license_type`, `lic.license_class`, `lic.license_area`, `lic.grade_authorization` all injected raw into the license table rows.
- **Line 307–312**: `employeeLookup[employeeId]`, `changerProfile`, `r.change_type`, and `details` (which is built from `r.field_changes` keys and values, i.e., raw JSON stored by the app) injected into the audit log table.

The `details` field on line 302–304 is particularly risky: it iterates `Object.entries(r.field_changes)` and uses both keys and values as HTML, and `field_changes` is a JSONB column that stores the previous and new values of any license field including free-text fields like `notes` and `license_area`.

Fix: import `esc` from `admin.shared.js` and wrap every interpolated value.

---

**[app/admin.placement.js:793–799, 963–966] — `students` UPDATE without `school_id` filter**

In `runUndoCommit()` (lines 793–799) and `runCommit()` (lines 963–966), `homeroom_teacher_id` is updated on `students` using only `.in('id', sids)` — no `.eq('school_id', ...)` filter:

```js
// Line 794
const { error } = await supabase.from('students')
  .update({ homeroom_teacher_id: tid })
  .in('id', sids);

// Line 798
const { error } = await supabase.from('students')
  .update({ homeroom_teacher_id: null })
  .in('id', nullStudents);
```

RLS on the `students` table should prevent cross-school writes, but the client-side filter is missing as a defense-in-depth layer. The IDs in `sids` come from `placement_assignments`, which is loaded from the session. If a placement session were ever created with student IDs from another school (e.g., via a direct API call), this update would silently affect them. Add `.eq('school_id', _profile.school_id)` to both UPDATE calls.

---

**[app/admin.placement.js:938–941] — Snapshot query for commit lacks `school_id` filter**

The commit flow reads existing `homeroom_teacher_id` values before overwriting them:

```js
const { data: currentHomerooms } = await supabase
  .from('students')
  .select('id, homeroom_teacher_id')
  .in('id', placedStudentIds);
```

No `.eq('school_id', _profile.school_id)`. Same concern as above — add the filter.

---

**[app/admin.promotion.js:463–486] — Bulk `students` UPDATE without `school_id` guard**

The `runPromotion()` function updates students using only `.in('id', ids)` for all three operations (promote, retain, graduate). The student IDs come from a prior `loadPromotionPreview()` query that does filter by `school_id`, but there is no server-side re-validation that those IDs belong to the current school at update time. Add `.eq('school_id', _profile.school_id)` to every `supabase.from('students').update(...)` call in `runPromotion()`.

---

**[schema.sql] — New tables (placement, promotion, staff_license_files) have no RLS policies**

The following tables are referenced in the application code but do not appear in the RLS policy section of `schema.sql`:

- `placement_sessions` — contains placement drafts; no `ENABLE ROW LEVEL SECURITY` or `CREATE POLICY` found
- `placement_session_teachers` — same
- `placement_assignments` — same
- `placement_flags` — same
- `student_placement_flags` — same
- `student_promotion_log` — stores grade promotion audit records; no policies found
- `staff_license_files` — stores file metadata for license attachments; no policies found

This means any authenticated user at any school can currently read and write placement data, promotion logs, and license file records for any other school. These tables need `ENABLE ROW LEVEL SECURITY` and `school_id`-scoped SELECT/INSERT/UPDATE/DELETE policies matching the pattern already established for `students` and `employees`.

---

**[supabase/functions/send_pto_notifications/index.ts:446–458] — Dead function `loadSubstituteManagers` never called**

A function `loadSubstituteManagers(schoolId)` is defined at line 446 but is never called anywhere in the file. Instead, the inline substitute-manager query is duplicated at lines 252–260 and again at lines 311–322. The dead function is not a security issue by itself, but it was clearly intended to deduplicate the inline queries and was never wired up.

---

**[app/admin.access.js:219–227] — Permission toggle updates profiles by `user_id` without re-validating school membership**

`toggleAccessPermission()` calls:
```js
const { error } = await supabase
  .from('profiles')
  .update({ [field]: cb.checked })
  .eq('user_id', userId);
```

The `userId` comes from `cb.dataset.user`, which is set in `loadAccessProfile()` from the profile loaded by `profileId`. A superadmin using the school switcher could theoretically have a stale `userId` in the DOM from a prior session. More practically: there is no `.eq('school_id', currentProfile.school_id)` guard, so the RLS policy `"Only access managers may update profiles"` is the only thing preventing cross-school permission edits. The RLS policy does enforce this, but the client-side call should include the school_id filter as a defensive measure.

---

### ERROR HANDLING

**[app/admin.promotion.js:496–506] — Audit log write after bulk student UPDATE; failure is silent to the user**

After all student updates succeed, the promotion log is written:
```js
await supabase.from('student_promotion_log').insert({...});
```
There is no error check on this insert. If the audit log write fails (e.g., schema issue, RLS block), the promotion has already run but there is no record of it and no error message to the user. Capture the `{ error }` and at minimum `console.error` it.

**[app/admin.placement.js:709–733] — Auto-save failure shown briefly then silently cleared**

`saveAssignments()` shows "Save failed" on error but `updateSaveStatus('')` is called after 2500ms only on success. On failure the status stays "Save failed" until the next save attempt — but if no further changes are made, the user may close the board without realizing their last placement was not saved. Add a `setTimeout` on error path that keeps "Save failed" visible longer, or add a persistent error indicator.

**[app/admin.licensure.js:191, 265] — `loadLicenses()` and `loadAuditLog()` surface errors only to console**

Both functions do `console.error(error); return;` without rendering any user-facing feedback in the table. The table just stays empty, which looks identical to "no data". Render an error row in the `<tbody>` as other modules do.

**[app/admin.placement.js:360–361] — `placement_session_teachers` insert has no error check**

```js
await supabase.from('placement_session_teachers').insert(
  checked.map(t => ({...}))
);
```
No `const { error } =` capture. If this insert fails (e.g., duplicate), the session is created but has no teachers attached, and the board will appear empty with no explanation.

**[app/admin.placement.js:372–381] — `placement_assignments` pre-population insert has no error check**

Same pattern: `await supabase.from('placement_assignments').insert(...)` with no error capture. Failure leaves the session with zero students and no user feedback.

---

## Medium Priority

### ARCHITECTURE / MAINTAINABILITY

**[app/admin.busgroups.js:49, app/admin.carpools.js:49–54] — `avatarColor()`/`getAvatarColor()` duplicated**

`admin.carpools.js` defines its own `avatarColor(seed)` function (line 49–54) that is functionally identical to `getAvatarColor(name)` in `admin.shared.js`. They use the same color palette and the same djb2-style hash algorithm. `admin.carpools.js` already imports `esc` from `admin.shared.js` — it should also import `getAvatarColor` and delete the local copy.

**[app/admin.promotion.js:7–28 and app/admin.placement.js:3–16] — `GRADE_ORDER`, `nextGrade()`, `gradeLabel()` duplicated**

Both modules define identical `GRADE_ORDER` arrays and near-identical `nextGrade()` and `gradeLabel()` functions. These should be extracted to `admin.shared.js` and imported where needed.

**[app/admin.busgroups.js:257–259, admin.carpools.js:333–335, admin.guardians.js:251–253, admin.families.js:245–247, admin.students.js:375–378] — Inline debounce pattern instead of shared `debounce()`**

Five modules implement their own inline debounce using a module-level `let t` variable and `clearTimeout/setTimeout` in the event handler, bypassing the shared `debounce()` in `admin.shared.js`. `admin.staff.js` correctly uses the shared utility. Standardize on the shared `debounce()` and remove the five inline copies.

**[app/admin.licensure.js:25–57] — Standalone `init()` duplicates auth/profile loading already in `admin.core.js`**

`admin.licensure.js` is a separate page (`licensure.html`) with its own `init()` function that performs auth session check, profile load, and user menu initialization. This is the same pattern as `admin.core.js` lines 12–62. The auth-init sequence (`getSession()` → `select profiles` → `initUserMenu()` → redirect if unauthorized) is written independently in at least three places (also in `pto.js`, `staff.html`, `substitutes.html`). This would benefit from a shared `initPage({ requiredCap, redirectTo })` utility.

**[app/admin.placement.js:24–28] — Local `escHtml()` function duplicates `esc()` from `admin.shared.js`**

`admin.placement.js` defines its own `escHtml(str)` at line 24–28 that is byte-for-byte identical in behavior to `esc()` in `admin.shared.js`. The module doesn't import from `admin.shared.js` at all. Import `esc` and delete `escHtml`.

**[app/admin.core.js:349–361] — Dashboard quick-actions buttons built with `a.innerHTML = '...'` using unescaped `label` and `icon` values**

```js
a.innerHTML = `<i data-lucide="${icon}"></i>${label}`;
```
`label` and `icon` come from a hardcoded `actions` array built in the same function, so this is not exploitable in practice — but the pattern is inconsistent with the rest of the codebase and would become a risk if `label` were ever sourced from the database. Use `a.textContent` for the label after creating the icon element separately.

**[app/admin.licensure.js:652–657] — `populateCampusSelects()` has a dead branch**

```js
sel.innerHTML = isFilter ? '<option value="">All campuses</option>' : '<option value="">All campuses</option>';
```
Both branches of the ternary are identical. The original intent was likely to have a different placeholder for the form select vs. the filter select. Remove the ternary and use a single string.

**[supabase/functions/send_pto_notifications/index.ts:446–474] — `loadSubstituteManagers` and `sendSubCoverageNeeded` are defined but dead**

`loadSubstituteManagers` (line 446) and `sendSubCoverageNeeded` (line 461) are fully implemented helper functions that are never called. The logic they contain is inlined twice in the `serve()` handler (lines 251–283 and lines 311–338). Either wire up the helpers or delete them.

**[app/admin.promotion.js:37–54] — Draft persistence key uses `campus_id` from DOM; switching campus mid-session creates orphan draft keys**

`draftKey()` reads the campus dropdown value each time it is called. If a user loads a preview for campus A, then the campus selector changes (e.g., they navigate away and back), `clearDraft()` will be called with the new campus key and will fail to clear the draft under the old key. The draft key should be captured at preview-load time and stored in a variable for the lifetime of the session, not re-read from the DOM.

---

### QUERIES

**[app/admin.licensure.js:173–191] — `loadLicenses()` fetches `select('*')` on `staff_licenses`**

Line 176: `.select('*')` fetches every column on the table including `notes`, `role_applicability` (JSONB array), and other wide fields, then the result is stored in `allLicenses` for the export function. This is fine for the current scale but as the table grows the full-row fetch for the list view will be wasteful. Select the specific columns needed for rendering and export separately.

**[app/admin.access.js:158] — `loadAccessProfile()` uses `select('*')` on profiles**

Line 158: `.select('*').eq('id', profileId)`. Profiles contain every permission flag column. Selecting specific columns would be cheaper and more maintainable.

**[app/admin.campuses.js:29] — `loadCampuses()` uses `select('*')`**

Minor — campus rows are small, but worth replacing with an explicit column list for consistency.

**[schema.sql] — Missing indexes for common access patterns**

- `students.grade_level` — filtered in `admin.promotion.js:186`, `admin.placement.js:367`, and the `admin_export` edge function. No index exists. With hundreds of students, grade-level filters will scan the full school partition.
- `employees.active` — filtered in many queries. No index exists on `(school_id, active)`. The composite would cover all staff list queries.
- `employees.email` — the `claim_or_create_profile_for_user()` trigger at schema line 181 does `WHERE lower(email) = normalized_email`. No index on `lower(employees.email)` exists.
- `pto_requests` — index `pto_requests_school_id_employee_id_status_start_date_idx` exists (line 1788), which is good. No gap here.

**[app/admin.placement.js:453–464] — Batch-2 student/teacher queries are correct but could be combined**

The two `Promise.all` batches in `loadBoardData()` are well-structured. The second batch fires three queries for teacher names, student names, and student flags. This is correct. No issue.

---

### RLS / POLICY GAPS (continued from High Priority)

**[schema.sql:3136] — `school_settings` SELECT policy is `USING (true)` — world-readable**

```sql
CREATE POLICY "staff can read school settings" ON public.school_settings FOR SELECT USING (true);
```
This allows any authenticated user to read school settings for any school, not just their own. If `school_settings` ever stores sensitive configuration (HMAC secrets, integration tokens, etc.), this is a leak. Restrict to `school_id = current_user_school_id()`.

**[schema.sql] — `bulk_upload_logs` has `ENABLE ROW LEVEL SECURITY` (line 2524) but no SELECT or DELETE policy**

Only RLS enable is present; no actual policies for `bulk_upload_logs`. Any authenticated user can currently read the upload history of any school. Add a `SELECT` policy scoped to `school_id`.

**[schema.sql:2369] — `schools` SELECT policy is `USING (true)` (world-readable)**

```sql
CREATE POLICY "Authenticated users can read schools" ON public.schools FOR SELECT TO authenticated USING (true);
```
All authenticated users can read the name, email domain, and metadata for all schools. This is likely intentional for the school-switcher dropdown, but if school names/domains are considered sensitive, restrict to `id = current_user_school_id() OR is_superadmin`.

---

## Low Priority

### CSS / UI

**[admin-ui.css] — z-index values are scattered magic numbers with no documented layer system**

The following z-index values appear across `admin-ui.css` with no shared comments or named CSS custom properties:
- `z-index: 2`, `3` (lines 877, 886, 896) — table cell overlaps
- `z-index: 199`, `200` (lines 3243, 3306) — unknown context
- `z-index: 500` (line 4561)
- `z-index: 700` (line 3659)
- `z-index: 800`, `801` (lines 1125, 1141) — nav/overlay
- `z-index: 1000` (line 1270) — likely header
- `z-index: 2000` (line 1692) — drawer
- `z-index: 3000` (line 1338) — modal
- `z-index: 9999` (lines 3891, 4201) — flag popover and tooltip

Define CSS custom properties for each layer: `--z-table: 2`, `--z-nav: 800`, `--z-nav-overlay: 801`, `--z-drawer: 2000`, `--z-modal: 3000`, `--z-popover: 9999`. Two elements share `9999` — verify they cannot appear simultaneously (the flag popover and the second element at line 4201 need investigation).

**[admin-ui.css:1125, 1141] — Nav z-index 800/801 is between the app bg and drawer (2000) but overlay is only 801**

The nav overlay sits at `z-index: 801` and the drawer at `z-index: 2000`. If the nav is open and a drawer opens simultaneously (possible on mobile), the overlay behind the nav could appear in front of the drawer. The overlay should be at `z-index: 1999` to always sit below the drawer.

**[admin-ui.css] — Inline `color:#f59e0b`, `color:#dc2626`, `color:#16a34a` hardcoded in JS, not using CSS variables**

In `admin.core.js` at lines 399, 414, and elsewhere, colors are hardcoded as inline styles in JavaScript:
```js
statusEl.style.color = isOpen ? '#16a34a' : '#64748b';
issuesEl.style.color = issues > 0 ? '#dc2626' : '';
```
The same colors are defined as `--success`, `--danger`, `--text-muted` in `:root`. Use CSS classes with data attributes rather than inline color assignments.

### ACCESSIBILITY

**[app/admin.html] — Drawers have `role="dialog"` and `aria-modal="true"` but there is no focus trap implementation**

The drawers in `admin.html` (lines 1224, 1279, 1371, etc.) have correct ARIA attributes but the `openDrawer`/`closeDrawer` functions (defined elsewhere in the HTML) do not implement a focus trap. When a drawer is open, Tab will cycle through the entire page DOM behind the overlay, which is a WCAG 2.1 SC 2.1.2 failure. Implement a focus trap that constrains Tab/Shift+Tab to elements within the open drawer while it is displayed.

**[app/admin.html] — Confirm/delete modals have no `role="dialog"` or `aria-modal`**

The delete confirmation modals (e.g., `deleteStaffModal`, `deleteFamilyModal`, `withdrawStudentModal`) use `hidden` attribute for show/hide but lack `role="dialog"`, `aria-modal="true"`, and `aria-labelledby`. Screen readers will not announce them as dialogs.

**[app/admin.licensure.js:683–685] — `flatpickr` date inputs lack visible `<label>` associations**

The Flatpickr instances are initialized on `#licIssueDate` and `#licExpDate`. These inputs need visible `<label for="...">` elements in the HTML. Without them, screen readers do not announce the field purpose when the input receives focus.

**[app/admin.core.js:457–466] — Birthday list items are bare `<div>` elements without list semantics**

The birthday panel renders items as `<div class="staff-dash-request-row">` with no `<ul>`/`<li>` wrapper. Screen readers will not enumerate them as a list. Wrap in `<ul>` and use `<li>` for each entry.

### DEAD CODE / UNUSED

**[app/admin.shared.js:115–121] — `cloneSelectOptions()` has inconsistent behavior with `selectedValue`**

`cloneSelectOptions(sourceId, target, selectedValue)` sets `target.value = selectedValue ?? ''` after cloning options. If `selectedValue` is a UUID that exists in the source but the DOM hasn't updated yet, the assignment silently fails. This is not a bug in the current code (it works), but the `??` fallback to `''` means passing `null` or `undefined` always resets to the first option rather than leaving the current selection. Document this behavior or rename the parameter.

**[app/admin.licensure.js:758–765] — `showModal()` and `hideModal()` are defined but never called**

Lines 758–765 define `showModal(id)` and `hideModal(id)` helper functions that are never referenced anywhere in the file. Delete them.

**[app/admin.staff.js:83] — `staffDirectory.load` monkey-patched to clear selection**

```js
const _origLoad = staffDirectory.load.bind(staffDirectory);
staffDirectory.load = (...args) => { clearStaffSelection(); return _origLoad(...args); };
```
This pattern works but is fragile — any future refactor of `createDirectory` that changes how `load` is exposed could silently break selection clearing. A cleaner approach is to add an `onBeforeLoad` callback to `createDirectory`'s config.

**[app/admin.promotion.js:498–506] — `snapshot` array is computed and stored but never read back**

The promotion audit log stores a `snapshot` column containing the full student/action map as JSONB. There is no UI in the app to view or use this snapshot data. This is intentional future-proofing, but it adds ~1 row × (number of students) JSONB on every promotion run. Consider whether this is worth the storage cost or whether the counts already stored (`promoted_count`, etc.) are sufficient.

---

## Patterns to Standardize

### 1. Debounce: use the shared utility everywhere

**Consistent:** `admin.staff.js` imports and uses `debounce` from `admin.shared.js`.
**Inconsistent:** `admin.busgroups.js`, `admin.carpools.js`, `admin.guardians.js`, `admin.families.js`, `admin.students.js` each define their own inline `let t; clearTimeout(t); t = setTimeout(...)` pattern.
**Also inconsistent:** `substitutes.html` (line 1935) defines its own local `debounce()` function.

**Pick one:** Import `debounce` from `admin.shared.js` and remove all inline copies.

### 2. HTML escaping: `esc()` vs `escHtml()` vs no escaping

**Consistent:** All modules that import from `admin.shared.js` use `esc()`.
**Inconsistent:** `admin.placement.js` defines `escHtml()` locally instead of importing `esc`. `admin.licensure.js` uses neither.

**Pick one:** `esc()` from `admin.shared.js` — import it in every module that renders database values to HTML. Delete `escHtml()` in `admin.placement.js`.

### 3. Search input wiring: named debounce vs inline timeout

There are two patterns for wiring a search input to a directory:

**Pattern A** (correct, `admin.staff.js:407`):
```js
searchInput.addEventListener('input', debounce(e =>
  staffDirectory.setSearch(e.target.value.trim()), 300));
```

**Pattern B** (inline, used in four other modules):
```js
let t;
searchInput.addEventListener('input', e => {
  clearTimeout(t);
  t = setTimeout(() => familiesDirectory.setSearch(e.target.value.trim()), 300);
});
```

Standardize on Pattern A.

### 4. Grade logic: define once, import everywhere

`GRADE_ORDER`, `nextGrade()`, and `gradeLabel()` exist in both `admin.placement.js` and `admin.promotion.js`. Export them from `admin.shared.js` (or a new `admin.grades.js`) and import in both.

### 5. Page initialization: auth guard + profile load

The sequence:
1. `supabase.auth.getSession()`
2. `supabase.from('profiles').select('*').eq('user_id', user.id).single()`
3. Redirect to `/login.html` on failure
4. `initUserMenu(profile.display_name ?? profile.email)`

...is duplicated in `admin.licensure.js`, `pto.js`, `staff.html`, `substitutes.html`, and at least two other pages. Extract to a shared `initPage({ requiredCap })` async function in a new `admin.auth.js` module that returns the profile or redirects.
