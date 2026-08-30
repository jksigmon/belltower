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
   Notifies a staff member when an admin flips `verified`
   on one of their licenses or CEU entries, in either
   direction. Invoked directly by admin.licensure.js right
   after the update (fire-and-forget) -- mirrors
   send_request_update_notification's shape for the
   Requests module.
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
    const { record_type, record_id, verified } = await req.json();
    if (!record_type || !record_id) return new Response("Missing record_type or record_id", { status: 400 });
    if (record_type !== "license" && record_type !== "ceu") {
      return new Response("Invalid record_type", { status: 400 });
    }

    let schoolId: string;
    let employeeId: string;
    let description: string;

    if (record_type === "license") {
      const { data: lic, error } = await supabase
        .from("staff_licenses")
        .select("school_id, employee_id, license_type, license_area")
        .eq("id", record_id)
        .single();
      if (error || !lic) return new Response("License not found", { status: 404 });

      schoolId    = lic.school_id as string;
      employeeId  = lic.employee_id as string;
      description = `${lic.license_type}${lic.license_area ? " — " + lic.license_area : ""} license`;
    } else {
      const { data: ceu, error } = await supabase
        .from("staff_license_ceus")
        .select("school_id, employee_id, title")
        .eq("id", record_id)
        .single();
      if (error || !ceu) return new Response("CEU entry not found", { status: 404 });

      schoolId    = ceu.school_id as string;
      employeeId  = ceu.employee_id as string;
      description = `"${ceu.title}" CEU entry`;
    }

    const { data: emp } = await supabase
      .from("employees")
      .select("first_name, email")
      .eq("id", employeeId)
      .single();

    if (!emp?.email) {
      return new Response(JSON.stringify({ ok: true, skipped: "no employee email" }), {
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
    const viewUrl  = `${APP_BASE_URL}/app/staff.html#licensure`;

    const subject = verified
      ? `Your ${description} has been verified`
      : `Verification removed on your ${description}`;

    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:540px;margin:0 auto;">
        <div style="background:#0b2d4f;padding:20px 24px;border-radius:10px 10px 0 0;">
          <p style="color:#f59e0b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 4px;">Belltower</p>
          <p style="color:#fff;font-size:18px;font-weight:700;margin:0;">${verified ? "Verification confirmed" : "Verification removed"}</p>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:24px;">
          <p>Hi ${emp.first_name},</p>
          <p>${verified
            ? `An administrator has reviewed and verified your <strong>${description}</strong>.`
            : `An administrator has removed verification on your <strong>${description}</strong>. You may need to provide additional documentation.`
          }</p>
          <p style="margin-top:20px;">
            <a href="${viewUrl}" style="display:inline-block;background:#0b2d4f;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;">
              View My Licenses
            </a>
          </p>
          <p style="color:#9ca3af;font-size:12px;margin-top:24px;">This is an automated message from Belltower. Contact your school administrator with questions.</p>
        </div>
      </div>
    `;

    await sendEmail({ from: fromAddr, replyTo, to: emp.email, subject, html });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    console.error("send_license_verification_notification error", err);
    return new Response("Internal error", { status: 500 });
  }
});

async function sendEmail({ from, replyTo, to, subject, html }: {
  from: string; replyTo: string; to: string; subject: string; html: string;
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
