import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// Public, unauthenticated endpoint for the marketing site's "Request a
// Demo" / "Get in Touch" modal — sends the lead straight to Justin's
// inbox via Resend instead of relying on the visitor's own mail client
// (mailto: links require a configured desktop mail app and only draft
// the message; they don't actually send anything on their own).

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
if (!RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY");

const FROM_ADDRESS = "Belltower <notifications@belltower.school>";
const TO_ADDRESS   = "justin@sigmondigitallabs.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    const requestType = typeof body.requestType === "string" ? body.requestType.trim() : "";
    const name         = typeof body.name === "string" ? body.name.trim() : "";
    const email        = typeof body.email === "string" ? body.email.trim() : "";
    const message      = typeof body.message === "string" ? body.message.trim() : "";

    if (!name) return json({ error: "Name is required." }, 400);
    if (!email || !email.includes("@")) return json({ error: "A valid email is required." }, 400);

    const subject = `Belltower — ${requestType || "Website inquiry"} from ${name}`;
    const html = `
      <div style="font-family:sans-serif;font-size:14px;color:#111;line-height:1.6;">
        <p><strong>Request Type:</strong> ${esc(requestType || "—")}</p>
        <p><strong>Name:</strong> ${esc(name)}</p>
        <p><strong>Email:</strong> ${esc(email)}</p>
        ${message ? `<p><strong>Message:</strong><br>${esc(message).replace(/\n/g, "<br>")}</p>` : ""}
      </div>
    `;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [TO_ADDRESS],
        reply_to: email,
        subject,
        html,
      }),
    });

    if (!res.ok) {
      console.error("Resend error:", await res.text());
      return json({ error: "Failed to send. Please try again." }, 502);
    }

    return json({ success: true });
  } catch (err) {
    console.error("marketing_lead_submit error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
