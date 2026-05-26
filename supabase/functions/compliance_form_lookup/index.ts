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
    const { token } = await req.json();

    if (!token || typeof token !== "string" || token.length !== 32) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Load form link + template + school in one query
    const { data: link, error: linkErr } = await supabase
      .from("compliance_form_links")
      .select(`
        id,
        token,
        label,
        expires_at,
        active,
        template_id,
        compliance_form_templates!inner (
          id,
          title,
          description,
          body_html,
          content_hash,
          active,
          require_signature,
          school_id,
          schools!inner (
            id,
            name,
            logo_url
          )
        )
      `)
      .eq("token", token)
      .single();

    if (linkErr || !link) {
      return new Response(
        JSON.stringify({ error: "Form not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const template = link.compliance_form_templates as Record<string, unknown>;
    const school   = template.schools as Record<string, unknown>;

    // Validate link and template are active
    if (!link.active || !template.active) {
      return new Response(
        JSON.stringify({ error: "This form link is no longer active." }),
        { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check expiry
    if (link.expires_at) {
      const today = new Date().toISOString().slice(0, 10);
      if (link.expires_at < today) {
        return new Response(
          JSON.stringify({ error: "This form link has expired." }),
          { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    return new Response(
      JSON.stringify({
        form_link_id:  link.id,
        template_id:   link.template_id,
        label:         link.label,
        expires_at:    link.expires_at,
        school_id:     school.id,
        school_name:   school.name,
        school_logo:   school.logo_url ?? null,
        form_title:    template.title,
        form_desc:     template.description ?? null,
        body_html:         template.body_html,
        content_hash:      template.content_hash ?? null,
        require_signature: template.require_signature ?? true,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("compliance_form_lookup error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
