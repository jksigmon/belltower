import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ─────────────────────────────────────────────────────
   ENV / CLIENT SETUP
   Single-district integration for now — one set of IC credentials,
   syncing into one Belltower school_id. Extend to loop over multiple
   schools/credential sets if a second district is ever onboarded.
───────────────────────────────────────────────────── */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const IC_CLIENT_ID = Deno.env.get("IC_CLIENT_ID")!;
const IC_CLIENT_SECRET = Deno.env.get("IC_CLIENT_SECRET")!;
const IC_TOKEN_URL = Deno.env.get("IC_TOKEN_URL")!;
const IC_BASE_URL = Deno.env.get("IC_BASE_URL")!; // e.g. https://41q.ncsis.gov/campus/api/oneroster/v1p2/psu41qrevolution/ims/oneroster
const IC_SCHOOL_ID = Deno.env.get("IC_SCHOOL_ID")!; // Belltower schools.id to sync into

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ROSTER_BASE = `${IC_BASE_URL}/rostering/v1p2`;
const PREVIEW_SAMPLE_LIMIT = 25;

const GRADE_ALIASES: Record<string, string> = {
  KG: "K",
  PK3: "PK",
  PK4: "PK",
  PREK: "PK",
};

function normalizeGrade(raw: string | undefined): string | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  const aliased = GRADE_ALIASES[upper] ?? upper;
  // IC zero-pads numeric grades ("02", "06") — Belltower stores them unpadded ("2", "6").
  return /^\d+$/.test(aliased) ? String(parseInt(aliased, 10)) : aliased;
}

// IC being blank on a field (e.g. no grade recorded yet this year) should never wipe
// out a value Belltower already has for that person — only ever fill gaps or update
// with a real value. Mutates `record` in place. Returns which fields were open gaps
// (IC blank, Belltower value preserved) vs. currently resolved (IC has a value), so
// the caller can maintain an audit trail of what's missing in IC.
function preferExistingWhenBlank(
  record: Record<string, unknown>,
  existing: Record<string, unknown> | null | undefined,
  fields: string[]
): {
  opened: { field: string; belltowerValue: unknown }[];
  resolved: string[];
  differs: { field: string; belltowerValue: unknown; icValue: unknown }[];
} {
  const opened: { field: string; belltowerValue: unknown }[] = [];
  const resolved: string[] = [];
  const differs: { field: string; belltowerValue: unknown; icValue: unknown }[] = [];
  if (!existing) return { opened, resolved, differs };
  for (const field of fields) {
    const icBlank = record[field] === null || record[field] === undefined;
    if (icBlank) {
      if (existing[field] !== null && existing[field] !== undefined) {
        opened.push({ field, belltowerValue: existing[field] });
      }
      record[field] = existing[field] ?? null;
    } else {
      resolved.push(field);
      // Covers both "Belltower has a different value" and "Belltower is blank here" —
      // either way IC has a real value Belltower doesn't currently reflect, and it's
      // worth surfacing as a pullable diff rather than silently dropping it.
      if (String(existing[field] ?? "") !== String(record[field])) {
        differs.push({ field, belltowerValue: existing[field] ?? null, icValue: record[field] });
      }
    }
  }
  return { opened, resolved, differs };
}

function generatePlaceholderTag(): string {
  return `PENDING-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

// PostgREST's .in() filter puts every id in the URL query string — with 1000+ uuids
// that can exceed URL length limits and fail silently if the error isn't checked.
// Chunk deletes and log (don't swallow) any failure.
async function deleteInChunks(table: string, ids: string[], chunkSize = 200) {
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { error } = await supabase.from(table).delete().in("id", chunk);
    if (error) {
      console.error(`Rollback: failed to delete ${chunk.length} rows from ${table}:`, error);
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Bulk-inserts rows in chunks. If a whole chunk fails (e.g. one row in it hits a unique
// constraint other than the one we're already upserting on), falls back to inserting
// that chunk's rows one at a time so a single bad row doesn't sink ~100 good ones.
// Rows failing with a unique-violation (23505) in the per-row fallback are skipped and
// logged rather than aborting the run. Returns the ids of every row actually created.
async function bulkInsert(
  table: string,
  rows: Record<string, unknown>[],
  labelForRow: (row: Record<string, unknown>) => string,
  chunkSize = 100
): Promise<string[]> {
  const createdIds: string[] = [];
  for (const batch of chunk(rows, chunkSize)) {
    const { data, error } = await supabase.from(table).insert(batch).select("id");
    if (!error) {
      createdIds.push(...(data ?? []).map((r: { id: string }) => r.id));
      continue;
    }
    // Chunk failed — retry rows individually so we can isolate and skip just the bad one(s).
    for (const row of batch) {
      const { data: single, error: rowErr } = await supabase.from(table).insert(row).select("id").single();
      if (rowErr) {
        if (rowErr.code === "23505") {
          console.warn(`Skipping duplicate ${table} row (${labelForRow(row)}):`, rowErr.message);
          continue;
        }
        throw rowErr;
      }
      createdIds.push(single.id);
    }
  }
  return createdIds;
}

// Bulk-updates rows (each must include its `id`) via upsert keyed on primary key,
// chunked the same way as bulkInsert.
async function bulkUpdate(table: string, rows: Record<string, unknown>[], chunkSize = 100) {
  for (const batch of chunk(rows, chunkSize)) {
    const { error } = await supabase.from(table).upsert(batch, { onConflict: "id" });
    if (error) throw error;
  }
}

// Opens/refreshes gap rows (school_id+entity_type+entity_id+field must be unique) —
// omitting first_detected_at from the payload means an existing row's original
// detection date is preserved; only last_detected_at/belltower_value/resolved_at move.
async function upsertGaps(rows: Record<string, unknown>[], chunkSize = 100) {
  for (const batch of chunk(rows, chunkSize)) {
    const { error } = await supabase
      .from("ic_data_gaps")
      .upsert(batch, { onConflict: "school_id,entity_type,entity_id,field" });
    if (error) throw error;
  }
}

// Marks previously-open gaps resolved now that IC has a value for that field again.
// A conditional UPDATE, not an upsert — never creates a row, just closes one if it
// happens to exist and is still open.
async function resolveGap(schoolId: string, entityType: string, entityId: string, field: string) {
  const { error } = await supabase
    .from("ic_data_gaps")
    .update({ resolved_at: new Date().toISOString() })
    .match({ school_id: schoolId, entity_type: entityType, entity_id: entityId, field })
    .is("resolved_at", null);
  if (error) console.error(`Failed to resolve gap ${entityType}/${entityId}/${field}:`, error);
}

// Opens/refreshes field-diff rows (school_id+entity_type+entity_id+field must be
// unique) — same shape as upsertGaps but for ic_field_diffs.
async function upsertDiffs(rows: Record<string, unknown>[], chunkSize = 100) {
  for (const batch of chunk(rows, chunkSize)) {
    const { error } = await supabase
      .from("ic_field_diffs")
      .upsert(batch, { onConflict: "school_id,entity_type,entity_id,field" });
    if (error) throw error;
  }
}

// Marks a previously-open field diff resolved now that Belltower and IC agree again.
async function resolveDiff(schoolId: string, entityType: string, entityId: string, field: string) {
  const { error } = await supabase
    .from("ic_field_diffs")
    .update({ resolved_at: new Date().toISOString() })
    .match({ school_id: schoolId, entity_type: entityType, entity_id: entityId, field })
    .is("resolved_at", null);
  if (error) console.error(`Failed to resolve diff ${entityType}/${entityId}/${field}:`, error);
}

function errToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr.message === "string") return anyErr.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvEscape).join(",") + "\r\n";
}

const FIELD_LABELS: Record<string, string> = {
  grade_level: "Grade",
  birthdate: "Date of Birth",
  student_number: "Student #",
  email: "Email",
  phone: "Phone",
  name: "Name",
  active: "Active status",
  guardian_link: "Linked to student",
  family: "Family",
};

// One flat CSV covering everything different between Belltower and Infinite Campus —
// intended to be emailed as-is to whoever manages data in IC (e.g. Polaris), since IC
// changes require a support request rather than a direct edit.
function buildDiffCsv(plan: Awaited<ReturnType<typeof buildPlan>>, pendingCandidates: any[]): string {
  let csv = csvRow(["Category", "Type", "Name", "Field", "Belltower Value", "Infinite Campus Value", "Notes"]);

  for (const d of plan.fieldDiffChecks.filter((d) => d.hasDiff)) {
    csv += csvRow([
      "Field difference",
      d.entityType,
      d.label,
      FIELD_LABELS[d.field] ?? d.field,
      d.belltowerValue,
      d.icValue,
      "",
    ]);
  }

  for (const d of plan.deactivatePlans) {
    csv += csvRow(["Recommend deactivate", "student", d.label, "Active", "Active", "Not in IC roster", ""]);
  }

  for (const c of pendingCandidates) {
    const existing = c.existing_data ?? {};
    const proposed = c.proposed_data ?? {};
    if (c.match_reason === "new_record") {
      const name = `${proposed.first_name ?? ""} ${proposed.last_name ?? ""}`.trim();
      csv += csvRow(["Awaiting review — new record", c.entity_type, name, "", "(does not exist)", JSON.stringify(proposed), c.match_reason]);
    } else if (c.match_reason === "deactivate") {
      const name = `${existing.first_name ?? ""} ${existing.last_name ?? ""}`.trim();
      csv += csvRow(["Awaiting review — recommend deactivate", "student", name, "Active", "Active", "Not in IC roster", ""]);
    } else if (c.entity_type === "family") {
      csv += csvRow([
        "Awaiting review — possible household match",
        "family",
        existing.family_name ?? "(unnamed)",
        "",
        `#${existing.carline_tag_number ?? "—"} (${existing.student_count ?? 0} students, ${existing.guardian_count ?? 0} guardians)`,
        `New household for: ${(proposed.students ?? []).join(", ")}`,
        c.match_reason,
      ]);
    } else {
      const name = `${existing.first_name ?? ""} ${existing.last_name ?? ""}`.trim();
      csv += csvRow([
        "Awaiting review — possible match",
        c.entity_type,
        name,
        "",
        JSON.stringify(existing),
        JSON.stringify(proposed),
        c.match_reason,
      ]);
    }
  }

  return csv;
}

