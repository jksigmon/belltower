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
    let teacherQuery = supabaseService
      .from("employees")
      .select("id, first_name, last_name")
      .eq("school_id", schoolId)
      .eq("active", true)
      .order("last_name");

    if (allowedTeacherIds !== null) {
      teacherQuery = teacherQuery.in("id", allowedTeacherIds);
    }

    const { data: teachers } = await teacherQuery;
    if (!teachers?.length) return json({ teachers: [], templates: [], rows: [] }, 200);

    const teacherIds = teachers.map((t: { id: string }) => t.id);

    // ── Fetch students in those homerooms ─────────────────────────────
    const { data: students } = await supabaseService
      .from("students")
      .select("id, first_name, last_name, grade_level, homeroom_teacher_id, family_id")
      .eq("school_id", schoolId)
      .eq("active", true)
      .in("homeroom_teacher_id", teacherIds)
      .order("last_name");

    if (!students?.length) {
      const { data: templates } = await fetchTemplates(schoolId, template_ids);
      return json({ teachers, templates: templates ?? [], rows: [] }, 200);
    }

    // ── Fetch guardians for students' families ────────────────────────
    const familyIds = [...new Set(
      students.map((s: { family_id: string | null }) => s.family_id).filter(Boolean) as string[]
    )];

    const guardiansByFamily = new Map<string, { id: string; name: string; email: string; can_chaperone: boolean; can_drive: boolean }[]>();

    if (familyIds.length) {
      const { data: guardians } = await supabaseService
        .from("guardians")
        .select("id, family_id, first_name, last_name, email, can_chaperone, can_drive")
        .eq("school_id", schoolId)
        .eq("active", true)
        .in("family_id", familyIds);

      (guardians ?? []).forEach((g: { id: string; family_id: string; first_name: string; last_name: string; email: string; can_chaperone: boolean; can_drive: boolean }) => {
        const list = guardiansByFamily.get(g.family_id) ?? [];
        list.push({ id: g.id, name: `${g.first_name} ${g.last_name}`, email: g.email, can_chaperone: g.can_chaperone ?? true, can_drive: g.can_drive ?? true });
        guardiansByFamily.set(g.family_id, list);
      });
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
      let q = supabaseService
        .from("compliance_agreements")
        .select(baseSelect)
        .eq("school_id", schoolId)
        .is("voided_at", null)
        .in("guardian_id", allGuardianIds);
      if (template_ids?.length) q = q.in("template_id", template_ids);
      const { data } = await q;
      agreements.push(...(data ?? []));
    }

    if (allGuardianEmails.length) {
      let q = supabaseService
        .from("compliance_agreements")
        .select(baseSelect)
        .eq("school_id", schoolId)
        .is("voided_at", null)
        .in("signer_email", allGuardianEmails);
      if (template_ids?.length) q = q.in("template_id", template_ids);
      const { data } = await q;
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

    // ── Fetch templates ───────────────────────────────────────────────
    const { data: templates } = await fetchTemplates(schoolId, template_ids);

    // ── Build report rows ─────────────────────────────────────────────
    const rows = students.map((student: {
      id: string; first_name: string; last_name: string;
      grade_level: string | null; homeroom_teacher_id: string; family_id: string | null;
    }) => {
      const guardians = student.family_id ? (guardiansByFamily.get(student.family_id) ?? []) : [];
      const teacher   = teachers.find((t: { id: string }) => t.id === student.homeroom_teacher_id);

      const compliance: Record<string, {
        agreement_id: string | null; signed_at: string | null;
        expires_at: string | null; status: string;
      }> = {};

      (templates ?? []).forEach((tmpl: { id: string; title: string }) => {
        let best = { agreement_id: null as string | null, signed_at: null as string | null, expires_at: null as string | null, status: "missing" };

        for (const guardian of guardians) {
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
          if (best.status === "signed") break;
        }

        compliance[tmpl.id] = best;
      });

      const restrictions = guardians
        .filter((g) => g.can_chaperone === false || g.can_drive === false)
        .map((g) => ({ guardian_name: g.name, can_chaperone: g.can_chaperone, can_drive: g.can_drive }));

      return {
        student_id:   student.id,
        student_name: `${student.first_name} ${student.last_name}`,
        grade_level:  student.grade_level ?? null,
        teacher_id:   student.homeroom_teacher_id,
        teacher_name: teacher ? `${(teacher as { first_name: string; last_name: string }).first_name} ${(teacher as { first_name: string; last_name: string }).last_name}` : "—",
        guardians,
        compliance,
        restrictions,
      };
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
