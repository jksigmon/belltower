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
    // Sourced solely from employees.grade, an explicit admin-set grade
    // assignment. Previously this also derived a fallback from active
    // students' homeroom_teacher_id, but that surfaced teachers who are
    // still active employees yet no longer hold a classroom (e.g. moved to
    // a non-teaching role) as long as some of their old students hadn't
    // been reassigned. employees.grade is now the single source of truth --
    // a teacher who should appear here needs it set.
    let homerooms: Record<string, { id: string; name: string }[]> = {};
    if (fieldConfig.homeroom_teacher) {
      const { data: teachers } = await supabase
        .from("employees")
        .select("id, first_name, last_name, grade")
        .eq("school_id", campaign.school_id)
        .eq("active", true)
        .not("grade", "is", null);

      for (const teacher of teachers ?? []) {
        (homerooms[teacher.grade as string] ??= []).push({ id: teacher.id, name: `${teacher.first_name} ${teacher.last_name}` });
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
