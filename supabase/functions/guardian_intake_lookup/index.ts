import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { token } = await req.json();

    if (!token || typeof token !== "string") {
      return json({ error: "Invalid token" }, 400);
    }

    const { data: campaign, error } = await supabase
      .from("guardian_intake_campaigns")
      .select(`
        id, name, status, school_id, field_config,
        schools!inner ( name, logo_url, grade_levels )
      `)
      .eq("token", token)
      .single();

    if (error || !campaign) {
      return json({ error: "Form not found." }, 404);
    }

    if (campaign.status !== "active") {
      return json({ error: "This form is no longer accepting submissions." }, 410);
    }

    const school = campaign.schools as Record<string, unknown>;
    const fieldConfig = (campaign.field_config as Record<string, boolean>) ?? {};

    // Homeroom teachers grouped by grade. Only computed when the campaign
    // has opted into the homeroom dropdown, since it's the one field that
    // needs a privileged (service-role) query.
    //
    // Two sources, in priority order:
    //   1. employees.grade — an explicit, admin-set grade assignment.
    //      Takes precedence whenever set, so the dropdown doesn't depend on
    //      class placements being committed (students get promoted a grade
    //      before placements/homerooms catch up, which otherwise puts every
    //      teacher under the wrong grade for that window).
    //   2. Derived from active students' homeroom assignments, for any
    //      teacher that doesn't have employees.grade set. A teacher can have
    //      students split across two grades mid-transition and would
    //      otherwise show up under both, so MIN_STUDENTS_FOR_HOMEROOM filters
    //      out grades where a teacher only has a stray student or two.
    const MIN_STUDENTS_FOR_HOMEROOM = 2;
    let homerooms: Record<string, { id: string; name: string }[]> = {};
    if (fieldConfig.homeroom_teacher) {
      const [{ data: explicitTeachers }, { data: rows }] = await Promise.all([
        supabase
          .from("employees")
          .select("id, first_name, last_name, grade")
          .eq("school_id", campaign.school_id)
          .eq("active", true)
          .not("grade", "is", null),
        supabase
          .from("students")
          .select("grade_level, employees:homeroom_teacher_id ( id, first_name, last_name )")
          .eq("school_id", campaign.school_id)
          .eq("active", true)
          .not("homeroom_teacher_id", "is", null),
      ]);

      const explicitTeacherIds = new Set<string>();
      for (const teacher of explicitTeachers ?? []) {
        explicitTeacherIds.add(teacher.id);
        (homerooms[teacher.grade as string] ??= []).push({ id: teacher.id, name: `${teacher.first_name} ${teacher.last_name}` });
      }

      const counts = new Map<string, { grade: string; teacher: { id: string; first_name: string; last_name: string }; count: number }>();
      for (const row of rows ?? []) {
        const grade = row.grade_level as string | null;
        const teacher = row.employees as { id: string; first_name: string; last_name: string } | null;
        if (!grade || !teacher || explicitTeacherIds.has(teacher.id)) continue;
        const key = `${grade}::${teacher.id}`;
        const entry = counts.get(key);
        if (entry) entry.count++;
        else counts.set(key, { grade, teacher, count: 1 });
      }

      for (const { grade, teacher, count } of counts.values()) {
        if (count < MIN_STUDENTS_FOR_HOMEROOM) continue;
        (homerooms[grade] ??= []).push({ id: teacher.id, name: `${teacher.first_name} ${teacher.last_name}` });
      }
      for (const grade of Object.keys(homerooms)) {
        homerooms[grade].sort((a, b) => a.name.localeCompare(b.name));
      }
    }

    // Fallback only covers schools that haven't configured grade_levels yet
    // (see schools.grade_levels, set via admin onboarding) — PK is
    // deliberately excluded since it isn't a real grade at most schools.
    const gradeLevels = (school.grade_levels as string[] | null)?.length
      ? school.grade_levels as string[]
      : ['K','1','2','3','4','5','6','7','8','9','10','11','12'];

    return json({
      campaign_id:   campaign.id,
      school_id:     campaign.school_id,
      campaign_name: campaign.name,
      school_name:   school.name,
      school_logo:   school.logo_url ?? null,
      field_config:  fieldConfig,
      grade_levels:  gradeLevels,
      homerooms,
    });

  } catch (err) {
    console.error("guardian_intake_lookup error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
