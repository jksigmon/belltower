# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Belltower — Internal School Operations Platform

Belltower is a modular, multi-school internal operations tool. Current modules:
- **PTO Management** — PTO requests, approvals, and tracking
- **Substitute Assignment** — Auto-assignment of subs based on PTO/leave requests
- **Admin Panel** — Manage students, employees, families, guardians, bus groups, access control, bulk upload/export
- **Compliance** — Volunteer agreement signing and background check tracking

In progress:
- **Carline/Dismissal Module** — Managing student dismissal and carline flow

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
- **`app/admin.shared.js`** — shared utilities (`esc()` for HTML escaping, caches for family/bus-group/school-config lookups, `loadSchoolConfig()`)
- **`app/admin.*.js`** — one file per admin tab/domain (e.g. `admin.students.js`, `admin.staff.js`, `admin.compliance.js`)
- **`app/config.js`** — auto-generated at build time; exports `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TEMPLATE_URL`

Non-admin pages (e.g. `pto.html`, `compliance.html`, `volunteer.html`) each have a corresponding `app/<page>.js`.

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

**Feature flags:** `school_modules` table controls which modules are enabled per school. Always gate new module UI behind `currentModules['<module_key>']` in `admin.core.js`.

**RLS is enabled on all tables.** Always check existing RLS policies before adding new tables or queries. Never bypass RLS without explicit discussion.

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

## Development Notes
- **Multi-school:** always scope data queries by `school_id`, never return cross-school data
- **Vanilla JS:** avoid introducing framework dependencies unless explicitly discussed
- **Module-based design:** new features should be built as self-contained modules
- **`esc()`:** always use the shared `esc()` helper from `admin.shared.js` when interpolating user data into HTML strings to prevent XSS
