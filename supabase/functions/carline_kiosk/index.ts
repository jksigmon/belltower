import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url    = new URL(req.url);
    const action = url.searchParams.get("action");

    // GET ?action=schools — public list of schools (no auth required)
    if (req.method === "GET" && action === "schools") {
      const { data, error } = await supabase
        .from("schools")
        .select("id, name")
        .order("name");
      if (error) throw error;
      return json({ schools: data ?? [] });
    }

    // POST — requires school_id + pin in body
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { school_id, pin } = body as { school_id?: string; pin?: string };

      if (!school_id || !pin) {
        return json({ error: "school_id and pin are required" }, 400);
      }

      // Validate PIN against school_settings
      const { data: settings, error: settingsErr } = await supabase
        .from("school_settings")
        .select("carline_kiosk_pin")
        .eq("school_id", school_id)
        .maybeSingle();

      if (settingsErr) throw settingsErr;

      const stored = settings?.carline_kiosk_pin;
      if (!stored || stored.trim() !== String(pin).trim()) {
        return json({ error: "Incorrect PIN" }, 401);
      }

      // PIN valid — return full data snapshot for this school
      return json(await buildSnapshot(school_id));
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error("carline_kiosk error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});

async function buildSnapshot(schoolId: string) {
  const today = new Date().toISOString().slice(0, 10);

  const [
    schoolRes,
    eventsRes,
    studentsRes,
    employeesRes,
    familiesRes,
    campusesRes,
    pickupGroupsRes,
  ] = await Promise.all([
    supabase.from("schools").select("id, name").eq("id", schoolId).single(),
    supabase
      .from("carline_events")
      .select("id, status, name, campus_id, all_call_at")
      .eq("school_id", schoolId)
      .eq("event_date", today)
      .neq("status", "CLOSED"),
    supabase
      .from("students")
      .select("id, first_name, last_name, preferred_name, grade_level, homeroom_teacher_id, family_id, campus_id")
      .eq("school_id", schoolId)
      .eq("active", true)
      .order("last_name"),
    supabase
      .from("employees")
      .select("id, first_name, last_name")
      .eq("school_id", schoolId)
      .eq("active", true),
    supabase
      .from("families")
      .select("id, carline_tag_number")
      .eq("school_id", schoolId)
      .eq("active", true),
    supabase.from("campuses").select("id, name").eq("school_id", schoolId).order("name"),
    supabase
      .from("carline_pickup_groups")
      .select("id, name, campus_id, grade_levels")
      .eq("school_id", schoolId)
      .eq("active", true),
  ]);

  const events = eventsRes.data ?? [];
  let calls: unknown[] = [];

  if (events.length > 0) {
    const eventIds = events.map((e: { id: string }) => e.id);
    const { data: callData } = await supabase
      .from("carline_calls")
      .select("student_id, status, called_at, carline_event_id, call_type")
      .in("carline_event_id", eventIds);
    calls = callData ?? [];
  }

  return {
    school:       schoolRes.data,
    events,
    students:     studentsRes.data     ?? [],
    employees:    employeesRes.data    ?? [],
    families:     familiesRes.data     ?? [],
    campuses:     campusesRes.data     ?? [],
    pickupGroups: pickupGroupsRes.data ?? [],
    calls,
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
