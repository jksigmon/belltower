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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { token } = await req.json();

    if (!token || typeof token !== "string") {
      return json({ error: "Invalid token" }, 400);
    }

    const { data: campaign, error } = await supabase
      .from("guardian_intake_campaigns")
      .select(`
        id, name, status,
        schools!inner ( name, logo_url )
      `)
      .eq("token", token)
      .single();

    if (error || !campaign) {
      return json({ error: "Form not found." }, 404);
    }

    if (campaign.status !== "active") {
      return json({ error: "This form is no longer accepting submissions." }, 410);
    }

    const school = campaign.schools as Record<string, unknown>;

    return json({
      campaign_id:   campaign.id,
      campaign_name: campaign.name,
      school_name:   school.name,
      school_logo:   school.logo_url ?? null,
    });

  } catch (err) {
    console.error("guardian_intake_lookup error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
