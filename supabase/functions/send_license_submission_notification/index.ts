import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
if (!RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const DEFAULT_FROM     = "Belltower Licensure <notifications@belltower.school>";
const DEFAULT_REPLY_TO = "no-reply@belltower.school";
const APP_BASE_URL     = Deno.env.get("APP_BASE_URL") ?? "https://belltower.school";

/* ─────────────────────────────────────────────────────
   Notifies staff with can_manage_licensure that a staff
   member self-submitted a new license or CEU entry that's
   pending verification. Invoked directly by staff.html
   right after the insert (fire-and-forget) -- mirrors
   send_request_notification's shape for the Requests module.
───────────────────────────────────────────────────── */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const { record_type, record_id } = await req.json();
    if (!record_type || !record_id) return new Response("Missing record_type or record_id", { status: 400 });
    if (record_type !== "license" && record_type !== "ceu") {
      return new Response("Invalid record_type", { status: 400 });
    }

    let schoolId: string;
    let employeeName: string;
    let description: string;
    const viewAnchor = record_type === "ceu" ? "ceus" : "licenses";

    if (record_type === "license") {
      const { data: lic, error } = await supabase
        .from("staff_licenses")
        .select("school_id, license_type, license_area, employees ( first_name, last_name )")
        .eq("id", record_id)
        .single();
      if (error || !lic) return new Response("License not found", { status: 404 });

      const emp = lic.employees as unknown as { first_name: string; last_name: string } | null;
      schoolId = lic.school_id as string;
      employeeName = emp ? `${emp.first_name} ${emp.last_name}` : "A staff member";
      description = `${lic.license_type}${lic.license_area ? " — " + lic.license_area : ""} license`;
    } else {
      const { data: ceu, error } = await supabase
        .from("staff_license_ceus")
        .select("school_id, title, hours, employees ( first_name, last_name )")
        .eq("id", record_id)
        .single();
      if (error || !ceu) return new Response("CEU entry not found", { status: 404 });

      const emp = ceu.employees as unknown as { first_name: string; last_name: string } | null;
      schoolId = ceu.school_id as string;
      employeeName = emp ? `${emp.first_name} ${emp.last_name}` : "A staff member";
      description = `"${ceu.title}" CEU entry (${ceu.hours} hrs)`;
    }

    const { data: admins } = await supabase
      .from("profiles")
      .select("email")
      .eq("school_id", schoolId)
      .eq("can_manage_licensure", true)
      .eq("status", "active");

    const adminEmails = (admins ?? []).map((a: { email: string | null }) => a.email).filter(Boolean) as string[];
    if (!adminEmails.length) {
      return new Response(JSON.stringify({ ok: true, skipped: "no licensure admins" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const { data: school } = await supabase
      .from("schools")
      .select("notifications_from_email, notifications_reply_to")
      .eq("id", schoolId)
      .single();

    const fromAddr = school?.notifications_from_email ?? DEFAULT_FROM;
    const replyTo  = school?.notifications_reply_to   ?? DEFAULT_REPLY_TO;
    const viewUrl  = `${APP_BASE_URL}/app/licensure.html#${viewAnchor}`;
    const recordLabel = record_type === "ceu" ? "CEU entry" : "license";

    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:540px;margin:0 auto;">
        <div style="background:#0b2d4f;padding:20px 24px;border-radius:10px 10px 0 0;">
          <p style="color:#f59e0b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 4px;">Belltower</p>
          <p style="color:#fff;font-size:18px;font-weight:700;margin:0;">New ${recordLabel} pending verification</p>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:24px;">
          <p><strong>${employeeName}</strong> added a ${description}. It's usable right away but hasn't been reviewed yet.</p>
          <p style="margin-top:20px;">
            <a href="${viewUrl}" style="display:inline-block;background:#0b2d4f;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;">
              Review in Licensure
            </a>
          </p>
          <p style="color:#9ca3af;font-size:12px;margin-top:24px;">This is an automated message from Belltower.</p>
        </div>
      </div>
    `;

    await sendEmail({
      from: fromAddr, replyTo,
      to: adminEmails,
      subject: `New ${recordLabel} pending verification — ${employeeName}`,
      html,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    console.error("send_license_submission_notification error", err);
    return new Response("Internal error", { status: 500 });
  }
});

async function sendEmail({ from, replyTo, to, subject, html }: {
  from: string; replyTo: string; to: string | string[]; subject: string; html: string;
}) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, reply_to: replyTo, to, subject, html }),
  });
  if (!res.ok) console.error("Resend error", await res.text());
}
