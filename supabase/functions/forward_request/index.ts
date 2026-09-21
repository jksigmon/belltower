import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
if (!RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseService = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const DEFAULT_FROM     = "Belltower Requests <requests@belltower.school>";
const DEFAULT_REPLY_TO = "no-reply@belltower.school";
const MAX_NOTE_LENGTH  = 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // ── Auth ──────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authErr } = await supabaseUser.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const { data: profile } = await supabaseService
      .from("profiles")
      .select("id, school_id, display_name, email")
      .eq("user_id", user.id)
      .single();
    if (!profile) return json({ error: "Profile not found" }, 404);

    // ── Payload ───────────────────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const request_id: string | undefined     = body.request_id;
    const destination_id: string | undefined = body.destination_id;
    const note = typeof body.note === "string" ? body.note.trim() : "";

    if (!request_id || !destination_id) {
      return json({ error: "request_id and destination_id are required" }, 400);
    }
    if (note.length > MAX_NOTE_LENGTH) {
      return json({ error: `Note must be ${MAX_NOTE_LENGTH} characters or fewer.` }, 400);
    }

    // ── Authorization ─────────────────────────────────────────────────
    // Same rule as updating the request: a manager of its form, a
    // superadmin, or a school-wide reviewer (not on confidential forms).
    const { data: allowed, error: allowErr } = await supabaseService
      .rpc("can_action_request", { p_request_id: request_id, p_user_id: user.id });
    if (allowErr) {
      console.error("can_action_request failed", allowErr);
      return json({ error: "Could not verify permission" }, 500);
    }
    if (!allowed) return json({ error: "You don't have permission to forward this request." }, 403);

    // ── Load request, destination, answers ───────────────────────────
    const { data: reqRow, error: reqErr } = await supabaseService
      .from("staff_requests")
      .select(`
        id, school_id, created_at, manager_notes,
        request_categories ( name ),
        profiles!staff_requests_submitted_by_fkey ( display_name, email )
      `)
      .eq("id", request_id)
      .single();
    if (reqErr || !reqRow) return json({ error: "Request not found" }, 404);
    if (reqRow.school_id !== profile.school_id) return json({ error: "Forbidden" }, 403);

    const { data: dest } = await supabaseService
      .from("request_forward_destinations")
      .select("id, name, email, is_active")
      .eq("id", destination_id)
      .eq("school_id", reqRow.school_id)
      .single();
    if (!dest || !dest.is_active) {
      return json({ error: "That destination isn't available. Pick another one." }, 400);
    }

    const { data: responses } = await supabaseService
      .from("staff_request_responses")
      .select("value, request_category_fields ( label, field_type, sort_order )")
      .eq("request_id", request_id);

    const { data: school } = await supabaseService
      .from("schools")
      .select("timezone, notifications_from_email, notifications_reply_to, pto_from_email, pto_reply_to")
      .eq("id", reqRow.school_id)
      .single();

    const category  = reqRow.request_categories as any;
    const submitter = reqRow.profiles as any;
    const tz        = school?.timezone ?? "America/New_York";
    const fromAddr  = school?.notifications_from_email ?? school?.pto_from_email ?? DEFAULT_FROM;
    const fallbackReplyTo = school?.notifications_reply_to ?? school?.pto_reply_to ?? DEFAULT_REPLY_TO;

    // Replies go to the manager who forwarded it, so the recipient talks to a
    // person rather than a no-reply mailbox.
    const replyTo        = profile.email || fallbackReplyTo;
    const forwarderName  = profile.display_name || profile.email || "A staff member";
    const submitterName  = submitter?.display_name || submitter?.email || "Unknown";

    const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
      new Date(iso).toLocaleString("en-US", { timeZone: tz, ...opts });
    const submittedAt = fmt(reqRow.created_at, {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    });
    const forwardedOn = fmt(new Date().toISOString(), { month: "short", day: "numeric", year: "numeric" });

    const answersHtml = (responses ?? [])
      .slice()
      .sort((a: any, b: any) =>
        (a.request_category_fields?.sort_order ?? 0) - (b.request_category_fields?.sort_order ?? 0))
      .map((r: any) => {
        const label = r.request_category_fields?.label ?? "Field";
        const type  = r.request_category_fields?.field_type;
        let value: string;
        if (!r.value) {
          value = "(no response)";
        } else if (type === "boolean") {
          value = r.value === "true" ? "Yes" : "No";
        } else if ((type === "file" || type === "url") && /^https?:\/\//i.test(r.value)) {
          value = `<a href="${esc(r.value)}">${esc(r.value)}</a>`;
        } else {
          value = esc(r.value);
        }
        return `<tr><td style="padding:6px 0 2px 0;font-weight:600;color:#374151;">${esc(label)}</td></tr>
                <tr><td style="padding:0 0 10px 0;color:#111827;word-break:break-word;">${value}</td></tr>`;
      }).join("");

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333;max-width:600px;">
        <h3 style="margin-top:0;color:#111827;">Forwarded request: ${esc(category?.name)}</h3>
        <p><strong>${esc(forwarderName)}</strong> forwarded this request to you.
           Reply to this email to reach them.</p>
        ${note
          ? `<p style="margin-top:16px;"><strong>Note from ${esc(forwarderName)}:</strong></p>
             <p style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;white-space:pre-wrap;">${esc(note)}</p>`
          : ""}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />
        <p style="margin:0 0 12px;">Submitted by <strong>${esc(submitterName)}</strong>${
          submitter?.email && submitter.email !== submitterName ? ` (${esc(submitter.email)})` : ""
        } on ${esc(submittedAt)}.</p>
        <table style="width:100%;border-collapse:collapse;">
          ${answersHtml || '<tr><td style="color:#9ca3af;">No fields submitted.</td></tr>'}
        </table>
      </div>`;

    // ── Send first, record after ─────────────────────────────────────
    // If the email fails nothing is logged and no note is added, so the
    // manager isn't told a request was forwarded when it wasn't.
    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromAddr,
        reply_to: replyTo,
        to: dest.email,
        subject: `Forwarded ${category?.name ?? "request"} from ${submitterName}`,
        html,
      }),
    });
    if (!sendRes.ok) {
      console.error("Resend error", await sendRes.text());
      return json({ error: "The email could not be sent. Nothing was forwarded." }, 502);
    }

    const { data: logRow, error: logErr } = await supabaseService
      .from("request_forwards")
      .insert({
        school_id:         reqRow.school_id,
        request_id:        reqRow.id,
        forwarded_by:      profile.id,
        destination_id:    dest.id,
        destination_name:  dest.name,
        destination_email: dest.email,
        note:              note || null,
      })
      .select("id, created_at, destination_name, destination_email, note, forwarded_by")
      .single();
    if (logErr) console.error("request_forwards insert failed", logErr);

    // The manager note is visible to the submitter, so it names the
    // destination but not its email address.
    const line = `Forwarded to ${dest.name} on ${forwardedOn}.`;
    const existingNotes = (reqRow.manager_notes ?? "").trim();
    const newNotes = existingNotes ? `${existingNotes}\n${line}` : line;
    const { error: noteErr } = await supabaseService
      .from("staff_requests")
      .update({ manager_notes: newNotes, updated_at: new Date().toISOString() })
      .eq("id", reqRow.id);
    if (noteErr) console.error("manager_notes update failed", noteErr);

    return json({
      ok: true,
      forward: logRow ?? null,
      logged: !logErr,
      manager_notes: noteErr ? existingNotes : newNotes,
    });
  } catch (err) {
    console.error("forward_request error", err);
    return json({ error: "Internal error" }, 500);
  }
});
