import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseService = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// An unranged select caps at 1000 rows -- for a large district running this
// report school-wide, that would silently drop teachers/students/guardians
// off the end rather than erroring.
async function fetchAllRows<T = any>(
  build: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }> }
): Promise<{ data: T[]; error: unknown }> {
  const rows: T[] = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) return { data: rows, error };
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < pageSize) break;
    from += pageSize;
  }
  return { data: rows, error: null };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // ── Auth ──────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    // Use a user-context anon client to validate the JWT (same pattern as compliance_form_pdf)
    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authErr } = await supabaseUser.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    // ── Profile ───────────────────────────────────────────────────────
    // profiles.user_id is the FK to auth.users; profiles.id is the row's own UUID
    const { data: profile, error: profileErr } = await supabaseService
      .from("profiles")
      .select("id, school_id, employee_id, can_manage_compliance")
      .eq("user_id", user.id)
      .single();

    if (profileErr || !profile) {
      console.error("profile lookup failed:", profileErr?.message, "user_id:", user.id);
      return json({ error: "Profile not found" }, 404);
    }

    const schoolId = profile.school_id as string;

    // ── Payload ───────────────────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const teacher_employee_ids: string[] | undefined = body.teacher_employee_ids;
    const template_ids:          string[] | undefined = body.template_ids;

    // ── Resolve which teachers this caller can see ────────────────────
    let allowedTeacherIds: string[] | null = null; // null = all teachers

    if (profile.can_manage_compliance) {
      allowedTeacherIds = teacher_employee_ids?.length ? teacher_employee_ids : null;
    } else {
      const permitted = new Set<string>();

      if (profile.employee_id) {
        const { count } = await supabaseService
          .from("students")
          .select("id", { count: "exact", head: true })
          .eq("school_id", schoolId)
          .eq("homeroom_teacher_id", profile.employee_id);
        if ((count ?? 0) > 0) permitted.add(profile.employee_id as string);
      }

      // profile.id is profiles.id (PK), used as grantee_id in compliance_report_grants
      const { data: grants } = await supabaseService
        .from("compliance_report_grants")
        .select("teacher_id")
        .eq("school_id", schoolId)
        .eq("grantee_id", profile.id);

      (grants ?? []).forEach((g: { teacher_id: string }) => permitted.add(g.teacher_id));

      if (!permitted.size) return json({ error: "No homerooms assigned. Contact your compliance manager." }, 403);

      if (teacher_employee_ids?.length) {
        allowedTeacherIds = teacher_employee_ids.filter(id => permitted.has(id));
        if (!allowedTeacherIds.length) return json({ error: "Access denied to requested teachers." }, 403);
      } else {
        allowedTeacherIds = [...permitted];
      }
    }

    // ── Fetch employees (for teacher selector) ────────────────────────
    const { data: teachers } = await fetchAllRows(() => {
      let q = supabaseService
        .from("employees")
        .select("id, first_name, last_name")
        .eq("school_id", schoolId)
        .eq("active", true)
        .eq("is_teacher", true)
        .order("last_name");
      if (allowedTeacherIds !== null) q = q.in("id", allowedTeacherIds);
      return q;
    });
    if (!teachers?.length) return json({ teachers: [], templates: [], rows: [] }, 200);

    const teacherIds = teachers.map((t: { id: string }) => t.id);

    // ── Fetch students in those homerooms ─────────────────────────────
    const { data: students } = await fetchAllRows(() => supabaseService
      .from("students")
      .select("id, first_name, last_name, grade_level, homeroom_teacher_id, family_id")
      .eq("school_id", schoolId)
      .eq("active", true)
      .in("homeroom_teacher_id", teacherIds)
      .order("last_name"));

    if (!students?.length) {
      const { data: templates } = await fetchTemplates(schoolId, template_ids);
      return json({ teachers, templates: templates ?? [], rows: [] }, 200);
    }

    // ── Fetch guardians for students' families ────────────────────────
    const familyIds = [...new Set(
      students.map((s: { family_id: string | null }) => s.family_id).filter(Boolean) as string[]
    )];

    const guardiansByFamily = new Map<string, { id: string; name: string; email: string; first_name: string; last_name: string }[]>();

    if (familyIds.length) {
      const { data: guardians } = await fetchAllRows(() => supabaseService
        .from("guardians")
        .select("id, family_id, first_name, last_name, email")
        .eq("school_id", schoolId)
        .eq("active", true)
        .in("family_id", familyIds)
        .order("last_name"));

      (guardians ?? []).forEach((g: { id: string; family_id: string; first_name: string; last_name: string; email: string }) => {
        const list = guardiansByFamily.get(g.family_id) ?? [];
        list.push({ id: g.id, name: `${g.first_name} ${g.last_name}`, email: g.email, first_name: g.first_name, last_name: g.last_name });
        guardiansByFamily.set(g.family_id, list);
      });
    }

    // Mirrors public.compliance_volunteer_match_key() -- strips "(...)" nickname
    // annotations and keys off the first *word* of the first name. Same fallback
    // Field Trips' chaperone tab and the staff BG-request dedup check already use
    // to find a compliance_volunteers row that was never linked by guardian_id
    // or matched by email (e.g. entered with a different email on the BG request).
    function volunteerMatchKey(firstName: string, lastName: string): string {
      const norm = (s: string) => (s ?? "").replace(/\s*\([^)]*\)\s*/g, " ").trim();
      const last = norm(lastName).toLowerCase();
      const first = norm(firstName).toLowerCase().split(" ")[0] ?? "";
      return `${last}|${first}`;
    }

    // ── Fetch compliance agreements ───────────────────────────────────
    // Two separate queries: by guardian_id and by signer_email
    const allGuardians = [...guardiansByFamily.values()].flat();
    const allGuardianIds = allGuardians.map(g => g.id);
    const allGuardianEmails = [...new Set(allGuardians.map(g => g.email).filter(Boolean))];

    const today = new Date().toISOString().slice(0, 10);

    type AgreementRow = {
      id: string;
      guardian_id: string | null;
      template_id: string;
      signer_name: string;
      signer_email: string;
      signed_at: string;
      expires_at: string | null;
      voided_at: string | null;
    };

    let agreements: AgreementRow[] = [];

    const baseSelect = `id, guardian_id, template_id, signer_name, signer_email, signed_at, expires_at, voided_at`;

    if (allGuardianIds.length) {
      const { data } = await fetchAllRows<AgreementRow>(() => {
        let q = supabaseService
          .from("compliance_agreements")
          .select(baseSelect)
          .eq("school_id", schoolId)
          .is("voided_at", null)
          .in("guardian_id", allGuardianIds);
        if (template_ids?.length) q = q.in("template_id", template_ids);
        return q;
      });
      agreements.push(...(data ?? []));
    }

    if (allGuardianEmails.length) {
      const { data } = await fetchAllRows<AgreementRow>(() => {
        let q = supabaseService
          .from("compliance_agreements")
          .select(baseSelect)
          .eq("school_id", schoolId)
          .is("voided_at", null)
          .in("signer_email", allGuardianEmails);
        if (template_ids?.length) q = q.in("template_id", template_ids);
        return q;
      });
      // Merge, dedup by id
      const seen = new Set(agreements.map((a: AgreementRow) => a.id));
      (data ?? []).forEach((a: AgreementRow) => { if (!seen.has(a.id)) agreements.push(a); });
    }

    // Build lookups
    const agrByGuardian = new Map<string, AgreementRow[]>();
    const agrByEmail    = new Map<string, AgreementRow[]>();
    agreements.forEach(a => {
      if (a.guardian_id) {
        const list = agrByGuardian.get(a.guardian_id) ?? [];
        list.push(a);
        agrByGuardian.set(a.guardian_id, list);
      }
      if (a.signer_email) {
        const key = a.signer_email.toLowerCase();
        const list = agrByEmail.get(key) ?? [];
        list.push(a);
        agrByEmail.set(key, list);
      }
    });

    // ── Fetch volunteer compliance records (BG/MVR/DL/insurance) ──────
    // Same guardian_id + email dual-fetch pattern as agreements above, and
    // read through supabaseService (not exposed to the client directly) so
    // a TA with only a compliance_report_grants row -- who has no RLS
    // access to compliance_volunteers itself -- still gets this data back
    // through the edge function's own authorization check.
    type VolunteerRow = {
      id: string; guardian_id: string | null; email: string | null; match_key: string | null;
      bg_cleared_at: string | null; bg_expires_at: string | null;
      mvr_cleared_at: string | null; mvr_expires_at: string | null;
      dl_expires_at: string | null; insurance_expires_at: string | null;
      can_chaperone: boolean; can_drive: boolean;
    };

    let volunteers: VolunteerRow[] = [];
    const volSelect = `id, guardian_id, email, match_key, bg_cleared_at, bg_expires_at, mvr_cleared_at, mvr_expires_at, dl_expires_at, insurance_expires_at, can_chaperone, can_drive`;

    if (allGuardianIds.length) {
      const { data } = await fetchAllRows<VolunteerRow>(() => supabaseService
        .from("compliance_volunteers")
        .select(volSelect)
        .eq("school_id", schoolId)
        .is("archived_at", null)
        .in("guardian_id", allGuardianIds));
      volunteers.push(...(data ?? []));
    }

    if (allGuardianEmails.length) {
      const { data } = await fetchAllRows<VolunteerRow>(() => supabaseService
        .from("compliance_volunteers")
        .select(volSelect)
        .eq("school_id", schoolId)
        .is("archived_at", null)
        .in("email", allGuardianEmails));
      const seen = new Set(volunteers.map((v: VolunteerRow) => v.id));
      (data ?? []).forEach((v: VolunteerRow) => { if (!seen.has(v.id)) volunteers.push(v); });
    }

    // Third pass: name-key match, for roster entries that were never linked to
    // a guardian_id and were entered with an email that doesn't match what's
    // on file for the guardian (or no email at all).
    const allGuardianMatchKeys = [...new Set(allGuardians.map(g => volunteerMatchKey(g.first_name, g.last_name)))];
    if (allGuardianMatchKeys.length) {
      const { data } = await fetchAllRows<VolunteerRow>(() => supabaseService
        .from("compliance_volunteers")
        .select(volSelect)
        .eq("school_id", schoolId)
        .is("archived_at", null)
        .in("match_key", allGuardianMatchKeys));
      const seen = new Set(volunteers.map((v: VolunteerRow) => v.id));
      (data ?? []).forEach((v: VolunteerRow) => { if (!seen.has(v.id)) volunteers.push(v); });
    }

    const volByGuardian = new Map<string, VolunteerRow>();
    const volByEmail    = new Map<string, VolunteerRow>();
    const volByNameKey  = new Map<string, VolunteerRow>();
    volunteers.forEach(v => {
      if (v.guardian_id) volByGuardian.set(v.guardian_id, v);
      if (v.email) volByEmail.set(v.email.toLowerCase(), v);
      if (v.match_key) volByNameKey.set(v.match_key, v);
    });

    function getVolunteer(guardian: { id: string; email: string; first_name: string; last_name: string }): VolunteerRow | null {
      return volByGuardian.get(guardian.id)
        ?? (guardian.email ? volByEmail.get(guardian.email.toLowerCase()) : undefined)
        ?? volByNameKey.get(volunteerMatchKey(guardian.first_name, guardian.last_name))
        ?? null;
    }

    const sixtyOut = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // BG is treated as "missing" whenever there's no clearance on file at all --
    // it's the one credential every chaperone-eligible guardian needs. MVR/DL/
    // insurance are only relevant to guardians who actually drive, so absence
    // of any record there is reported as neutral "not on file" rather than a gap.
    function credentialStatus(clearedAt: string | null, expiresAt: string | null, requiresClearance: boolean) {
      if (requiresClearance && !clearedAt) return { status: "missing", date: null as string | null };
      if (!clearedAt && !expiresAt) return { status: "not_on_file", date: null as string | null };
      if (expiresAt && expiresAt < today) return { status: "expired", date: expiresAt };
      if (expiresAt && expiresAt <= sixtyOut) return { status: "expiring", date: expiresAt };
      return { status: "cleared", date: expiresAt };
    }

    function expiryStatus(expiresAt: string | null) {
      if (!expiresAt) return { status: "not_on_file", date: null as string | null };
      if (expiresAt < today) return { status: "expired", date: expiresAt };
      if (expiresAt <= sixtyOut) return { status: "expiring", date: expiresAt };
      return { status: "ok", date: expiresAt };
    }

    // ── Fetch templates ───────────────────────────────────────────────
    const { data: templates } = await fetchTemplates(schoolId, template_ids);

    // ── Build report rows ─────────────────────────────────────────────
    // One row per (student, guardian) -- BG/MVR clearance is a fact about a
    // specific person, not the family, so rolling multiple guardians into a
    // single student row would hide which parent actually needs what.
    type GuardianInfo = { id: string; name: string; email: string; first_name: string; last_name: string };
    const rows: Record<string, unknown>[] = [];

    students.forEach((student: {
      id: string; first_name: string; last_name: string;
      grade_level: string | null; homeroom_teacher_id: string; family_id: string | null;
    }) => {
      const guardians: GuardianInfo[] = student.family_id ? (guardiansByFamily.get(student.family_id) ?? []) : [];
      const teacher = teachers.find((t: { id: string }) => t.id === student.homeroom_teacher_id) as
        { first_name: string; last_name: string } | undefined;
      const teacherName = teacher ? `${teacher.first_name} ${teacher.last_name}` : "—";

      const guardianList: (GuardianInfo | null)[] = guardians.length ? guardians : [null];

      guardianList.forEach((guardian) => {
        const compliance: Record<string, {
          agreement_id: string | null; signed_at: string | null;
          expires_at: string | null; status: string;
        }> = {};

        (templates ?? []).forEach((tmpl: { id: string; title: string }) => {
          let best = { agreement_id: null as string | null, signed_at: null as string | null, expires_at: null as string | null, status: "missing" };

          if (guardian) {
            const agrs = [
              ...(agrByGuardian.get(guardian.id) ?? []),
              ...(agrByEmail.get(guardian.email?.toLowerCase()) ?? []),
            ].filter(a => a.template_id === tmpl.id);

            for (const agr of agrs) {
              const expired = agr.expires_at && agr.expires_at < today;
              if (!expired) {
                best = { agreement_id: agr.id, signed_at: agr.signed_at, expires_at: agr.expires_at, status: "signed" };
                break;
              } else if (best.status === "missing") {
                best = { agreement_id: agr.id, signed_at: agr.signed_at, expires_at: agr.expires_at, status: "expired" };
              }
            }
          }

          compliance[tmpl.id] = best;
        });

        const volunteer = guardian ? getVolunteer(guardian) : null;

        rows.push({
          student_id:   student.id,
          student_name: `${student.first_name} ${student.last_name}`,
          grade_level:  student.grade_level ?? null,
          teacher_id:   student.homeroom_teacher_id,
          teacher_name: teacherName,
          guardian_id:    guardian?.id ?? null,
          guardian_name:  guardian?.name ?? null,
          guardian_email: guardian?.email ?? null,
          bg:        credentialStatus(volunteer?.bg_cleared_at ?? null, volunteer?.bg_expires_at ?? null, true),
          mvr:       credentialStatus(volunteer?.mvr_cleared_at ?? null, volunteer?.mvr_expires_at ?? null, false),
          dl:        expiryStatus(volunteer?.dl_expires_at ?? null),
          insurance: expiryStatus(volunteer?.insurance_expires_at ?? null),
          can_chaperone: guardian ? (volunteer?.can_chaperone ?? true) : null,
          can_drive:     guardian ? (volunteer?.can_drive ?? true) : null,
          compliance,
        });
      });
    });

    return json({ teachers, templates: templates ?? [], rows }, 200);

  } catch (err) {
    console.error("compliance_report error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});

async function fetchTemplates(schoolId: string, templateIds?: string[]) {
  let q = supabaseService
    .from("compliance_form_templates")
    .select("id, title")
    .eq("school_id", schoolId)
    .eq("active", true)
    .order("title");
  if (templateIds?.length) q = q.in("id", templateIds);
  return q;
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
