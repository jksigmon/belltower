
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PTO_APPROVAL_SECRET = Deno.env.get("PTO_APPROVAL_HMAC_SECRET");
if (!PTO_APPROVAL_SECRET) {
  throw new Error("Missing PTO_APPROVAL_HMAC_SECRET");
}

const APP_URL = Deno.env.get("APP_URL") ?? "https://belltower.school";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function verifyApprovalToken(token: string) {
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) {
    throw new Error("Invalid token format");
  }

  const payload = JSON.parse(atob(payloadB64));

  if (Date.now() > payload.expiresAt) {
    throw new Error("Token expired");
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(PTO_APPROVAL_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(atob(sigB64), c => c.charCodeAt(0)),
    encoder.encode(JSON.stringify(payload))
  );

  if (!valid) {
    throw new Error("Invalid token signature");
  }

  return payload;
}

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return new Response("Missing token", { status: 400 });
    }

    const payload = await verifyApprovalToken(token);
    const { requestId, action, approverEmployeeId } = payload;

    if (!approverEmployeeId) {
      return new Response("Invalid approver", { status: 400 });
    }

    if (action !== "approve" && action !== "deny") {
      return new Response("Invalid action", { status: 400 });
    }

    const { data: ptoRequest } = await supabase
      .from("pto_requests")
      .select("*")
      .eq("id", requestId)
      .single();

    if (!ptoRequest) {
      return new Response("Request not found", { status: 404 });
    }

    
if (
  ptoRequest.status !== "PENDING" &&
  ptoRequest.status !== "CANCEL_REQUESTED" &&
  ptoRequest.status !== "RESCIND_REQUESTED"
) {
  return new Response("Request already processed", { status: 409 });
}


const isCancellationRequest =
  ptoRequest.status === "CANCEL_REQUESTED" ||
  ptoRequest.status === "RESCIND_REQUESTED";

const newStatus =
  action === "approve"
    ? ptoRequest.status === "CANCEL_REQUESTED"
      ? "CANCELLED"
      : ptoRequest.status === "RESCIND_REQUESTED"
        ? "RESCINDED"
        : "APPROVED"
    : isCancellationRequest
      ? "APPROVED"  // denying a cancellation/rescind request → keep the original approval
      : "DENIED";


    /* --------------------------------------------------
       ✅ 1️⃣ UPDATE PTO REQUEST (MUST AFFECT 1 ROW)
    -------------------------------------------------- */
    const { data: updatedRows, error: updateError } = await supabase
      .from("pto_requests")
      .update({
        status: newStatus,
        decided_at: new Date().toISOString(),
        decided_by: approverEmployeeId
      })
      .eq("id", requestId)
      .eq("status", ptoRequest.status)
      .select("id");

    if (updateError) {
      console.error("PTO update failed", updateError);
      return new Response("Failed to update PTO request", { status: 500 });
    }

    // ✅ CRITICAL: do NOT proceed if nothing was updated
    if (!updatedRows || updatedRows.length === 0) {
      return new Response(
        "This PTO request was already processed.",
        { status: 409 }
      );
    }

    // The DB trigger handle_pto_status_change() writes ledger entries for all
    // status transitions (APPROVED debit, CANCELLED/RESCINDED credit). No manual
    // ledger write needed here.

return new Response(null, {
  status: 302,
  headers: {
    Location: `${APP_URL}/pto-decision.html?status=${newStatus}`
  }
});


  } catch (err) {
    console.error(err);
    return new Response("Internal server error", { status: 500 });
  }
});
