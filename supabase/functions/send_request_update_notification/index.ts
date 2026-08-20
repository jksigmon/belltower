import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
if (!RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const DEFAULT_FROM     = "Belltower Requests <requests@belltower.school>";
const DEFAULT_REPLY_TO = "no-reply@belltower.school";
const APP_BASE_URL     = Deno.env.get("APP_BASE_URL") ?? "https://belltower.school";

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
    const { request_id } = await req.json();
    if (!request_id) return new Response("Missing request_id", { status: 400 });

    const { data: req_row, error: reqErr } = await supabase
      .from("staff_requests")
      .select(`
        id, status, manager_notes, school_id,
        request_categories ( name, resolved_label, denied_label ),
        profiles!staff_requests_submitted_by_fkey ( display_name, email )
      `)
      .eq("id", request_id)
      .single();

    if (reqErr || !req_row) {
      console.error("Failed to load request", reqErr);
      return new Response("Request not found", { status: 404 });
    }

    const category  = req_row.request_categories as any;
    const submitter = req_row.profiles as any;
    if (!submitter?.email) {
      return new Response(JSON.stringify({ ok: true, skipped: "no submitter email" }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const { data: school } = await supabase
      .from("schools")
      .select("notifications_from_email, notifications_reply_to, pto_from_email, pto_reply_to")
      .eq("id", req_row.school_id)
      .single();

    const fromAddr = school?.notifications_from_email ?? school?.pto_from_email ?? DEFAULT_FROM;
    const replyTo  = school?.notifications_reply_to   ?? school?.pto_reply_to   ?? DEFAULT_REPLY_TO;
    const viewUrl  = `${APP_BASE_URL}/app/requests.html`;

    const statusLabel = ({
      pending:   "Pending",
      in_review: "In Review",
      resolved:  category.resolved_label || "Resolved",
      completed: "Completed",
      denied:    category.denied_label   || "Denied",
    } as Record<string, string>)[req_row.status] ?? req_row.status;

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333;max-width:600px;">
        <h3 style="margin-top:0;color:#111827;">Your ${category.name} request was updated</h3>
        <p>Status: <strong>${statusLabel}</strong></p>
        ${req_row.manager_notes
          ? `<p style="margin-top:16px;"><strong>Note from the reviewer:</strong></p>
             <p style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;white-space:pre-wrap;">${req_row.manager_notes}</p>`
          : ""}
        <p style="margin-top:20px;">
          <a href="${viewUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;">
            View in Belltower
          </a>
        </p>
      </div>
    `;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddr,
        reply_to: replyTo,
        to: submitter.email,
        subject: `Update on your ${category.name} request: ${statusLabel}`,
        html,
      }),
    });
    if (!res.ok) console.error("Resend error", await res.text());

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });

  } catch (err) {
    console.error("send_request_update_notification error", err);
    return new Response("Internal error", { status: 500 });
  }
});
