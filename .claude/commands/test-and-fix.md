Run any available tests, review errors, and fix failures. Then sweep for common Belltower-specific issues.

## Step 1 — Discover test tooling

Check `package.json` for test scripts. Look for test files (`*.test.js`, `*.spec.js`, `__tests__/`). If no automated tests exist, skip to Step 3.

## Step 2 — Run tests and fix failures

Run the test script. For each failure:
- Read the relevant source file
- Identify the root cause from the actual error (don't guess)
- Fix the code
- Re-run only that test to confirm it passes before moving on

## Step 3 — Sweep for common Belltower-specific issues

Even without a test runner, check for these known error patterns:

1. **Wrong import path** — search all `app/admin.*.js` files for `supabaseClient.js`. Should always be `'./admin.supabase.js'`.

2. **Wrong column names in queries** — for any `from('employees')` query, confirm it only selects `position` (not `employee_type`). For any RLS policy or profile query, confirm it uses `role = 'admin'` or `is_superadmin` (not `is_admin`).

3. **Wrong active field** — confirm student queries use `.eq('active', true)` not `.eq('is_active', true)`.

4. **Unguarded event wiring** — check that all admin modules wire DOM events inside an `if (!_initialized)` guard to prevent duplicate listeners.

5. **Missing school_id scope** — confirm every Supabase query against multi-school tables includes `.eq('school_id', ...)`.

## Step 4 — Report

List what was checked, what was fixed, and anything that needs manual attention.
