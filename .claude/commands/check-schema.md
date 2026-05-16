Look up a table's exact column names and types from schema.sql before writing any queries against it. The user will provide a table name as the argument (e.g. `/check-schema employees`).

Parse the table name from the invocation. If not provided, ask for it.

## Step 1 — Read schema.sql

Search `schema.sql` for `CREATE TABLE public.[table_name]` and extract the full column list.

## Step 2 — Display columns

Show a clean table with columns: **Column**, **Type**, **Default**, **Nullable**.

## Step 3 — Show FK constraints

List any foreign key constraints that reference this table (other tables that point to it), and any FKs this table has pointing outward.

## Step 4 — Flag common pitfalls

Call out any columns that are commonly confused or have non-obvious names in this project, for example:
- `employees` uses `position` (not `employee_type`)
- `profiles` uses `role = 'admin'` and `is_superadmin` (not `is_admin`)
- `students` uses `active` boolean (not `is_active`)
- Import paths must use `'./admin.supabase.js'` (not `'./supabaseClient.js'`)

If the table is not found in schema.sql, say so clearly and list any similarly-named tables that do exist.
