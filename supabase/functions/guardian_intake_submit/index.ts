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

// ── Normalize phone to digits only ───────────────────────────
function normalizePhone(p: string): string {
  return p.replace(/\D/g, "");
}

// ── Simple Levenshtein for fuzzy name matching ────────────────
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ── Match submission against existing guardians ───────────────
interface Guardian {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
}

interface Candidate {
  guardian_id: string;
  score: number;
  reasons: string[];
}

function computeMatch(
  guardians: Guardian[],
  sub: { first_name: string; last_name: string; email?: string; phone_cell?: string }
): { confidence: "high" | "medium" | "none"; candidates: Candidate[] } {
  if (!guardians.length) return { confidence: "none", candidates: [] };

  const scored: Candidate[] = guardians
    .map((g) => {
      let score = 0;
      const reasons: string[] = [];

      if (sub.email && g.email) {
        if (sub.email.toLowerCase().trim() === g.email.toLowerCase().trim()) {
          score = Math.max(score, 100);
          reasons.push("email_exact");
        }
      }

      if (sub.phone_cell && g.phone) {
        const subPhone = normalizePhone(sub.phone_cell);
        const gPhone   = normalizePhone(g.phone);
        if (subPhone.length >= 7 && subPhone === gPhone) {
          score = Math.max(score, 90);
          reasons.push("phone_match");
        }
      }

      const subFirst = (sub.first_name ?? "").toLowerCase().trim();
      const subLast  = (sub.last_name  ?? "").toLowerCase().trim();
      const gFirst   = (g.first_name   ?? "").toLowerCase().trim();
      const gLast    = (g.last_name    ?? "").toLowerCase().trim();

      if (subFirst && subLast && gFirst && gLast) {
        const subFull = `${subFirst} ${subLast}`;
        const gFull   = `${gFirst} ${gLast}`;
        if (subFull === gFull) {
          score = Math.max(score, 70);
          reasons.push("name_exact");
        } else if (levenshtein(subFull, gFull) === 1) {
          score = Math.max(score, 50);
          reasons.push("name_fuzzy");
        }
      }

      return { guardian_id: g.id, score, reasons };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const confidence = !top
    ? "none"
    : top.score >= 85
    ? "high"
    : top.score >= 45
    ? "medium"
    : "none";

  return { confidence, candidates: scored.slice(0, 3) };
}

// ── Main handler ──────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const {
      token,
      first_name,
      last_name,
      email,
      phone_cell,
      relationship,
      ok_to_text,
      students,
    } = body;

    // ── Validate required fields ──────────────────────────────
    if (!token || typeof token !== "string") {
      return json({ error: "Invalid token." }, 400);
    }
    if (!first_name?.trim()) return json({ error: "First name is required." }, 400);
    if (!last_name?.trim())  return json({ error: "Last name is required." }, 400);
    if (email && !email.includes("@")) return json({ error: "Enter a valid email address." }, 400);

    // ── Re-validate campaign token ────────────────────────────
    const { data: campaign, error: campErr } = await supabase
      .from("guardian_intake_campaigns")
      .select("id, school_id, status")
      .eq("token", token)
      .single();

    if (campErr || !campaign) return json({ error: "Form not found." }, 404);
    if (campaign.status !== "active") {
      return json({ error: "This form is no longer accepting submissions." }, 410);
    }

    // ── Load guardians for matching ───────────────────────────
    const { data: guardians } = await supabase
      .from("guardians")
      .select("id, first_name, last_name, phone, email")
      .eq("school_id", campaign.school_id)
      .eq("active", true);

    const { confidence, candidates } = computeMatch(guardians ?? [], {
      first_name: first_name.trim(),
      last_name:  last_name.trim(),
      email:      email?.trim().toLowerCase(),
      phone_cell: phone_cell?.trim(),
    });

    // ── Insert submission ─────────────────────────────────────
    const { error: insertErr } = await supabase
      .from("guardian_intake_submissions")
      .insert({
        campaign_id:      campaign.id,
        school_id:        campaign.school_id,
        first_name:       first_name.trim(),
        last_name:        last_name.trim(),
        email:            email?.trim().toLowerCase() || null,
        phone_cell:       phone_cell?.trim() || null,
        relationship:     relationship?.trim() || null,
        ok_to_text:       ok_to_text === true,
        students:         Array.isArray(students) ? students : [],
        match_confidence: confidence,
        match_candidates: candidates,
      });

    if (insertErr) {
      console.error("guardian_intake_submit insert error:", insertErr);
      return json({ error: "Failed to save submission. Please try again." }, 500);
    }

    return json({ success: true });

  } catch (err) {
    console.error("guardian_intake_submit error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
