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

## UI Conventions

### Button sizing
Buttons must match their context — do not mix sizes in the same row:

| Context | Classes |
|---|---|
| Panel topbar action row (alongside a title/back button) | `btn btn-primary btn-sm` or `btn btn-outline btn-sm` |
| Section-level CTA above a table (`directory-actions`) | `btn btn-primary` (full size) |
| Drawer / form submit | `btn btn-primary` (full size) |
| Drawer / form cancel | `btn btn-outline` (full size) |

**Rule:** Any button that lives in a topbar alongside other `btn-sm` buttons must itself be `btn-sm`. A full-size `btn-primary` next to `btn-sm` peers is always wrong.

---

## Custom Slash Commands

Slash command definitions live in `.claude/commands/`. Type `/` in Claude Code to see them.
Available commands:

### /new-admin-module
Usage: `/new-admin-module [module-name] [capability-flag]`
Example: `/new-admin-module incidents can_manage_students`

Scaffolds a complete new admin module across all four required files. Do all steps:

1. **Create `app/admin.[module-name].js`**
   - Import from `'./admin.supabase.js'`
   - Module-level `_profile = null` and `_initialized = false` state
   - Export `async function init[ModuleName]Section(profile)` as the entry point
   - Wire events inside an `if (!_initialized)` guard
   - Follow the existing module pattern from `app/admin.promotion.js` as reference

2. **Add nav link in `app/admin.html`**
   - Find the Settings nav section (near `#promotion`, `#access` links)
   - Add: `<a href="#[module-name]" data-cap="[capability-flag]"><i data-lucide="ICON"></i> [Label]</a>`
   - Choose an appropriate lucide icon for the feature

3. **Add section HTML in `app/admin.html`**
   - Insert before `<section id="schools">` (the last section)
   - Use this structure:
     ```html
     <section id="[module-name]" class="admin-section">
       <div class="admin-content fade-in">
         <div class="panel">
           <h3>[Module Label]</h3>
           <div id="[module-name]Content"></div>
         </div>
       </div>
     </section>
     ```

4. **Add route in `app/admin.core.js`**
   - Find the lazy-import block (near the `#promotion` route)
   - Add:
     ```js
     if (target === '#[module-name]') {
       const mod = await import('./admin.[module-name].js');
       await mod.init[ModuleName]Section(currentProfile);
     }
     ```

After scaffolding, confirm what was created and ask what functionality to build first.

---

### /sql-migration
Usage: `/sql-migration [table-name] [brief description of what it stores]`
Example: `/sql-migration incident_reports tracks student discipline incidents`

Generates a complete, ready-to-run SQL migration using Belltower's established RLS pattern. Do all steps:

1. **Read `schema.sql`** to check if the table already exists and to understand any related tables/FKs needed.

2. **Generate the migration** using this exact RLS policy pattern (never use `is_admin` — it doesn't exist):

```sql
CREATE TABLE public.[table_name] (
  id         uuid DEFAULT gen_random_uuid() NOT NULL,
  school_id  uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- [additional columns based on description]
  CONSTRAINT [table_name]_pkey PRIMARY KEY (id)
);

ALTER TABLE public.[table_name] ENABLE ROW LEVEL SECURITY;

-- All active same-school users can read
CREATE POLICY "[table_name]_select" ON public.[table_name] FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (p.is_superadmin = true OR p.school_id = [table_name].school_id)
  ));

-- Only admins (role = 'admin') or superadmins can write
CREATE POLICY "[table_name]_all" ON public.[table_name] FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND p.status = 'active'
      AND (p.is_superadmin = true OR (p.role = 'admin' AND p.school_id = [table_name].school_id))
  ));
```

3. If the table joins through another table (not directly containing `school_id`), adapt the policy to JOIN to the parent table to get `school_id` — follow the pattern used in `placement_assignments` and `placement_session_teachers` policies.

4. Present the full SQL block ready to paste into the Supabase SQL editor. Note any FK dependencies the user needs to be aware of.

---

### /check-schema
Usage: `/check-schema [table-name]`
Example: `/check-schema employees`

Looks up a table's exact column names and types from `schema.sql` before writing any queries against it. Do all steps:

1. **Read `schema.sql`** and find the `CREATE TABLE public.[table-name]` block.
2. List every column with its type, default, and nullable status in a clean table format.
3. Also show any FK constraints that reference this table (so related tables are visible).
4. Flag any columns that are commonly confused or have non-obvious names (e.g., `position` not `employee_type`, `role = 'admin'` not `is_admin`).

If the table is not found, say so clearly and suggest similar table names that do exist.

---

### /test-and-fix
Usage: `/test-and-fix`

Runs any available tests, reviews errors, and fixes failures. Do all steps:

1. **Discover what test tooling exists** — check `package.json` for test scripts, look for test files (`*.test.js`, `*.spec.js`, `__tests__/`). If no automated tests exist, say so and skip to step 3.

2. **Run the tests** and capture all failures with their full error messages.

3. **For each failure:**
   - Read the relevant source file(s)
   - Identify the root cause (don't guess — trace the actual error)
   - Fix the code
   - Re-run only the affected test to confirm it passes before moving on

4. **Check for common Belltower-specific issues** even if no test runner exists:
   - Any `import` paths using `'./supabaseClient.js'` instead of `'./admin.supabase.js'`
   - Any column names that don't match `schema.sql` (run `/check-schema` on any queried tables)
   - Any RLS policy using `is_admin` instead of `role = 'admin'`
   - Any `employee_type` references instead of `position`

5. **Report** what was tested, what failed, what was fixed, and anything that couldn't be resolved automatically.