/* ─────────────────────────────────────────────────────
   ONEROSTER CLIENT HELPERS
───────────────────────────────────────────────────── */
async function getAccessToken(): Promise<string> {
  const basicAuth = btoa(`${IC_CLIENT_ID}:${IC_CLIENT_SECRET}`);
  const res = await fetch(IC_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`IC token request failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return json.access_token;
}

async function fetchAllPages(token: string, path: string, collectionKey: string): Promise<any[]> {
  const results: any[] = [];
  const limit = 100;
  let offset = 0;
  let pageNum = 0;
  while (true) {
    const url = `${ROSTER_BASE}${path}${path.includes("?") ? "&" : "?"}limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const totalCountHeader = res.headers.get("x-total-count");
    if (!res.ok) throw new Error(`IC request failed for ${url} (${res.status}): ${await res.text()}`);
    const json = await res.json();
    const page = json[collectionKey] ?? [];
    console.log(
      `[fetchAllPages] ${path} page=${pageNum} offset=${offset} got=${page.length} x-total-count=${totalCountHeader ?? "n/a"}`
    );
    results.push(...page);
    if (page.length < limit) break;
    offset += limit;
    pageNum++;
  }
  console.log(`[fetchAllPages] ${path} TOTAL=${results.length}`);
  return results;
}

// Supabase/PostgREST caps .select() at 1000 rows by default — silently, no error.
// A district with 1000+ students/guardians (true for this one) would otherwise get
// truncated results here, misclassifying already-linked people as new on whichever
// arbitrary rows happen to fall outside the first page. Page through with .range()
// until a page comes back short.
async function fetchAllRows<T>(
  table: string,
  build: (query: ReturnType<typeof supabase.from>) => any,
  pageSize = 1000
): Promise<T[]> {
  const results: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await build(supabase.from(table)).range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as T[];
    results.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return results;
}

