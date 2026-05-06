import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    /* --------------------------------------------------
       1. Parse input
    -------------------------------------------------- */
    const { start_date, end_date } = await req.json();

    if (!start_date || !end_date) {
      return new Response(
        JSON.stringify({ error: "Missing date range" }),
        { status: 400, headers: corsHeaders }
      );
    }

    /* --------------------------------------------------
       2. Manual JWT auth (Verify JWT OFF)
    -------------------------------------------------- */
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: corsHeaders }
      );
    }

    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: {
            Authorization: authHeader,
          },
        },
      }
    );

    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: corsHeaders }
      );
    }

    /* --------------------------------------------------
       3. Admin client
    -------------------------------------------------- */
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    /* --------------------------------------------------
       4. Profile + permission
    -------------------------------------------------- */
  const { data: profile, error: profileError } = await admin
  .from("profiles")
  .select("school_id, can_view_pto_calendar")
  .eq("user_id", user.id)
  .single();

if (profileError || !profile?.can_view_pto_calendar) {
  return new Response(
    JSON.stringify({ error: "Forbidden" }),
    { status: 403, headers: corsHeaders }
  );
}


    /* --------------------------------------------------
       5. Module guard (PTO)
    -------------------------------------------------- */
    const { data: moduleRow } = await admin
      .from("school_modules")
      .select("enabled")
      .eq("school_id", profile.school_id)
      .eq("module", "pto")
      .maybeSingle();

    if (!moduleRow?.enabled) {
      return new Response(
        JSON.stringify({ error: "PTO module not enabled" }),
        { status: 403, headers: corsHeaders }
      );
    }

    /* --------------------------------------------------
       6. Query PTO
    -------------------------------------------------- */
   
const { data: requests, error } = await admin
  .from("pto_requests")
  .select(`
    id,
    start_date,
    end_date,
    start_time,
    end_time,
    partial_day,
    pto_type,
      employees:employees!pto_requests_employee_id_fkey (
      first_name,
      last_name
    )
  `)
  .eq("school_id", profile.school_id)
  .eq("status", "APPROVED")
  .lte("start_date", end_date)
  .gte("end_date", start_date)
  .order("start_date");


    if (error) {
      console.error(error);
      return new Response(
        JSON.stringify({ error: "Server error" }),
        { status: 500, headers: corsHeaders }
      );
    }

    /* --------------------------------------------------
       7. Map to calendar events
    -------------------------------------------------- */
    
const events = (requests ?? []).map((r) => {

const name = r.employees
  ? `${r.employees.first_name} ${r.employees.last_name}`
  : "Unknown Employee";


  // ✅ Partial day PTO → timed event
  if (r.partial_day && r.start_time && r.end_time) {
    return {
      id: r.id,
      title: `${name} – ${r.pto_type}`,
      start: `${r.start_date}T${r.start_time}`,
      end: `${r.start_date}T${r.end_time}`,
      allDay: false,
      pto_type: r.pto_type,
    };
  }

  // ✅ Full day PTO → all‑day event (end exclusive)
  const endExclusive = new Date(r.end_date);
  endExclusive.setDate(endExclusive.getDate() + 1);

  return {
    id: r.id,
    title: `${name} – ${r.pto_type}`,
    start: r.start_date,
    end: endExclusive.toISOString().slice(0, 10),
    allDay: true,
    pto_type: r.pto_type,
  };
});


    return new Response(JSON.stringify(events), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: "Server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
});
