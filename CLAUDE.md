# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Belltower — Internal School Operations Platform

Belltower is a modular, multi-school internal operations tool. Current modules:
- **PTO Management** — PTO requests, approvals, and tracking
- **Substitute Assignment** — Auto-assignment of subs based on PTO/leave requests
- **Admin Panel** — Manage students, employees, families, guardians, bus groups, access control, bulk upload/export
- **Compliance** — Volunteer agreement signing and background check tracking
- **Carline/Dismissal** — Student dismissal queue, bus groups, all-call, carline events
- **Licensure** — Staff license tracking, expiry alerts, audit log

In progress:
- **Field Trips** — Trip creation, vehicle/chaperone assignment, teacher participation, payment tracking

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JavaScript (no framework — incremental React migration planned)
- **Backend:** Supabase (PostgreSQL + Edge Functions written in Deno/TypeScript)
- **Auth:** Supabase Auth
- **Email:** Resend (via Edge Functions)
- **Hosting:** Vercel

## Build & Local Development

```bash
# Install dev dependencies (only needed once)
npm install

# Generate app/config.js from environment variables (required before serving)
npm run build
```

**Local env setup:** Create `.env.local` in the project root with:
```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
```

`npm run build` reads `.env.local` and writes `app/config.js` (auto-generated — do not manually edit or commit). In Vercel CI, the vars come from the project dashboard instead.

**Deploying edge functions:**
```bash
supabase functions deploy <function-name>
```

There is no local test runner or lint script configured.

## JS Module Architecture

All frontend pages are plain HTML importing ES modules. The admin panel follows a consistent pattern:

- **`app/admin.supabase.js`** — singleton Supabase client, imported by all other modules
- **`app/admin.core.js`** — entry point for `admin.html`; handles auth check, profile load, school module flags, and delegates to tab-specific modules
- **`app/admin.shared.js`** — shared utilities: `esc()`, `debounce()`, `getAvatarColor()`, `gradeLabel()`, `GRADE_ORDER`, `nextGrade()`, `isTerminalGrade()`, `fmtTime()`, `todayISO()`, `fmtShortDate()`, `dbError()`, `cloneSelectOptions()`, `loadSchoolConfig()`, family/bus-group cache helpers
- **`app/admin.auth.js`** — shared auth guard used at the top of every standalone page; avoids duplicating the auth-check boilerplate
- **`app/admin.directory.js`** — `createDirectory(config)` abstraction: paginates, filters, sorts, and exports any Supabase table via a declarative config object (`table`, `columns`, `query`, `augmentQuery`, `onBeforeLoad`, `exportRow`). All list views in the admin panel use this; don't build custom table logic when this fits
- **`app/admin.*.js`** — one file per admin tab/domain (e.g. `admin.students.js`, `admin.staff.js`, `admin.compliance.js`)
- **`app/config.js`** — auto-generated at build time; exports `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TEMPLATE_URL`

Non-admin pages (e.g. `pto.html`, `compliance.html`, `volunteer.html`) each have a corresponding `app/<page>.js`.

**Standalone tool pages** (e.g. `app/placement.html`) are self-contained pages with their own auth boot script. The correct pattern is:
- Wrap all boot logic in an `(async () => { ... })()` IIFE so `return` statements are valid (top-level `return` is illegal in ES modules)
- Import and call `initUserMenu(displayName)` from `app/user-menu.js` to populate the header avatar/dropdown
- Wire sign-out with `supabase.auth.signOut()` + redirect
- Use `body.admin-page` grid layout (header + `.placement-main` wrapper); avoid `fade-in` class — it requires `.admin-section.active` to become visible, which doesn't exist on standalone pages
- CSS path for `admin-ui.css` must be root-relative (`/admin-ui.css`), not relative (`admin-ui.css`)

