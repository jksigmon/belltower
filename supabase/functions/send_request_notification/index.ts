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

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// request-attachments is a private bucket; "file" field values are bare
// storage paths (or, for rows saved before that change, a legacy public
// URL). Resolve to a signed URL before linking it in an email -- give it a
// week rather than the 1-hour signed URLs used for in-app viewing, since a
// notification email is read later, not immediately.
const REQUEST_ATTACHMENTS_BUCKET = "request-attachments";
const REQUEST_ATTACHMENTS_PUBLIC_MARKER = `/object/public/${REQUEST_ATTACHMENTS_BUCKET}/`;
const EMAIL_ATTACHMENT_LINK_TTL = 60 * 60 * 24 * 7;

function requestAttachmentPath(value: string): string | null {
  if (!value) return null;
  const idx = value.indexOf(REQUEST_ATTACHMENTS_PUBLIC_MARKER);
  return idx === -1 ? value : decodeURIComponent(value.slice(idx + REQUEST_ATTACHMENTS_PUBLIC_MARKER.length));
}

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

    const fileValues = (responses ?? [])
      .filter((r: any) => r.request_category_fields?.field_type === "file" && r.value)
      .map((r: any) => r.value as string);

    const signedUrlByPath = new Map<string, string>();
    if (fileValues.length) {
      const paths = [...new Set(fileValues.map(requestAttachmentPath).filter((p): p is string => !!p))];
      const { data: signedData } = await supabase.storage
        .from(REQUEST_ATTACHMENTS_BUCKET)
        .createSignedUrls(paths, EMAIL_ATTACHMENT_LINK_TTL);
      // Keyed off each result's own `path` rather than array position --
      // safer than assuming createSignedUrls preserves input order.
      (signedData ?? []).forEach((d: any) => {
        if (!d.error && d.signedUrl && d.path) signedUrlByPath.set(d.path, d.signedUrl);
      });
    }

    const responsesHtml = (responses ?? []).map((r: any) => {
      const label = r.request_category_fields?.label ?? "Field";
      const type  = r.request_category_fields?.field_type;
      let val: string;
      if (!r.value) {
        val = "(no response)";
      } else if (type === "boolean") {
        val = r.value === "true" ? "Yes" : "No";
      } else if (type === "file") {
        const path   = requestAttachmentPath(r.value);
        const signed = path ? signedUrlByPath.get(path) : undefined;
        val = signed ? `<a href="${esc(signed)}">View Attachment</a>` : "(attachment unavailable)";
      } else if (type === "url" && /^https?:\/\//i.test(r.value)) {
        val = `<a href="${esc(r.value)}">${esc(r.value)}</a>`;
      } else {
        val = esc(r.value);
      }
      return `<tr>
        <td style="padding:6px 0 2px 0;font-weight:600;color:#374151;">${esc(label)}</td>
      </tr>
      <tr>
        <td style="padding:0 0 10px 0;color:#111827;word-break:break-word;">${val}</td>
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
