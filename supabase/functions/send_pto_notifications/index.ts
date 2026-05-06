import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ✅ Secret used to SIGN approval links
const PTO_APPROVAL_SECRET = Deno.env.get("PTO_APPROVAL_HMAC_SECRET");
if (!PTO_APPROVAL_SECRET) {
  throw new Error("Missing PTO_APPROVAL_HMAC_SECRET");
}

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
if (!RESEND_API_KEY) {
  throw new Error("Missing RESEND_API_KEY");
}

const DECISION_HANDLER_URL = Deno.env.get("DECISION_HANDLER_URL");
if (!DECISION_HANDLER_URL) {
  throw new Error("Missing DECISION_HANDLER_URL");
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const FROM_ADDRESS = "Belltower PTO <pto@belltower.school>";
const REPLY_TO = "no-reply@belltower.school";


function formatDate(dateStr: string) {
  // Expecting ISO date (YYYY-MM-DD)
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function formatDateRange(start: string, end: string) {
  if (start === end) {
    return formatDate(start);
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}


function renderPtoEmail({
  title,
  intro,
  request,
  employee,
  showActions = false,
  approveUrl,
  denyUrl,
  footer
}: {
  title: string;
  intro: string;
  request: any;
  employee: any;
  showActions?: boolean;
  approveUrl?: string;
  denyUrl?: string;
  footer?: string;
}) {
  const dateText = formatDateRange(
    request.start_date,
    request.end_date
  );

  const durationText = request.requested_hours
    ? `${request.requested_hours} hours`
    : '';

  const durationLabel = request.requested_duration_label
    ? ` (${request.requested_duration_label})`
    : '';

  const notesHtml = request.notes
    ? `<p><strong>Notes:</strong><br/>${request.notes}</p>`
    : '';

  const actionsHtml = showActions && approveUrl && denyUrl
    ? `
      <hr style="border:none;border-top:1px solid #ddd;margin:16px 0;" />
      <p><strong>Action required:</strong></p>
      <p>
        <a href="${approveUrl}">✅ Approve</a><br/>
        <a href="${denyUrl}">❌ Deny</a>
      </p>
      <p style="font-size:12px;color:#666;">
        These links expire in 24 hours.
      </p>
    `
    : '';

  const footerHtml = footer
    ? `<p style="font-size:12px;color:#666;margin-top:16px;">${footer}</p>`
    : '';

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #333;">
      <h3 style="margin-top:0;">${title}</h3>

      <p>${intro}</p>

      <hr style="border:none;border-top:1px solid #ddd;margin:16px 0;" />

      <p>
        <strong>Employee:</strong><br/>
        ${employee.first_name} ${employee.last_name}
      </p>

      <p>
        <strong>Dates:</strong><br/>
        ${dateText}
      </p>

      <p>
        <strong>PTO type:</strong><br/>
        ${request.pto_type}
      </p>

      <p>
        <strong>Duration:</strong><br/>
        ${durationText}${durationLabel}
      </p>

      ${notesHtml}

      ${actionsHtml}

      ${footerHtml}
    </div>
  `;
}


serve(async (req) => {
  try {
    const payload = await req.json();
    const { event, old_status, new_status, pto_request_id } = payload;

    if (!pto_request_id) {
      return new Response("Missing PTO request ID", { status: 400 });
    }

    // ----------------------------------------------------
    // Load PTO request + employee
    // ----------------------------------------------------
   
const { data: request, error } = await supabase
  .from("pto_requests")
  .select(`
    *,
    employees!pto_requests_employee_id_fkey (
      id,
      first_name,
      last_name,
      email,
      supervisor_id,
      school_id
    )
  `)
  .eq("id", pto_request_id)
  .single();


    if (error || !request) {
      console.error("PTO request load failed", error);
      return new Response("Request not found", { status: 404 });
    }

    const employee = request.employees;

 
// ----------------------------------------------------
// Resolve approvers
// ----------------------------------------------------
let approvers: any[] = [];

// 1. Fallback approvers always receive every request for their school
const { data: fallbackData } = await supabase
  .from("profiles")
  .select("employee_id, email")
  .eq("school_id", employee.school_id)
  .eq("is_fallback_approver", true)
  .eq("can_approve_pto", true);

approvers = fallbackData || [];

// 2. If the employee has a supervisor, add them too (deduplicated)
if (employee.supervisor_id) {
  const { data: supervisorProfile } = await supabase
    .from("profiles")
    .select("employee_id, email")
    .eq("employee_id", employee.supervisor_id)
    .eq("can_approve_pto", true)
    .maybeSingle();

  if (supervisorProfile?.email) {
    const alreadyIncluded = approvers.some(
      (a) => a.employee_id === supervisorProfile.employee_id
    );
    if (!alreadyIncluded) {
      approvers.push(supervisorProfile);
    }
  }
}

// 3. Last resort: no fallback approvers configured — notify all approvers in the school
if (approvers.length === 0) {
  const { data: allApprovers } = await supabase
    .from("profiles")
    .select("employee_id, email")
    .eq("school_id", employee.school_id)
    .eq("can_approve_pto", true);

  approvers = allApprovers || [];
}



// ----------------------------------------------------
// Notifications
// ----------------------------------------------------
if (event === "INSERT" && new_status === "PENDING") {
  await sendEmployeeSubmission(request, employee);
  await sendApproverRequest(request, employee, approvers);
}

if (event === "UPDATE" && old_status === "PENDING") {
  if (new_status === "APPROVED") {
    await sendEmployeeDecision(request, employee, "approved");

    // ✅ Notify substitute managers ONLY if coverage is needed AND only once
    if (request.needs_sub_coverage === true) {
      // Claim notification (idempotent): only the first invocation will "win"
      const { data: claimed, error: claimErr } = await supabase
        .from("pto_requests")
        .update({
          sub_coverage_notified_at: new Date().toISOString(),
          // decided_by is employees.id UUID in your system
          sub_coverage_notified_by: request.decided_by ?? null
        })
        .eq("id", request.id)
        .is("sub_coverage_notified_at", null)
        .select("id")
        .maybeSingle();

      if (claimErr) {
        console.error("Sub coverage notify claim failed", claimErr);
      } else if (claimed) {
        // Load substitute managers for this school
        const { data: subManagers, error: subErr } = await supabase
          .from("profiles")
          .select("email")
          .eq("school_id", employee.school_id)
          .eq("can_manage_substitutes", true)
          .not("email", "is", null);

        if (subErr) {
          console.error("Failed to load substitute managers", subErr);
        } else if ((subManagers ?? []).length > 0) {
          for (const mgr of subManagers!) {
            await sendEmail({
              to: mgr.email,
              subject: "Substitute/Coverage Needed (PTO Approved)",
              html: renderPtoEmail({
                title: "Substitute/Coverage Needed",
                intro: `✅ PTO was approved and substitute/coverage is needed for ${employee.first_name} ${employee.last_name}.`,
                request,
                employee,
                footer:
                  "This request was marked as needing substitute/coverage. Please arrange coverage."
              })
            });
          }
        } else {
          console.warn(
            "No substitute managers found for school:",
            employee.school_id
          );
        }
      }
    }
  }

  if (new_status === "DENIED") {
    await sendEmployeeDecision(request, employee, "denied");
  }
}

if (
  event === "UPDATE" &&
  old_status === "APPROVED" &&
  (new_status === "CANCEL_REQUESTED" || new_status === "RESCIND_REQUESTED")
) {
  await sendCancellationRequest(request, employee, approvers);
}

if (event === "UPDATE" && old_status === "CANCEL_REQUESTED" && new_status === "CANCELLED") {
  await sendEmployeeCancellation(request, employee);

  // ✅ Guard: Only notify substitute managers for FUTURE cancels.
  // Past dates should go through RESCIND_REQUESTED flow instead.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(`${request.start_date}T00:00:00`);
  start.setHours(0, 0, 0, 0);

  const isFutureStart = start > today;

  if (isFutureStart && request.needs_sub_coverage === true) {
    const { data: subManagers, error: subErr } = await supabase
      .from("profiles")
      .select("email")
      .eq("school_id", employee.school_id)
      .eq("can_manage_substitutes", true)
      .not("email", "is", null);

    if (subErr) {
      console.error("Failed to load substitute managers (cancel)", subErr);
    } else if ((subManagers ?? []).length > 0) {
      for (const mgr of subManagers!) {
        await sendEmail({
          to: mgr.email,
          subject: "Coverage No Longer Needed (PTO Cancelled)",
          html: renderPtoEmail({
            title: "Coverage No Longer Needed",
            intro: `⚠️ This previously approved PTO was cancelled. Coverage is no longer needed for ${employee.first_name} ${employee.last_name}.`,
            request,
            employee,
            footer: "If you already arranged coverage, please cancel/unassign the substitute."
          })
        });
      }
    } else {
      console.warn("No substitute managers found for school (cancel):", employee.school_id);
    }
  }
}

return new Response("OK");

  } catch (err) {
    console.error("Notification error", err);
    return new Response("Internal error", { status: 500 });
  }
});

/* ------------------------------------------------------------------
   TOKEN GENERATION
------------------------------------------------------------------ */
async function createApprovalToken(payload: {
  requestId: string;
  approverEmployeeId: string;
  action: "approve" | "deny";
  expiresAt: number;
}) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(PTO_APPROVAL_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const data = JSON.stringify(payload);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));

  return (
    btoa(data) + "." +
    btoa(String.fromCharCode(...new Uint8Array(signature)))
  );
}

/* ------------------------------------------------------------------
   EMAIL HELPERS
------------------------------------------------------------------ */

async function sendEmployeeSubmission(request: any, employee: any) {
  await sendEmail({
    to: employee.email,
    subject: "PTO Request Submitted",
    html: renderPtoEmail({
      title: "PTO Request Submitted",
      intro: "✅ Your PTO request has been successfully submitted.",
      request,
      employee,
      footer: "You’ll be notified once your request is reviewed."
    })
  });
}

async function sendApproverRequest(request: any, employee: any, approvers: any[]) {
  for (const approver of approvers) {
    const expiresAt = Date.now() + 1000 * 60 * 60 * 24;

    const approveToken = await createApprovalToken({
      requestId: request.id,
      approverEmployeeId: approver.employee_id,
      action: "approve",
      expiresAt
    });

    const denyToken = await createApprovalToken({
      requestId: request.id,
      approverEmployeeId: approver.employee_id,
      action: "deny",
      expiresAt
    });

    const base = DECISION_HANDLER_URL;

    const approveUrl = `${base}?token=${encodeURIComponent(approveToken)}`;
    const denyUrl = `${base}?token=${encodeURIComponent(denyToken)}`;

    await sendEmail({
      to: approver.email,
      subject: "PTO Approval Required",
      html: renderPtoEmail({
        title: "PTO Approval Required",
        intro: `${employee.first_name} ${employee.last_name} has submitted a PTO request that requires your approval.`,
        request,
        employee,
        showActions: true,
        approveUrl,
        denyUrl
      })
    });
  }
}


async function sendEmployeeDecision(request: any, employee: any, decision: string) {
  await sendEmail({
    to: employee.email,
    subject: `PTO Request ${decision.toUpperCase()}`,
    html: renderPtoEmail({
      title: `PTO Request ${decision.toUpperCase()}`,
      intro: `✅ Your PTO request has been <strong>${decision}</strong>.`,
      request,
      employee
    })
  });
}

async function loadSubstituteManagers(schoolId: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("employee_id, email")
    .eq("school_id", schoolId)
    .eq("can_manage_substitutes", true)
    .not("email", "is", null);

  if (error) {
    console.error("Failed to load substitute managers", error);
    return [];
  }
  return data || [];
}

async function sendSubCoverageNeeded(request: any, employee: any, managers: any[]) {
  for (const mgr of managers) {
    await sendEmail({
      to: mgr.email,
      subject: "Substitute/Coverage Needed (PTO Approved)",
      html: renderPtoEmail({
        title: "Substitute/Coverage Needed",
        intro: `✅ PTO was approved and coverage is needed for ${employee.first_name} ${employee.last_name}.`,
        request,
        employee,
        footer: "Please arrange coverage. This request was marked as needing substitute/coverage."
      })
    });
  }
}


async function sendCancellationRequest(
  request: any,
  employee: any,
  approvers: any[]
) {
  const isRescind = request.status === "RESCIND_REQUESTED";

  for (const approver of approvers) {
    const expiresAt = Date.now() + 1000 * 60 * 60 * 24;

    const approveToken = await createApprovalToken({
      requestId: request.id,
      approverEmployeeId: approver.employee_id,
      action: "approve",
      expiresAt
    });

    const denyToken = await createApprovalToken({
      requestId: request.id,
      approverEmployeeId: approver.employee_id,
      action: "deny",
      expiresAt
    });

    const base = DECISION_HANDLER_URL;

    const approveUrl = `${base}?token=${encodeURIComponent(approveToken)}`;
    const denyUrl = `${base}?token=${encodeURIComponent(denyToken)}`;

    await sendEmail({
      to: approver.email,
      subject: isRescind
        ? "PTO Rescind Approval Required"
        : "PTO Cancellation Approval Required",
      html: renderPtoEmail({
        title: isRescind
          ? "PTO Rescind Request"
          : "PTO Cancellation Request",
        intro: isRescind
          ? `${employee.first_name} ${employee.last_name} has requested to rescind a previously approved PTO (past dates).`
          : `${employee.first_name} ${employee.last_name} has requested to cancel a previously approved PTO.`,
        request,
        employee,
        showActions: true,
        approveUrl,
        denyUrl,
        footer: "Please approve or deny this request. These links expire in 24 hours."
      })
    });
  }
}



async function sendEmployeeCancellation(request: any, employee: any) {
  await sendEmail({
    to: employee.email,
    subject: "PTO Cancellation Confirmed",
    html: renderPtoEmail({
      title: "PTO Cancellation Confirmed",
      intro: "✅ Your PTO request has been successfully cancelled.",
      request,
      employee,
      footer: "If you have questions, please contact your administrator."
    })
  });
}


async function sendEmail({
  to,
  subject,
  html
}: {
  to: string;
  subject: string;
  html: string;
}) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      reply_to: REPLY_TO,
      to,
      subject,
      html
    })
  });

  if (!res.ok) {
    console.error("Resend error", await res.text());
  }
}