## Auth Flow
1. User lands on `app/login.html`
2. Supabase Auth handles login
3. Redirects to `auth/callback.html` which completes the session and routes the user
4. `admin.core.js` calls `claim_or_create_profile_for_user()` (a DB function) to link the auth user to an existing employee profile or create a pending one

## Database
Full schema is in `schema.sql`. Key domains:
- Schools (multi-school) + `school_modules` (per-school feature flags)
- Employees & PTO/Leave records
- Students, Families, Guardians
- Bus Groups & Carline
- Substitute assignments
- `profiles` (links auth users to roles/schools)

**Roles:** `admin`, `staff`, `front office` (defined in `role_type` enum).

**Feature flags:** `school_modules` table controls which modules are enabled per school. Known keys: `pto`, `substitutes`, `carline`, `licensure`, `compliance`. Always gate new module UI behind `currentModules['<module_key>']` in `admin.core.js`.

**RLS is enabled on all tables.** Always check existing RLS policies before adding new tables or queries. Never bypass RLS without explicit discussion.

**Database migrations:** Root-level `*.sql` files (e.g. `field-trips-migration.sql`) are ad-hoc scripts run manually against the live DB. Versioned, sequential migrations live in `supabase/migrations/` and follow the `YYYYMMDDNNNNNN_description.sql` naming pattern. New schema changes should go in `supabase/migrations/`.

## Edge Functions
All functions use the Deno runtime and `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS intentionally). Every function handles CORS preflight (`OPTIONS`) and returns JSON.

| Function | Purpose |
|---|---|
| `admin_export` | Export admin data |
| `bulk_upload_preview` | Preview bulk upload data before committing |
| `bulk_upload_commit` | Commit a previewed bulk upload |
| `bulk_upload_rollback` | Roll back a committed bulk upload |
| `export_pto_report_v2` | Export PTO reports |
| `get_pto_calendar_events_v2` | Fetch PTO events for the calendar view |
| `pto_calendar_ics` | Generate ICS calendar file for PTO events |
| `pto_decision_handler` | Handle PTO approval/denial decisions |
| `send_pto_notifications` | Send email notifications via Resend |
| `send_license_alerts` | Send licensure expiry alerts |
| `compliance_form_lookup` | Validate a form token and return template content |
| `compliance_form_submit` | Accept a signed agreement and auto-link to guardian |
| `compliance_form_pdf` | Generate a signed agreement PDF for download |
| `compliance_report` | Per-student compliance status; respects teacher/TA/manager scoping |
| `guardian_intake_lookup` | Validate a guardian intake token |
| `guardian_intake_submit` | Accept and persist guardian intake form submissions |

## Key Reference Documents
- **`app/onboarding.html`** — Admin onboarding guide: step-by-step school setup, permissions reference table, module gates, and common pitfalls. Update this whenever permissions or module behavior changes.
- **`help.html`** — End-user help center with FAQs per feature area. Update when user-facing behavior changes.
- **`TECH_DEBT.md`** — Audit of known issues and their resolution status. One open item: `supabase/functions/.env` contains a live service-role key committed to git (deferred — requires key rotation + `git filter-repo`).

## Development Notes
- **Multi-school:** always scope data queries by `school_id`, never return cross-school data
- **Vanilla JS:** avoid introducing framework dependencies unless explicitly discussed
- **Module-based design:** new features should be built as self-contained modules
- **`esc()`:** always use the shared `esc()` helper from `admin.shared.js` when interpolating user data into HTML strings to prevent XSS
- **`can_manage_placement`:** permission-gated (not module-gated) — shows Class Placement link in both Staff Portal and Admin Panel nav for the bearer. Year-End Promotion is separate and admin-only.
- **`admin.shared.js` utilities:** always prefer these over reinventing — `debounce()`, `GRADE_ORDER`/`nextGrade()`/`gradeLabel()`, `getAvatarColor()`, `todayISO()`, `fmtShortDate()`, `fmtTime()`, `dbError()`. Never write inline debounce or grade-order arrays in a new module.
