import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
if (!RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const DEFAULT_FROM    = "Belltower Requests <requests@belltower.school>";
const DEFAULT_REPLY_TO = "no-reply@belltower.school";
const APP_BASE_URL    = Deno.env.get("APP_BASE_URL") ?? "https://belltower.school";

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

    // Load request + category + submitter profile
    const { data: req_row, error: reqErr } = await supabase
      .from("staff_requests")
      .select(`
        id, status, created_at, school_id, assigned_manager_id,
        request_categories ( id, name, notify_managers ),
        profiles!staff_requests_submitted_by_fkey ( display_name, email )
      `)
      .eq("id", request_id)
      .single();

    if (reqErr || !req_row) {
      console.error("Failed to load request", reqErr);
      return new Response("Request not found", { status: 404 });
    }

    const category = req_row.request_categories as any;
    const submitter = req_row.profiles as any;

    // Load field responses with labels
    const { data: responses } = await supabase
      .from("staff_request_responses")
      .select(`
        value,
        request_category_fields ( label, field_type, sort_order )
      `)
      .eq("request_id", request_id)
      .order("request_category_fields(sort_order)");

    // Load category managers' emails (profile_id needed for routing)
    const { data: managers } = await supabase
      .from("request_category_managers")
      .select("profile_id, profiles!request_category_managers_profile_id_fkey ( email, display_name )")
      .eq("category_id", category.id);

    // Load school email config
    const { data: school } = await supabase
      .from("schools")
      .select("notifications_from_email, notifications_reply_to, pto_from_email, pto_reply_to")
      .eq("id", req_row.school_id)
      .single();

    const fromAddr = school?.notifications_from_email ?? school?.pto_from_email ?? DEFAULT_FROM;
    const replyTo  = school?.notifications_reply_to   ?? school?.pto_reply_to   ?? DEFAULT_REPLY_TO;
    const manageUrl = `${APP_BASE_URL}/app/requests-manage.html`;
    const submittedAt = new Date(req_row.created_at).toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit"
    });

    const responsesHtml = (responses ?? []).map((r: any) => {
      const label = r.request_category_fields?.label ?? "Field";
      const val   = r.value ?? "(no response)";
      return `<tr>
        <td style="padding:6px 12px 6px 0;font-weight:600;white-space:nowrap;vertical-align:top;color:#374151;">${label}</td>
        <td style="padding:6px 0;color:#111827;">${val}</td>
      </tr>`;
    }).join("");

    const managerHtml = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333;max-width:600px;">
        <h3 style="margin-top:0;color:#111827;">New Request: ${category.name}</h3>
        <p><strong>${submitter.display_name ?? submitter.email}</strong> submitted a new request on ${submittedAt}.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />
        <table style="width:100%;border-collapse:collapse;">
          ${responsesHtml || '<tr><td colspan="2" style="color:#9ca3af;">No fields submitted.</td></tr>'}
        </table>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />
        <p>
          <a href="${manageUrl}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;">
            View in Request Manager
          </a>
        </p>
      </div>
    `;

    const submitterHtml = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333;max-width:600px;">
        <h3 style="margin-top:0;color:#111827;">Your request has been received</h3>
        <p>Your <strong>${category.name}</strong> request was submitted on ${submittedAt}. You'll be notified when it's been reviewed.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />
        <p><strong>What you submitted:</strong></p>
        <table style="width:100%;border-collapse:collapse;">
          ${responsesHtml || '<tr><td colspan="2" style="color:#9ca3af;">No fields submitted.</td></tr>'}
        </table>
      </div>
    `;

    const emailJobs: Promise<void>[] = [];

    // Recipient selection:
    // 1. notify_managers off → no manager emails at all (queue only)
    // 2. routed (assigned_manager_id) → only that manager, IF they are
    //    still a manager of this form — otherwise fail soft to everyone
    //    (a wrong inbox is worse than an extra one)
    // 3. unrouted → all managers (original behavior)
    let recipients = managers ?? [];
    if (category.notify_managers === false) {
      recipients = [];
    } else if (req_row.assigned_manager_id) {
      const routed = recipients.filter(
        (m: any) => m.profile_id === req_row.assigned_manager_id
      );
      if (routed.length) recipients = routed;
    }

    for (const m of recipients) {
      const mgr = (m as any).profiles;
      if (!mgr?.email) continue;
      emailJobs.push(sendEmail({
        from: fromAddr, replyTo,
        to: mgr.email,
        subject: `New ${category.name} Request from ${submitter.display_name ?? submitter.email}`,
        html: managerHtml,
      }));
    }

    // Confirm to submitter
    if (submitter?.email) {
      emailJobs.push(sendEmail({
        from: fromAddr, replyTo,
        to: submitter.email,
        subject: `Request Received: ${category.name}`,
        html: submitterHtml,
      }));
    }

    await Promise.all(emailJobs);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });

  } catch (err) {
    console.error("send_request_notification error", err);
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
