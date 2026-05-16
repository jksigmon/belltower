markdown# Belltower — Internal School Operations Platform

## What It Does
Belltower is a modular, multi-school internal operations tool. Current modules:
- **PTO Management** — PTO requests, approvals, and tracking
- **Substitute Assignment** — Auto-assignment of subs based on PTO/leave requests
- **Admin Panel** — Manage students, employees, families, guardians, bus groups, access control, bulk upload/export

In progress:
- **Carline/Dismissal Module** — Managing student dismissal and carline flow

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JavaScript (no framework yet — future plan to migrate to React incrementally)
- **Backend:** Supabase (PostgreSQL + Edge Functions)
- **Auth:** Supabase Auth
- **Email:** Resend (via Supabase Edge Functions)
- **Hosting:** Vercel

## Project Structure
Belltower/
├── index.html              # Main entry / landing page
├── pto-decision.html       # PTO decision page (approve/deny)
├── admin-ui.css            # Admin panel styles
├── vercel.json             # Vercel config
├── schema.sql              # Full database schema
├── app/                    # All other HTML pages and JS files
├── auth/
│   └── callback.html       # Handles Supabase auth callback after login
├── supabase/
│   └── functions/          # Edge functions (see below)
├── icons/                  # Icon assets
└── images/                 # Image assets

## Auth Flow
1. User lands on `app/login.html`
2. Supabase Auth handles login
3. Redirects to `auth/callback.html` which completes the session and routes the user

## Database
Full schema is in `schema.sql`. Key domains:
- Schools (multi-school support)
- Employees & PTO/Leave records
- Students, Families, Guardians
- Bus Groups
- Substitute assignments
- User access/roles

**RLS is enabled on all tables.** Always check existing RLS policies before adding new tables
or queries. Never bypass RLS without explicit discussion.

## Edge Functions
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
| `send_pto_notifications` | Send email notifications to employees and PTO approvers via Resend |

## Email Notifications
Handled by the `send_pto_notifications` edge function using **Resend**. Notifications are sent to:
- The employee who submitted the PTO request
- Designated supervisors / PTO approvers

## Development Notes
- **Multi-school architecture** — always scope data queries by school, never return cross-school data
- **Vanilla JS** — avoid introducing framework dependencies unless explicitly discussed
- **Module-based design** — new features should be built as self-contained modules
- **RLS is enabled** — always account for policies when creating or modifying tables
- **Incremental React migration planned** — write JS in a way that won't conflict with future componentization