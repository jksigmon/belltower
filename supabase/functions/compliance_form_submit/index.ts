import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      token,
      signer_name,
      signer_email,
      signature_type,
      signature_data,
      // Optional linking hints
      student_name_hint,
      carline_tag_hint,
      submitted_phone,
      submitted_relationship,
    } = await req.json();

    // ── Validate required inputs ──────────────────────────────────────
    if (!token || typeof token !== "string" || token.length !== 32) {
      return json({ error: "Invalid token" }, 400);
    }
    if (!signer_name?.trim()) {
      return json({ error: "Full legal name is required." }, 400);
    }
    if (!signer_email?.trim() || !signer_email.includes("@")) {
      return json({ error: "A valid email address is required." }, 400);
    }
    if (!["draw", "typed"].includes(signature_type)) {
      return json({ error: "Invalid signature type." }, 400);
    }
    if (!signature_data?.startsWith("data:image/png;base64,")) {
      return json({ error: "Invalid signature data." }, 400);
    }
    const estimatedBytes = Math.ceil(
      (signature_data.length - "data:image/png;base64,".length) * 0.75
    );
    if (estimatedBytes > 1_000_000) {
      return json({ error: "Signature image is too large (max 1 MB)." }, 400);
    }

    const emailNorm = signer_email.trim().toLowerCase();

    // ── Resolve form link ─────────────────────────────────────────────
    const { data: link, error: linkErr } = await supabase
      .from("compliance_form_links")
      .select(`
        id, active, expires_at, template_id,
        compliance_form_templates!inner (
          id, school_id, active, content_hash
        )
      `)
      .eq("token", token)
      .single();

    if (linkErr || !link) return json({ error: "Form not found." }, 404);

    const template = link.compliance_form_templates as Record<string, unknown>;

    if (!link.active || !template.active) {
      return json({ error: "This form is no longer active." }, 410);
    }

    if (link.expires_at) {
      const today = new Date().toISOString().slice(0, 10);
      if (link.expires_at < today) {
        return json({ error: "This form link has expired." }, 410);
      }
    }

    const schoolId    = template.school_id as string;
    const templateId  = link.template_id as string;
    const contentHash = template.content_hash as string | null;

    // ── Dedup check ───────────────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const { data: existing } = await supabase
      .from("compliance_agreements")
      .select("id, signer_name, expires_at, signed_at")
      .eq("school_id", schoolId)
      .eq("template_id", templateId)
      .eq("signer_email", emailNorm)
      .is("voided_at", null)
      .order("signed_at", { ascending: false })
      .limit(1);

    if (existing?.length) {
      const prior = existing[0];
      const isStillValid = !prior.expires_at || prior.expires_at >= today;
      if (isStillValid) {
        return json(
          {
            error: "duplicate",
            message: `A signed agreement already exists for ${prior.signer_name} at this email address.`,
            signed_at: prior.signed_at,
          },
          409
        );
      }
    }

    // ── Capture submitter IP + UA ─────────────────────────────────────
    const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0].trim()
      ?? req.headers.get("cf-connecting-ip")
      ?? null;
    const userAgent = req.headers.get("user-agent") ?? null;

    // ── Auto-link: resolve guardian/family by email ───────────────────
    let guardianId: string | null = null;
    let familyId:   string | null = null;
    let linkStatus  = "unresolved";

    const { data: guardian } = await supabase
      .from("guardians")
      .select("id, family_id")
      .eq("school_id", schoolId)
      .eq("email", emailNorm)
      .maybeSingle();

    if (guardian) {
      guardianId = guardian.id;
      familyId   = guardian.family_id;
      linkStatus = "auto_linked";
    } else if (carline_tag_hint?.trim()) {
      // Fallback: try to match family by car tag
      const { data: family } = await supabase
        .from("families")
        .select("id")
        .eq("school_id", schoolId)
        .eq("carline_tag_number", carline_tag_hint.trim())
        .maybeSingle();

      if (family) {
        familyId   = family.id;
        linkStatus = "unresolved"; // family found but no guardian match — needs manual link
      }
    }

    // ── Insert agreement ──────────────────────────────────────────────
    const { data: agreement, error: insertErr } = await supabase
      .from("compliance_agreements")
      .insert({
        school_id:              schoolId,
        template_id:            templateId,
        form_link_id:           link.id,
        signer_name:            signer_name.trim(),
        signer_email:           emailNorm,
        signature_type,
        signature_data,
        content_hash:           contentHash,
        ip_address:             ipAddress,
        user_agent:             userAgent,
        guardian_id:            guardianId,
        family_id:              familyId,
        link_status:            linkStatus,
        student_name_hint:      student_name_hint?.trim() || null,
        carline_tag_hint:       carline_tag_hint?.trim()  || null,
        submitted_phone:        submitted_phone?.trim()   || null,
        submitted_relationship: submitted_relationship    || null,
      })
      .select("id, signed_at")
      .single();

    if (insertErr) {
      console.error("compliance_form_submit insert error:", insertErr);
      return json({ error: "Failed to save your submission. Please try again." }, 500);
    }

    return json({
      success:      true,
      agreement_id: agreement.id,
      signed_at:    agreement.signed_at,
      link_status:  linkStatus,
    }, 200);

  } catch (err) {
    console.error("compliance_form_submit error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