/* ─────────────────────────────────────────────────────
   UNION-FIND for guardian-based sibling grouping
───────────────────────────────────────────────────── */
class UnionFind {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/* ─────────────────────────────────────────────────────
   BUILD A SYNC PLAN
   Fetches everything from Infinite Campus and diffs it against Belltower's
   current state. Produces the same plan whether this is a dry run (preview)
   or a real run (execute) — dry runs just stop before touching the DB.
───────────────────────────────────────────────────── */
type Classification =
  | { kind: "linked" | "pending" | "needs_staging"; existing: any }
  | { kind: "approved"; existing: any; fieldOverrides: string[] }
  | { kind: "rejected" | "new_approved" | "new_pending" | "new_rejected" | "new_needs_staging" };

async function buildPlan() {
  const token = await getAccessToken();

  // IC's /users endpoint doesn't support filter=role='guardian' (returns "invalid_filter_field"),
  // so pull everyone and filter locally by their roles array.
  const [icStudents, icAllUsers, icDemographics] = await Promise.all([
    fetchAllPages(token, "/students", "users"),
    fetchAllPages(token, "/users", "users"),
    fetchAllPages(token, "/demographics", "demographics"),
  ]);

  const icGuardians = icAllUsers.filter((u: any) =>
    (u.roles ?? []).some((r: any) => r.role === "guardian")
  );

  const demographicsBySourcedId = new Map(icDemographics.map((d: any) => [d.sourcedId, d]));
  const guardianBySourcedId = new Map(icGuardians.map((g: any) => [g.sourcedId, g]));

  // Fetch every student/guardian in the school, not just ones already linked to IC —
  // needed to reconcile against records entered manually before this integration
  // existed (e.g. via bulk upload), so the first sync updates them instead of
  // creating duplicates.
  const allStudents = await fetchAllRows<any>("students", (q) =>
    q
      .select("id, ic_sourced_id, family_id, first_name, last_name, student_number, grade_level, birthdate, active")
      .eq("school_id", IC_SCHOOL_ID)
  );

  const allGuardians = await fetchAllRows<any>("guardians", (q) =>
    q.select("id, ic_sourced_id, family_id, first_name, last_name, email, phone").eq("school_id", IC_SCHOOL_ID)
  );

  const candidates = await fetchAllRows<any>("ic_reconciliation_candidates", (q) =>
    q.select("*").eq("school_id", IC_SCHOOL_ID)
  );

  // So a "resolved" check only fires a DB call when a gap could actually be open —
  // without this, every already-fine field on every already-linked student would
  // trigger a no-op resolve call every single run (thousands of wasted round-trips).
  const openGaps = await fetchAllRows<any>("ic_data_gaps", (q) =>
    q.select("entity_type, entity_id, field").eq("school_id", IC_SCHOOL_ID).is("resolved_at", null)
  );
  const openGapKeys = new Set(openGaps.map((g) => `${g.entity_type}:${g.entity_id}:${g.field}`));

  const openDiffs = await fetchAllRows<any>("ic_field_diffs", (q) =>
    q.select("entity_type, entity_id, field").eq("school_id", IC_SCHOOL_ID).is("resolved_at", null)
  );
  const openDiffKeys = new Set(openDiffs.map((d) => `${d.entity_type}:${d.entity_id}:${d.field}`));

  // Which fields the sync is even allowed to touch on already-linked people. Belltower
  // is the day-to-day system of record here (IC changes require emailing a third
  // party), so most fields default to report-only rather than auto-overwriting —
  // disabled fields are simply omitted from update payloads (never touched) and show
  // up in the diff export instead. New records aren't affected — nothing exists yet to
  // protect, so a freshly-created row gets every field.
  const { data: fieldSettingsRow } = await supabase
    .from("ic_sync_field_settings")
    .select("*")
    .eq("school_id", IC_SCHOOL_ID)
    .maybeSingle();
  const fieldSettings = {
    grade_level: fieldSettingsRow?.sync_grade_level ?? false,
    birthdate: fieldSettingsRow?.sync_date_of_birth ?? false,
    student_number: fieldSettingsRow?.sync_student_number ?? false,
    email: fieldSettingsRow?.sync_email ?? false,
    phone: fieldSettingsRow?.sync_phone ?? false,
  };

  const allStudentsById = new Map(allStudents.map((s) => [s.id, s]));
  const allGuardiansById = new Map(allGuardians.map((g) => [g.id, g]));
  const candidateByKey = new Map(candidates.map((c) => [`${c.entity_type}:${c.ic_sourced_id}`, c]));

  const existingStudentBySourcedId = new Map(
    allStudents.filter((s) => s.ic_sourced_id).map((s) => [s.ic_sourced_id, s])
  );
  const existingGuardianBySourcedId = new Map(
    allGuardians.filter((g) => g.ic_sourced_id).map((g) => [g.ic_sourced_id, g])
  );

  // Heuristic-match pools: records never linked to IC (ic_sourced_id is null) and not
  // already staged as a reconciliation candidate. If more than one unlinked row shares
  // a key, we can't tell them apart — leave them all unmatched rather than guess.
  const unlinkedStudentByName = new Map<string, (typeof allStudents)[number] | null>();
  for (const s of allStudents) {
    if (s.ic_sourced_id) continue;
    const key = `${(s.first_name ?? "").toLowerCase()}|${(s.last_name ?? "").toLowerCase()}`;
    unlinkedStudentByName.set(key, unlinkedStudentByName.has(key) ? null : s);
  }

  const unlinkedGuardianByEmail = new Map<string, (typeof allGuardians)[number] | null>();
  for (const g of allGuardians) {
    if (g.ic_sourced_id || !g.email) continue;
    const key = g.email.toLowerCase();
    unlinkedGuardianByEmail.set(key, unlinkedGuardianByEmail.has(key) ? null : g);
  }

  // A "new record" candidate staged in an earlier run stays exactly as staged even if
  // a matching manual record shows up in Belltower afterward (e.g. staff pre-creating
  // the student ahead of review) — nothing re-evaluates it once written. Self-heal:
  // if a still-pending "new record" candidate now has a heuristic match available,
  // upgrade it in place to a proper reconciliation candidate (real run only).
  const candidateUpgrades: { id: string; existing_record_id: string; existing_data: any; match_reason: string }[] = [];

  // A heuristic match (name+grade for students, email for guardians) against a
  // pre-existing manually-entered record is never auto-applied — it's staged in
  // ic_reconciliation_candidates for a human to approve/reject first. Only once
  // approved does the next run treat it as a confirmed match and write the update.
  //
  // Brand-new records (never seen before, no existing match at all) go through the
  // same staging: Belltower is the day-to-day system of record here (IC changes
  // require emailing a third party), so nothing gets created without a human accepting
  // it — not even an unambiguous new IC student.
  function classifyStudent(student: any): Classification {
    const linked = existingStudentBySourcedId.get(student.sourcedId);
    if (linked) return { kind: "linked", existing: linked };

    const cand = candidateByKey.get(`student:${student.sourcedId}`);
    if (cand) {
      if (cand.status === "approved") {
        if (!cand.existing_record_id) return { kind: "new_approved" };
        const existing = allStudentsById.get(cand.existing_record_id);
        return existing
          ? { kind: "approved", existing, fieldOverrides: Array.isArray(cand.field_overrides) ? cand.field_overrides : [] }
          : { kind: "new_approved" };
      }
      if (cand.status === "rejected") {
        return cand.existing_record_id ? { kind: "rejected" } : { kind: "new_rejected" };
      }
      if (cand.status === "pending" && !cand.existing_record_id) {
        const key = `${(student.givenName ?? "").toLowerCase()}|${(student.familyName ?? "").toLowerCase()}`;
        const heuristic = unlinkedStudentByName.get(key);
        if (heuristic) {
          unlinkedStudentByName.delete(key);
          candidateUpgrades.push({
            id: cand.id,
            existing_record_id: heuristic.id,
            existing_data: heuristic,
            match_reason: "name_match",
          });
        }
        return { kind: "new_pending" };
      }
      return cand.existing_record_id
        ? { kind: "pending", existing: allStudentsById.get(cand.existing_record_id) }
        : { kind: "new_pending" };
    }

    // Matching on name only (not grade too): a stale manual record may be a grade
    // behind IC after a promotion, and since every match goes through human review
    // anyway, there's no auto-apply risk in casting a wider net here.
    const key = `${(student.givenName ?? "").toLowerCase()}|${(student.familyName ?? "").toLowerCase()}`;
    const heuristic = unlinkedStudentByName.get(key);
    if (heuristic) {
      unlinkedStudentByName.delete(key); // consume so it's matched at most once
      return { kind: "needs_staging", existing: heuristic };
    }
    return { kind: "new_needs_staging" };
  }

  function classifyGuardian(sourcedId: string, guardian: any): Classification {
    const linked = existingGuardianBySourcedId.get(sourcedId);
    if (linked) return { kind: "linked", existing: linked };

    const cand = candidateByKey.get(`guardian:${sourcedId}`);
    if (cand) {
      if (cand.status === "approved") {
        if (!cand.existing_record_id) return { kind: "new_approved" };
        const existing = allGuardiansById.get(cand.existing_record_id);
        return existing
          ? { kind: "approved", existing, fieldOverrides: Array.isArray(cand.field_overrides) ? cand.field_overrides : [] }
          : { kind: "new_approved" };
      }
      if (cand.status === "rejected") {
        return cand.existing_record_id ? { kind: "rejected" } : { kind: "new_rejected" };
      }
      if (cand.status === "pending" && !cand.existing_record_id) {
        const email = guardian.email?.toLowerCase();
        const heuristic = email ? unlinkedGuardianByEmail.get(email) : null;
        if (heuristic) {
          unlinkedGuardianByEmail.delete(email);
          candidateUpgrades.push({
            id: cand.id,
            existing_record_id: heuristic.id,
            existing_data: heuristic,
            match_reason: "email_match",
          });
        }
        return { kind: "new_pending" };
      }
      return cand.existing_record_id
        ? { kind: "pending", existing: allGuardiansById.get(cand.existing_record_id) }
        : { kind: "new_pending" };
    }

    const email = guardian.email?.toLowerCase();
    const heuristic = email ? unlinkedGuardianByEmail.get(email) : null;
    if (heuristic) {
      unlinkedGuardianByEmail.delete(email);
      return { kind: "needs_staging", existing: heuristic };
    }
    return { kind: "new_needs_staging" };
  }

  const studentClassBySourcedId = new Map(icStudents.map((s: any) => [s.sourcedId, classifyStudent(s)]));
  const guardianClassBySourcedId = new Map(
    [...guardianBySourcedId].map(([sourcedId, g]) => [sourcedId, classifyGuardian(sourcedId, g)])
  );

  /* ---- Group students into sibling families via shared guardians ---- */
  const uf = new UnionFind();
  const guardianSourcedIdsInPull = new Set<string>();
  for (const student of icStudents) {
    uf.find(student.sourcedId);
    for (const agent of student.agents ?? []) {
      uf.union(student.sourcedId, `guardian:${agent.sourcedId}`);
      guardianSourcedIdsInPull.add(agent.sourcedId);
    }
  }

  const groups = new Map<string, string[]>(); // root -> student sourcedIds
  for (const student of icStudents) {
    const root = uf.find(student.sourcedId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(student.sourcedId);
  }

  /* ---- Decide which family groups are new vs. already-linked/reconciled ---- */
  // Any classification carrying an `existing` record (linked, approved, pending, or
  // needs_staging) can lend its family_id to the group — even if that student itself
  // isn't being written this run (still pending review), so siblings that ARE new
  // join the real household instead of getting a stray placeholder family.
  const familyKeyByStudentSourcedId = new Map<string, string>();
  const familyPlans = new Map<string, { isNew: boolean; existingFamilyId: string | null; derivedName: string | null }>();
  const heldBackFamilyKeys = new Set<string>(); // groups whose family match is still pending review
  for (const [root, studentSourcedIds] of groups) {
    let existingFamilyId: string | null = null;
    for (const sid of studentSourcedIds) {
      const cls = studentClassBySourcedId.get(sid);
      const existingFamId = cls && "existing" in cls ? cls.existing?.family_id : null;
      if (existingFamId) {
        existingFamilyId = existingFamId;
        break;
      }
    }
    familyPlans.set(root, { isNew: !existingFamilyId, existingFamilyId, derivedName: null });
    for (const sid of studentSourcedIds) familyKeyByStudentSourcedId.set(sid, root);
  }

  // For groups with no existing household found at all, check whether a pre-existing
  // Belltower family (bulk-loaded with a real carline tag before any students were
  // ever linked to it — e.g. "Morrow" #29 with 0 members) looks like a match by name,
  // before creating yet another placeholder household. Routed through the same
  // approve/reject review as everything else, since a name match is still a guess.
  const allFamilies = await fetchAllRows<any>("families", (q) =>
    q.select("id, family_name, carline_tag_number").eq("school_id", IC_SCHOOL_ID)
  );
  const familiesByLowerName = new Map<string, any[]>();
  for (const f of allFamilies) {
    if (!f.family_name) continue;
    const key = f.family_name.trim().toLowerCase();
    if (!familiesByLowerName.has(key)) familiesByLowerName.set(key, []);
    familiesByLowerName.get(key)!.push(f);
  }
  const claimedFamilyIds = new Set(
    [...familyPlans.values()].map((f) => f.existingFamilyId).filter((id): id is string => !!id)
  );

  const familyCandidatesToStage: Record<string, unknown>[] = [];
  for (const [root, studentSourcedIds] of groups) {
    const familyPlan = familyPlans.get(root)!;
    if (!familyPlan.isNew) continue; // already resolved to a real household

    // Only consider members that will actually be written this run (approved-to-create
    // or a heuristic-rejection turned genuinely-new) — if everything in the group is
    // still an unapproved "new_needs_staging"/"new_pending", there's nothing to home
    // yet and no reason to suggest a family match before that's resolved.
    const newMembers = studentSourcedIds
      .map((sid) => icStudents.find((s: any) => s.sourcedId === sid))
      .filter((s: any) => {
        const cls = studentClassBySourcedId.get(s.sourcedId);
        return cls?.kind === "new_approved" || cls?.kind === "rejected";
      });
    if (!newMembers.length) continue; // nothing being written for this group anyway

    // Stable identity for this group across runs: the union-find root is arbitrary
    // per-invocation, but the lexicographically-smallest member sourcedId is not.
    const stableGroupKey = [...studentSourcedIds].sort()[0];
    const cand = candidateByKey.get(`family:${stableGroupKey}`);

    if (cand) {
      if (cand.status === "approved" && !claimedFamilyIds.has(cand.existing_record_id)) {
        familyPlan.existingFamilyId = cand.existing_record_id;
        familyPlan.isNew = false;
        claimedFamilyIds.add(cand.existing_record_id);
      } else if (cand.status === "pending") {
        heldBackFamilyKeys.add(root);
      }
      // rejected (or approved-but-already-claimed) — fall through, create a fresh family as usual.
      continue;
    }

    const lastNameCounts = new Map<string, number>();
    for (const m of newMembers) {
      const ln = (m.familyName ?? "").trim();
      if (ln) lastNameCounts.set(ln, (lastNameCounts.get(ln) ?? 0) + 1);
    }
    const derivedName = [...lastNameCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    familyPlan.derivedName = derivedName;
    if (!derivedName) continue;

    const nameMatches = (familiesByLowerName.get(derivedName.toLowerCase()) ?? []).filter(
      (f) => !claimedFamilyIds.has(f.id)
    );
    if (nameMatches.length !== 1) continue; // none or ambiguous — just create fresh, as before

    const targetFamily = nameMatches[0];
    const [{ count: studentCount }, { count: guardianCount }] = await Promise.all([
      supabase.from("students").select("id", { count: "exact", head: true }).eq("family_id", targetFamily.id),
      supabase.from("guardians").select("id", { count: "exact", head: true }).eq("family_id", targetFamily.id),
    ]);

    familyCandidatesToStage.push({
      school_id: IC_SCHOOL_ID,
      entity_type: "family",
      ic_sourced_id: `family:${stableGroupKey}`,
      existing_record_id: targetFamily.id,
      match_reason: "family_name_match",
      existing_data: {
        family_name: targetFamily.family_name,
        carline_tag_number: targetFamily.carline_tag_number,
        student_count: studentCount ?? 0,
        guardian_count: guardianCount ?? 0,
      },
      proposed_data: {
        family_name: derivedName,
        students: newMembers.map((m: any) => `${m.givenName} ${m.familyName}`),
      },
    });
    heldBackFamilyKeys.add(root);
  }

  // Audit trail of fields IC is currently blank on where Belltower has a value we're
  // preserving (see preferExistingWhenBlank) — surfaced in the admin UI so staff can
  // flag real data gaps with whoever manages Infinite Campus.
  const dataGapChecks: {
    entityType: "student" | "guardian";
    entityId: string;
    sourcedId: string;
    field: string;
    belltowerValue: unknown;
    hasGap: boolean;
  }[] = [];

  // For the diff export and the persistent "Field Differences" audit: fields where
  // both Belltower and IC have a value but they disagree — regardless of whether that
  // field is currently enabled for auto-sync. hasDiff:false entries are previously-open
  // diffs that now match, so the persistent audit row can be closed.
  const fieldDiffChecks: {
    entityType: "student" | "guardian";
    entityId: string;
    sourcedId: string;
    label: string;
    field: string;
    belltowerValue: unknown;
    icValue: unknown;
    hasDiff: boolean;
  }[] = [];

  /* ---- Guardian plan ---- */
  const guardianPlans: {
    sourcedId: string;
    isNew: boolean;
    existingId: string | null;
    existingFamilyId: string | null;
    record: Record<string, unknown>;
    familyKey: string | null;
    label: string;
  }[] = [];
  const guardianCandidatesToStage: Record<string, unknown>[] = [];

  for (const [sourcedId, guardian] of guardianBySourcedId) {
    const cls = guardianClassBySourcedId.get(sourcedId)!;
    const anyStudent = icStudents.find((s: any) =>
      (s.agents ?? []).some((a: any) => a.sourcedId === sourcedId)
    );
    const familyKey = anyStudent ? familyKeyByStudentSourcedId.get(anyStudent.sourcedId) ?? null : null;
    const label = `${guardian.givenName ?? ""} ${guardian.familyName ?? ""}`.trim();
    const record = {
      school_id: IC_SCHOOL_ID,
      ic_sourced_id: sourcedId,
      first_name: guardian.givenName ?? null,
      last_name: guardian.familyName ?? null,
      email: guardian.email ?? null,
      phone: guardian.sms ?? null,
      last_synced_at: new Date().toISOString(),
    };
    const gapResult = "existing" in cls ? preferExistingWhenBlank(record, cls.existing, ["email", "phone"]) : null;

    // "pending"/"new_pending": already staged, awaiting a human decision — untouched.
    // "new_rejected": explicitly told not to create this person — never revisit.
    if (cls.kind === "pending" || cls.kind === "new_pending" || cls.kind === "new_rejected") continue;
    if (familyKey && heldBackFamilyKeys.has(familyKey)) continue; // household match still awaiting review
    if (cls.kind === "needs_staging") {
      guardianCandidatesToStage.push({
        school_id: IC_SCHOOL_ID,
        entity_type: "guardian",
        ic_sourced_id: sourcedId,
        existing_record_id: cls.existing.id,
        match_reason: "email_match",
        existing_data: cls.existing,
        proposed_data: record,
      });
      continue;
    }
    if (cls.kind === "new_needs_staging") {
      // Belltower is the system of record day-to-day here — even an unambiguous
      // brand-new IC guardian waits for a human to accept it, same as everything else.
      guardianCandidatesToStage.push({
        school_id: IC_SCHOOL_ID,
        entity_type: "guardian",
        ic_sourced_id: sourcedId,
        existing_record_id: null,
        match_reason: "new_record",
        existing_data: {},
        proposed_data: record,
      });
      continue;
    }

    const existing = cls.kind === "linked" || cls.kind === "approved" ? cls.existing : null;
    const fieldOverrides = cls.kind === "approved" ? cls.fieldOverrides : [];
    // Only track the data-gap audit once a match is confirmed (linked or approved) —
    // not for a still-pending guess that might get rejected.
    if (existing && gapResult) {
      for (const { field, belltowerValue } of gapResult.opened) {
        dataGapChecks.push({ entityType: "guardian", entityId: existing.id, sourcedId, field, belltowerValue, hasGap: true });
      }
      for (const field of gapResult.resolved) {
        if (!openGapKeys.has(`guardian:${existing.id}:${field}`)) continue;
        dataGapChecks.push({ entityType: "guardian", entityId: existing.id, sourcedId, field, belltowerValue: null, hasGap: false });
      }
      const guardianDifferFields = new Set(gapResult.differs.map((d) => d.field));
      for (const d of gapResult.differs) {
        fieldDiffChecks.push({ entityType: "guardian", entityId: existing.id, sourcedId, label, hasDiff: true, ...d });
      }
      for (const field of gapResult.resolved) {
        if (guardianDifferFields.has(field)) continue; // still differs, not a resolve candidate
        if (!openDiffKeys.has(`guardian:${existing.id}:${field}`)) continue;
        fieldDiffChecks.push({
          entityType: "guardian",
          entityId: existing.id,
          sourcedId,
          label,
          field,
          belltowerValue: null,
          icValue: null,
          hasDiff: false,
        });
      }
      // Field is disabled for auto-sync — leave Belltower's value untouched on this
      // update, unless the reviewer specifically opted this one record in when
      // approving (a per-record override doesn't change the global setting).
      if (!fieldSettings.email && !fieldOverrides.includes("email")) delete record.email;
      if (!fieldSettings.phone && !fieldOverrides.includes("phone")) delete record.phone;

      // IC has no per-guardian "active" flag we sync on — the real signal that a
      // guardian was dropped from a student (e.g. a custody change) is that they no
      // longer show up in any current student's agents[] list, even though the person
      // still exists as a "guardian" user in IC. Belltower never removes anyone
      // automatically; this is informational only, so a human can go check the family
      // in the Admin Panel and decide whether to remove them there.
      if (!guardianSourcedIdsInPull.has(sourcedId)) {
        fieldDiffChecks.push({
          entityType: "guardian",
          entityId: existing.id,
          sourcedId,
          label,
          field: "guardian_link",
          belltowerValue: "Linked in Belltower",
          icValue: "No longer linked to any student in Infinite Campus",
          hasDiff: true,
        });
      } else if (openDiffKeys.has(`guardian:${existing.id}:guardian_link`)) {
        fieldDiffChecks.push({
          entityType: "guardian",
          entityId: existing.id,
          sourcedId,
          label,
          field: "guardian_link",
          belltowerValue: null,
          icValue: null,
          hasDiff: false,
        });
      }
    }
    guardianPlans.push({
      sourcedId,
      isNew: !existing,
      existingId: existing?.id ?? null,
      existingFamilyId: existing?.family_id ?? null,
      familyKey,
      label,
      record,
    });
  }

  /* ---- Student plan ---- */
  const studentPlans: {
    sourcedId: string;
    isNew: boolean;
    existingId: string | null;
    existingFamilyId: string | null;
    familyKey: string | null;
    label: string;
    record: Record<string, unknown>;
  }[] = [];
  const studentCandidatesToStage: Record<string, unknown>[] = [];

  for (const student of icStudents) {
    const cls = studentClassBySourcedId.get(student.sourcedId)!;
    const demo = demographicsBySourcedId.get(student.sourcedId);
    const familyKey = familyKeyByStudentSourcedId.get(student.sourcedId) ?? null;
    const record = {
      school_id: IC_SCHOOL_ID,
      ic_sourced_id: student.sourcedId,
      student_number: student.identifier ?? null,
      first_name: student.givenName,
      last_name: student.familyName,
      grade_level: normalizeGrade(student.grades?.[0]),
      birthdate: demo?.birthDate ?? null,
      active: student.status === "active",
      last_synced_at: new Date().toISOString(),
    };
    // active is a real boolean signal (enrollment status), never a "blank" to fill —
    // deliberately excluded here so IC's active/inactive status always wins.
    const gapResult =
      "existing" in cls
        ? preferExistingWhenBlank(record, cls.existing, ["grade_level", "birthdate", "student_number"])
        : null;

    if (cls.kind === "pending" || cls.kind === "new_pending" || cls.kind === "new_rejected") continue;
    if (familyKey && heldBackFamilyKeys.has(familyKey)) continue; // household match still awaiting review
    if (cls.kind === "needs_staging") {
      studentCandidatesToStage.push({
        school_id: IC_SCHOOL_ID,
        entity_type: "student",
        ic_sourced_id: student.sourcedId,
        existing_record_id: cls.existing.id,
        match_reason: "name_match",
        existing_data: cls.existing,
        proposed_data: record,
      });
      continue;
    }
    if (cls.kind === "new_needs_staging") {
      studentCandidatesToStage.push({
        school_id: IC_SCHOOL_ID,
        entity_type: "student",
        ic_sourced_id: student.sourcedId,
        existing_record_id: null,
        match_reason: "new_record",
        existing_data: {},
        proposed_data: record,
      });
      continue;
    }

    const existing = cls.kind === "linked" || cls.kind === "approved" ? cls.existing : null;
    const fieldOverrides = cls.kind === "approved" ? cls.fieldOverrides : [];
    if (existing && gapResult) {
      for (const { field, belltowerValue } of gapResult.opened) {
        dataGapChecks.push({
          entityType: "student",
          entityId: existing.id,
          sourcedId: student.sourcedId,
          field,
          belltowerValue,
          hasGap: true,
        });
      }
      for (const field of gapResult.resolved) {
        if (!openGapKeys.has(`student:${existing.id}:${field}`)) continue;
        dataGapChecks.push({
          entityType: "student",
          entityId: existing.id,
          sourcedId: student.sourcedId,
          field,
          belltowerValue: null,
          hasGap: false,
        });
      }
      const studentDifferFields = new Set(gapResult.differs.map((d) => d.field));
      for (const d of gapResult.differs) {
        fieldDiffChecks.push({
          entityType: "student",
          entityId: existing.id,
          sourcedId: student.sourcedId,
          label: `${student.givenName ?? ""} ${student.familyName ?? ""}`.trim(),
          hasDiff: true,
          ...d,
        });
      }
      for (const field of gapResult.resolved) {
        if (studentDifferFields.has(field)) continue;
        if (!openDiffKeys.has(`student:${existing.id}:${field}`)) continue;
        fieldDiffChecks.push({
          entityType: "student",
          entityId: existing.id,
          sourcedId: student.sourcedId,
          label: `${student.givenName ?? ""} ${student.familyName ?? ""}`.trim(),
          field,
          belltowerValue: null,
          icValue: null,
          hasDiff: false,
        });
      }
      // Field is disabled globally, unless the reviewer opted this one record in when
      // approving — a per-record override doesn't flip the global setting.
      if (!fieldSettings.grade_level && !fieldOverrides.includes("grade_level")) delete record.grade_level;
      if (!fieldSettings.birthdate && !fieldOverrides.includes("birthdate")) delete record.birthdate;
      if (!fieldSettings.student_number && !fieldOverrides.includes("student_number")) delete record.student_number;

      // Name, active status, and family assignment are never checkbox-controlled —
      // treated as identity/status changes that always require a human, same tier as
      // new records, deactivations, and family matches. Report the difference (name,
      // active) if there is one, but never write it here.
      if (existing.first_name !== record.first_name || existing.last_name !== record.last_name) {
        fieldDiffChecks.push({
          entityType: "student",
          entityId: existing.id,
          sourcedId: student.sourcedId,
          label: `${existing.first_name} ${existing.last_name}`,
          field: "name",
          belltowerValue: `${existing.first_name} ${existing.last_name}`,
          icValue: `${record.first_name} ${record.last_name}`,
          hasDiff: true,
        });
      } else if (openDiffKeys.has(`student:${existing.id}:name`)) {
        fieldDiffChecks.push({
          entityType: "student",
          entityId: existing.id,
          sourcedId: student.sourcedId,
          label: `${existing.first_name} ${existing.last_name}`,
          field: "name",
          belltowerValue: null,
          icValue: null,
          hasDiff: false,
        });
      }
      if (existing.active !== record.active) {
        fieldDiffChecks.push({
          entityType: "student",
          entityId: existing.id,
          sourcedId: student.sourcedId,
          label: `${existing.first_name} ${existing.last_name}`,
          field: "active",
          belltowerValue: existing.active ? "Active" : "Inactive",
          icValue: record.active ? "Active" : "Inactive",
          hasDiff: true,
        });
      } else if (openDiffKeys.has(`student:${existing.id}:active`)) {
        fieldDiffChecks.push({
          entityType: "student",
          entityId: existing.id,
          sourcedId: student.sourcedId,
          label: `${existing.first_name} ${existing.last_name}`,
          field: "active",
          belltowerValue: null,
          icValue: null,
          hasDiff: false,
        });
      }
      // Family reassignment is never auto-applied — see the note on studentsToUpdate/
      // guardiansToUpdate in executePlan for why. But if a student's own linked
      // guardians (via IC's current agents[] for them) actually live in a DIFFERENT
      // Belltower family than the student does, that's a real signal (e.g. a custody
      // change moved the household in IC) worth surfacing so a human can go fix it in
      // the Admin Panel, rather than silently diverging forever.
      const linkedGuardianFamilyIds = new Set(
        (student.agents ?? [])
          .map((a: any) => existingGuardianBySourcedId.get(a.sourcedId)?.family_id)
          .filter((id: string | undefined): id is string => !!id && id !== existing.family_id)
      );
      if (linkedGuardianFamilyIds.size > 0) {
        fieldDiffChecks.push({
          entityType: "student",
          entityId: existing.id,
          sourcedId: student.sourcedId,
          label: `${existing.first_name} ${existing.last_name}`,
          field: "family",
          belltowerValue: "Current Belltower family",
          icValue: "Linked guardian(s) belong to a different Belltower family",
          hasDiff: true,
        });
      } else if (openDiffKeys.has(`student:${existing.id}:family`)) {
        fieldDiffChecks.push({
          entityType: "student",
          entityId: existing.id,
          sourcedId: student.sourcedId,
          label: `${existing.first_name} ${existing.last_name}`,
          field: "family",
          belltowerValue: null,
          icValue: null,
          hasDiff: false,
        });
      }

      record.first_name = existing.first_name;
      record.last_name = existing.last_name;
      delete record.active;
    }
    studentPlans.push({
      sourcedId: student.sourcedId,
      isNew: !existing,
      existingId: existing?.id ?? null,
      existingFamilyId: existing?.family_id ?? null,
      familyKey,
      label: `${student.givenName ?? ""} ${student.familyName ?? ""}`.trim(),
      record,
    });
  }

  /* ---- Students to deactivate: previously synced, absent from this pull ----
     Same "nothing changes without a human" rule applies here — a student vanishing
     from an IC pull could be a real withdrawal or (as seen firsthand this session)
     a flaky/partial IC response. Stage it for review rather than deactivating
     immediately; only actually flip active=false once approved. */
  const seenSourcedIds = new Set(icStudents.map((s: any) => s.sourcedId));
  const missingFromPull = [...existingStudentBySourcedId.values()].filter(
    (s) => !seenSourcedIds.has(s.ic_sourced_id)
  );

  const deactivatePlans: { id: string; label: string }[] = [];
  const deactivateCandidatesToStage: Record<string, unknown>[] = [];
  for (const s of missingFromPull) {
    const label = `${s.first_name} ${s.last_name}`;
    const cand = candidateByKey.get(`student:${s.ic_sourced_id}`);
    if (cand && cand.match_reason === "deactivate") {
      // Once actually applied, the student is already inactive — re-adding it here
      // every subsequent run (it stays "missing from pull" forever) would otherwise
      // make it show up as outstanding work in the preview, CSV export, and counts
      // indefinitely, even though there's nothing left to do.
      if (cand.status === "approved" && s.active !== false) deactivatePlans.push({ id: s.id, label });
      // pending or rejected: leave active, don't re-stage
      continue;
    }
    deactivateCandidatesToStage.push({
      school_id: IC_SCHOOL_ID,
      entity_type: "student",
      ic_sourced_id: s.ic_sourced_id,
      existing_record_id: s.id,
      match_reason: "deactivate",
      existing_data: { ...s, active: true },
      proposed_data: { active: false },
    });
  }

  // Only a confirmed STUDENT is ever allowed to trigger creation of a new family —
  // never a guardian by itself. Family resolution is entirely student-driven (see the
  // existingFamilyId search above, which only ever looks at students), so a guardian
  // approved ahead of their student has no way to later discover a family the student
  // creates afterward. If guardians could also trigger creation, an out-of-order
  // approval (guardian before student) would silently produce two separate orphaned
  // families for one household, needing a manual merge to fix. Excluding them means a
  // guardian whose student isn't resolved yet just waits — harmlessly, via the
  // existing "orphan guardian, no family yet" skip below — and picks up the real
  // family automatically on whichever later run actually resolves the student.
  const neededFamilyKeys = new Set(
    studentPlans.map((p) => p.familyKey).filter((k): k is string => !!k)
  );

  const totalPendingStudents = candidates.filter((c) => c.entity_type === "student" && c.status === "pending").length;
  const totalPendingGuardians = candidates.filter((c) => c.entity_type === "guardian" && c.status === "pending").length;
  const totalPendingFamilies = candidates.filter((c) => c.entity_type === "family" && c.status === "pending").length;

  return {
    familyPlans,
    neededFamilyKeys,
    guardianPlans,
    studentPlans,
    deactivatePlans,
    studentCandidatesToStage,
    guardianCandidatesToStage,
    familyCandidatesToStage,
    deactivateCandidatesToStage,
    candidateUpgrades,
    dataGapChecks,
    fieldDiffChecks,
    totalPendingStudents: totalPendingStudents + studentCandidatesToStage.length + deactivateCandidatesToStage.length,
    totalPendingGuardians: totalPendingGuardians + guardianCandidatesToStage.length,
    totalPendingFamilies: totalPendingFamilies + familyCandidatesToStage.length,
    fetchCounts: { students: icStudents.length, users: icAllUsers.length, demographics: icDemographics.length },
  };
}

/* ─────────────────────────────────────────────────────
   SUMMARIZE A PLAN (used for both the preview response and the
   permanent record saved on ic_sync_runs)
───────────────────────────────────────────────────── */
function summarizePlan(plan: Awaited<ReturnType<typeof buildPlan>>) {
  const {
    familyPlans,
    neededFamilyKeys,
    guardianPlans,
    studentPlans,
    deactivatePlans,
    studentCandidatesToStage,
    guardianCandidatesToStage,
  } = plan;

  const familiesCreated = [...familyPlans.entries()].filter(
    ([key, f]) => f.isNew && neededFamilyKeys.has(key)
  ).length;
  const studentsCreated = studentPlans.filter((s) => s.isNew);
  const studentsUpdated = studentPlans.filter((s) => !s.isNew);
  const guardiansCreated = guardianPlans.filter((g) => g.isNew);
  const guardiansUpdated = guardianPlans.filter((g) => !g.isNew);

  return {
    counts: {
      families_created: familiesCreated,
      students_created: studentsCreated.length,
      students_updated: studentsUpdated.length,
      students_deactivated: deactivatePlans.length,
      guardians_created: guardiansCreated.length,
      guardians_updated: guardiansUpdated.length,
      students_awaiting_review: plan.totalPendingStudents,
      guardians_awaiting_review: plan.totalPendingGuardians,
      families_awaiting_review: plan.totalPendingFamilies,
    },
    samples: {
      students_created: studentsCreated.slice(0, PREVIEW_SAMPLE_LIMIT).map((s) => s.label),
      students_deactivated: deactivatePlans.slice(0, PREVIEW_SAMPLE_LIMIT).map((s) => s.label),
      guardians_created: guardiansCreated.slice(0, PREVIEW_SAMPLE_LIMIT).map((g) => g.label),
    },
  };
}

/* ─────────────────────────────────────────────────────
   EXECUTE A PLAN (real run only)
───────────────────────────────────────────────────── */
async function executePlan(plan: Awaited<ReturnType<typeof buildPlan>>) {
  const {
    familyPlans,
    neededFamilyKeys,
    guardianPlans,
    studentPlans,
    deactivatePlans,
    studentCandidatesToStage,
    guardianCandidatesToStage,
    familyCandidatesToStage,
    deactivateCandidatesToStage,
    candidateUpgrades,
    dataGapChecks,
    fieldDiffChecks,
  } = plan;

  // Stage new reconciliation candidates for human review. Independent of the rest of
  // this run — left in place even if something below fails, since they're just
  // proposals sitting in a queue, not live student/guardian data.
  await bulkInsert(
    "ic_reconciliation_candidates",
    [...studentCandidatesToStage, ...guardianCandidatesToStage, ...familyCandidatesToStage, ...deactivateCandidatesToStage],
    (r) => `${r.entity_type} ${r.ic_sourced_id}`
  );

  // Self-heal stale "new record" candidates: if a matching manual record has since
  // shown up in Belltower, upgrade the candidate in place to a real reconciliation
  // match instead of leaving it stuck showing "new" forever.
  for (const u of candidateUpgrades) {
    const { error: upgradeErr } = await supabase
      .from("ic_reconciliation_candidates")
      .update({ existing_record_id: u.existing_record_id, existing_data: u.existing_data, match_reason: u.match_reason })
      .eq("id", u.id);
    if (upgradeErr) console.error(`Failed to upgrade candidate ${u.id}:`, upgradeErr);
  }

  // Open/refresh data-gap audit rows, and close ones IC has since filled in. Also
  // independent of the main sync outcome below — this is just bookkeeping.
  const gapsToOpen = dataGapChecks
    .filter((g) => g.hasGap)
    .map((g) => ({
      school_id: IC_SCHOOL_ID,
      entity_type: g.entityType,
      entity_id: g.entityId,
      ic_sourced_id: g.sourcedId,
      field: g.field,
      belltower_value: g.belltowerValue === null || g.belltowerValue === undefined ? null : String(g.belltowerValue),
      last_detected_at: new Date().toISOString(),
      resolved_at: null,
    }));
  await upsertGaps(gapsToOpen);
  for (const g of dataGapChecks.filter((g) => !g.hasGap)) {
    await resolveGap(IC_SCHOOL_ID, g.entityType, g.entityId, g.field);
  }

  // Same bookkeeping for field-diff audit rows — open/refresh ones that still
  // disagree, close ones that now match.
  const diffsToOpen = fieldDiffChecks
    .filter((d) => d.hasDiff)
    .map((d) => ({
      school_id: IC_SCHOOL_ID,
      entity_type: d.entityType,
      entity_id: d.entityId,
      ic_sourced_id: d.sourcedId,
      field: d.field,
      belltower_value: d.belltowerValue === null || d.belltowerValue === undefined ? null : String(d.belltowerValue),
      ic_value: d.icValue === null || d.icValue === undefined ? null : String(d.icValue),
      last_detected_at: new Date().toISOString(),
      resolved_at: null,
    }));
  await upsertDiffs(diffsToOpen);
  for (const d of fieldDiffChecks.filter((d) => !d.hasDiff)) {
    await resolveDiff(IC_SCHOOL_ID, d.entityType, d.entityId, d.field);
  }

  // The supabase-js REST client can't wrap these across-table writes in a single
  // DB transaction, so a crash partway through (see the 2026-08-04 dev incident:
  // families + guardians written, then a student insert failed) would otherwise
  // leave permanent orphaned rows. Track everything we create here and roll it
  // back on any error before rethrowing, so a failed run leaves no trace.
  const createdFamilyIds: string[] = [];
  const createdGuardianIds: string[] = [];
  const createdStudentIds: string[] = [];

  try {
    /* ---- Create new families in chunks, track real IDs by group key ---- */
    const realFamilyIdByKey = new Map<string, string>();
    const keysNeedingNewFamily: string[] = [];
    for (const [key, familyPlan] of familyPlans) {
      if (familyPlan.existingFamilyId) {
        realFamilyIdByKey.set(key, familyPlan.existingFamilyId);
      } else if (neededFamilyKeys.has(key)) {
        keysNeedingNewFamily.push(key);
      }
      // else: nothing being written this run actually needs this group's family yet
      // (every member is still pending/needs_staging review) — skip creating it.
    }

    for (const keyBatch of chunk(keysNeedingNewFamily, 100)) {
      const rows = keyBatch.map((key) => ({
        school_id: IC_SCHOOL_ID,
        carline_tag_number: generatePlaceholderTag(),
        family_name: familyPlans.get(key)?.derivedName ?? null,
      }));
      const { data, error } = await supabase.from("families").insert(rows).select("id");
      if (error) throw error;
      // A single multi-row INSERT ... RETURNING preserves input order in Postgres.
      data!.forEach((row: { id: string }, i: number) => {
        realFamilyIdByKey.set(keyBatch[i], row.id);
        createdFamilyIds.push(row.id);
      });
    }
    const familiesCreated = createdFamilyIds.length;

    /* ---- Guardians ---- */
    const guardiansToInsert: Record<string, unknown>[] = [];
    const guardiansToUpdate: Record<string, unknown>[] = [];
    for (const g of guardianPlans) {
      const familyId = g.familyKey ? realFamilyIdByKey.get(g.familyKey) ?? null : null;
      if (g.isNew) {
        if (!familyId) continue; // orphan guardian with no linked student — skip
        guardiansToInsert.push({ ...g.record, family_id: familyId });
      } else {
        // family_id is NOT NULL on guardians; upsert needs it even though we're not
        // changing it — preserve the existing assignment rather than reassigning
        // based on this run's grouping (avoids unintended household reshuffling).
        guardiansToUpdate.push({ ...g.record, id: g.existingId, family_id: g.existingFamilyId });
      }
    }
    createdGuardianIds.push(
      ...(await bulkInsert("guardians", guardiansToInsert, (r) => `${r.first_name} ${r.last_name}`))
    );
    const guardiansCreated = createdGuardianIds.length;
    await bulkUpdate("guardians", guardiansToUpdate);
    const guardiansUpdated = guardiansToUpdate.length;

    /* ---- Students ---- */
    const studentsToInsert: Record<string, unknown>[] = [];
    const studentsToUpdate: Record<string, unknown>[] = [];
    for (const s of studentPlans) {
      if (s.isNew) {
        const familyId = s.familyKey ? realFamilyIdByKey.get(s.familyKey) ?? null : null;
        studentsToInsert.push({ ...s.record, family_id: familyId });
      } else {
        // Preserve the student's existing family assignment on updates rather than
        // recomputing from this run's grouping — a household should only ever change
        // via an explicitly-approved family match, never silently on a routine sync.
        studentsToUpdate.push({ ...s.record, id: s.existingId, family_id: s.existingFamilyId });
      }
    }
    createdStudentIds.push(
      ...(await bulkInsert("students", studentsToInsert, (r) => `${r.first_name} ${r.last_name}`))
    );
    const studentsCreated = createdStudentIds.length;
    await bulkUpdate("students", studentsToUpdate);
    const studentsUpdated = studentsToUpdate.length;

    /* ---- Deactivations ---- */
    let studentsDeactivated = 0;
    for (const idBatch of chunk(
      deactivatePlans.map((d) => d.id),
      200
    )) {
      const { error } = await supabase
        .from("students")
        .update({ active: false, last_synced_at: new Date().toISOString() })
        .in("id", idBatch);
      if (error) throw error;
      studentsDeactivated += idBatch.length;
    }

    return {
      families_created: familiesCreated,
      students_created: studentsCreated,
      students_updated: studentsUpdated,
      students_deactivated: studentsDeactivated,
      guardians_created: guardiansCreated,
      guardians_updated: guardiansUpdated,
      students_awaiting_review: plan.totalPendingStudents,
      guardians_awaiting_review: plan.totalPendingGuardians,
      families_awaiting_review: plan.totalPendingFamilies,
    };
  } catch (err) {
    console.error("executePlan failed partway through — rolling back this run's creates:", err);
    await deleteInChunks("students", createdStudentIds);
    await deleteInChunks("guardians", createdGuardianIds);
    await deleteInChunks("families", createdFamilyIds);
    throw err;
  }
}

/* ─────────────────────────────────────────────────────
   ENTRY POINT
   Manual only, for now — there's no schedule/cron calling this function. Every
   invocation must come from an authenticated user with can_bulk_upload, and a real
   run only happens when dry_run is explicitly false; a missing/malformed dry_run
   defaults to a preview rather than assuming a real run.
   POST body: { dry_run?: boolean } | { export: true } | { apply_field_pull: string | string[] }
───────────────────────────────────────────────────── */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const authClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: callerProfile } = await supabase
    .from("profiles")
    .select("can_bulk_upload")
    .eq("user_id", user.id)
    .single();
  if (!callerProfile?.can_bulk_upload) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const dryRun = body.dry_run !== false;

  if (body.export === true) {
    try {
      const plan = await buildPlan();
      const { data: pendingCandidates, error: candErr } = await supabase
        .from("ic_reconciliation_candidates")
        .select("*")
        .eq("school_id", IC_SCHOOL_ID)
        .eq("status", "pending");
      if (candErr) throw candErr;

      const csv = buildDiffCsv(plan, pendingCandidates ?? []);
      return new Response(csv, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="ic-diff-report-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    } catch (err) {
      console.error("sync_infinite_campus export error:", err);
      return new Response(JSON.stringify({ error: errToString(err) }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  if (body.apply_field_pull) {
    const diffIds: string[] = Array.isArray(body.apply_field_pull)
      ? body.apply_field_pull
      : [body.apply_field_pull];
    const results: { id: string; ok: boolean; error?: string }[] = [];

    for (const diffId of diffIds) {
      try {
        const { data: diff, error: diffErr } = await supabase
          .from("ic_field_diffs")
          .select("*")
          .eq("id", diffId)
          .eq("school_id", IC_SCHOOL_ID)
          .is("resolved_at", null)
          .single();
        if (diffErr || !diff) throw new Error("Field diff not found, or already resolved");

        // Name, active-status, and the guardian-link flag are identity/status signals
        // that always require a human decision, never a bare field pull.
        if (diff.field === "name" || diff.field === "active" || diff.field === "guardian_link") {
          throw new Error(`"${diff.field}" can't be pulled directly — resolve it through the Admin Panel instead`);
        }

        const table = diff.entity_type === "student" ? "students" : "guardians";
        const { error: updateErr } = await supabase
          .from(table)
          .update({ [diff.field]: diff.ic_value })
          .eq("id", diff.entity_id);
        if (updateErr) throw updateErr;

        await supabase.from("ic_field_diffs").update({ resolved_at: new Date().toISOString() }).eq("id", diff.id);
        results.push({ id: diffId, ok: true });
      } catch (err) {
        console.error(`sync_infinite_campus apply_field_pull error (${diffId}):`, err);
        results.push({ id: diffId, ok: false, error: errToString(err) });
      }
    }

    const anyFailed = results.some((r) => !r.ok);
    return new Response(JSON.stringify({ ok: !anyFailed, results }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: run, error: runInsertErr } = await supabase
    .from("ic_sync_runs")
    .insert({ school_id: IC_SCHOOL_ID, dry_run: dryRun, status: dryRun ? "previewing" : "running" })
    .select()
    .single();
  if (runInsertErr) {
    console.error("Failed to create ic_sync_runs row:", runInsertErr);
    return new Response(JSON.stringify({ error: runInsertErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const plan = await buildPlan();
    const summary = summarizePlan(plan);

    if (dryRun) {
      await supabase
        .from("ic_sync_runs")
        .update({
          ...summary.counts,
          status: "preview",
          preview_summary: summary.samples,
          finished_at: new Date().toISOString(),
        })
        .eq("id", run.id);

      return new Response(JSON.stringify({ ok: true, dry_run: true, ...summary, fetchCounts: plan.fetchCounts }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const executedCounts = await executePlan(plan);

    await supabase
      .from("ic_sync_runs")
      .update({ ...executedCounts, status: "success", finished_at: new Date().toISOString() })
      .eq("id", run.id);

    return new Response(JSON.stringify({ ok: true, dry_run: false, ...executedCounts }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("sync_infinite_campus error:", err);
    const message = errToString(err);
    await supabase
      .from("ic_sync_runs")
      .update({ status: "error", error_message: message, finished_at: new Date().toISOString() })
      .eq("id", run.id);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
