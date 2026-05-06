import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* =====================================================
   ICS HELPERS
===================================================== */
function formatDateICS(dateStr: string) {
  // YYYYMMDD format (all-day event)
  return dateStr.replace(/-/g, "");
}

function escapeICS(text: string) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/* =====================================================
   EDGE FUNCTION
===================================================== */
serve(async (req) => {
  try {
    const url = new URL(req.url);
    const schoolId = url.searchParams.get("school_id");
    const token = url.searchParams.get("token");

    // ✅ Basic validation
    if (!schoolId || !token) {
      return new Response("Not Found", { status: 404 });
    }

    // ✅ Service-role client (server-only)
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    /* --------------------------------------------------
       1. Validate school + token
    -------------------------------------------------- */
    const { data: school, error: schoolError } = await admin
      .from("schools")
      .select("id, calendar_ics_token")
      .eq("id", schoolId)
      .single();

    if (
      schoolError ||
      !school ||
      school.calendar_ics_token !== token
    ) {
      // ❌ Do NOT leak info
      return new Response("Not Found", { status: 404 });
    }

    /* --------------------------------------------------
       2. Load APPROVED PTO requests
    -------------------------------------------------- */
    const { data: requests, error } = await admin
      .from("pto_requests")
      .select(`
        id,
        start_date,
        end_date,
        pto_type,
        employees (
          first_name,
          last_name
        )
      `)
      .eq("school_id", schoolId)
      .eq("status", "APPROVED");

    if (error) {
      console.error(error);
      return new Response("Server Error", { status: 500 });
    }

    /* --------------------------------------------------
       3. Build ICS content
    -------------------------------------------------- */
    let ics = "";
    ics += "BEGIN:VCALENDAR\r\n";
    ics += "VERSION:2.0\r\n";
    ics += "PRODID:-//YourApp//PTO Calendar//EN\r\n";
    ics += "CALSCALE:GREGORIAN\r\n";

    for (const r of requests) {
      const start = formatDateICS(r.start_date);
      const endExclusive = new Date(r.end_date);
      endExclusive.setDate(endExclusive.getDate() + 1);
      const end = formatDateICS(endExclusive.toISOString().slice(0, 10));

      const name = `${r.employees.first_name} ${r.employees.last_name}`;
      const summary = escapeICS(`${name} – ${r.pto_type}`);

      ics += "BEGIN:VEVENT\r\n";
      ics += `UID:pto-${r.id}@yourapp\r\n`;
      ics += `DTSTART;VALUE=DATE:${start}\r\n`;
      ics += `DTEND;VALUE=DATE:${end}\r\n`;
      ics += `SUMMARY:${summary}\r\n`;
      ics += "END:VEVENT\r\n";
    }

    ics += "END:VCALENDAR\r\n";

    /* --------------------------------------------------
       4. Return ICS
    -------------------------------------------------- */
    return new Response(ics, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });

  } catch (err) {
    console.error(err);
    return new Response("Server Error", { status: 500 });
  }
});