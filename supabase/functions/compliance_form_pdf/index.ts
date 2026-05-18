import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseService = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Auth check ────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authErr } = await supabaseUser.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    // ── Parse request ─────────────────────────────────────────────────
    const { agreement_id } = await req.json();
    if (!agreement_id) return json({ error: "Missing agreement_id" }, 400);

    // ── Load agreement with template + school ─────────────────────────
    const { data: agreement, error: agErr } = await supabaseService
      .from("compliance_agreements")
      .select(`
        id, signer_name, signer_email, signature_type, signature_data,
        signed_at, content_hash, expires_at, voided_at,
        compliance_form_templates!inner (
          id, title, description, body_html, school_id,
          schools!inner ( id, name, logo_url )
        )
      `)
      .eq("id", agreement_id)
      .single();

    if (agErr || !agreement) return json({ error: "Agreement not found" }, 404);

    const template = agreement.compliance_form_templates as Record<string, unknown>;
    const school   = template.schools as Record<string, unknown>;

    // Permission check: caller must have can_manage_compliance for this school
    const { data: profile } = await supabaseService
      .from("profiles")
      .select("can_manage_compliance, is_superadmin")
      .eq("user_id", user.id)
      .eq("school_id", school.id as string)
      .single();

    if (!profile || (!profile.can_manage_compliance && !profile.is_superadmin)) {
      return json({ error: "Forbidden" }, 403);
    }

    // ── Build PDF ─────────────────────────────────────────────────────
    const pdfDoc  = await PDFDocument.create();
    const page    = pdfDoc.addPage([612, 792]); // US Letter
    const { width, height } = page.getSize();

    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const margin    = 56;
    const colWidth  = width - margin * 2;
    let   y         = height - margin;

    // Helper: draw wrapped text, returns final y
    function drawWrapped(
      text: string,
      { x = margin, maxY = y, font = fontRegular, size = 11, lineH = 16, color = rgb(0.1, 0.1, 0.1), maxWidth = colWidth } = {}
    ): number {
      const words  = text.replace(/\n/g, " \n ").split(" ");
      let   line   = "";
      let   cursor = maxY;

      for (const word of words) {
        if (word === "\n") {
          if (line.trim()) {
            page.drawText(line.trim(), { x, y: cursor, size, font, color });
            cursor -= lineH;
          }
          cursor -= lineH * 0.4;
          line = "";
          continue;
        }
        const test = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(test, size) > maxWidth) {
          if (line.trim()) page.drawText(line.trim(), { x, y: cursor, size, font, color });
          cursor -= lineH;
          line = word;
        } else {
          line = test;
        }
      }
      if (line.trim()) {
        page.drawText(line.trim(), { x, y: cursor, size, font, color });
        cursor -= lineH;
      }
      return cursor;
    }

    // ── School header: logo + name side-by-side ──────────────────────
    const logoUrl = school.logo_url as string | null;
    let headerHeight = 0;

    if (logoUrl) {
      try {
        const logoRes = await fetch(logoUrl);
        if (logoRes.ok) {
          const logoBytes = new Uint8Array(await logoRes.arrayBuffer());
          const ct = logoRes.headers.get("content-type") ?? "";
          const logoImg = ct.includes("png")
            ? await pdfDoc.embedPng(logoBytes)
            : await pdfDoc.embedJpg(logoBytes);
          const dims = logoImg.scaleToFit(64, 64);
          const logoY = y - dims.height;
          page.drawImage(logoImg, { x: margin, y: logoY, width: dims.width, height: dims.height });
          // School name centered vertically beside the logo
          const nameX = margin + dims.width + 14;
          const nameY = logoY + dims.height / 2 - 7;
          page.drawText(String(school.name ?? ""), { x: nameX, y: nameY, size: 18, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
          headerHeight = dims.height;
        }
      } catch { /* logo load failed — fall through to text-only header */ }
    }

    if (!headerHeight) {
      page.drawText(String(school.name ?? ""), { x: margin, y, size: 18, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
      headerHeight = 18;
    }

    y -= headerHeight + 20;

    // ── Divider ───────────────────────────────────────────────────────
    page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
    y -= 20;

    // ── Form title ────────────────────────────────────────────────────
    page.drawText(String(template.title ?? "Agreement"), { x: margin, y, size: 16, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
    y -= 24;

    if (template.description) {
      y = drawWrapped(String(template.description), { font: fontRegular, size: 10, lineH: 14, color: rgb(0.4, 0.4, 0.4) });
      y -= 8;
    }

    // ── Body content (strip HTML tags) ───────────────────────────────
    const bodyText = stripHtml(String(template.body_html ?? ""));
    if (bodyText.trim()) {
      y = drawWrapped(bodyText, { font: fontRegular, size: 10, lineH: 15 });
      y -= 16;
    }

    // ── Divider ───────────────────────────────────────────────────────
    page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
    y -= 20;

    // ── Signer info ───────────────────────────────────────────────────
    page.drawText("Signature Record", { x: margin, y, size: 13, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
    y -= 20;

    const signedDate = new Date(agreement.signed_at as string).toLocaleString("en-US", {
      month: "long", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });

    const fields = [
      ["Signer",      agreement.signer_name as string],
      ["Email",       agreement.signer_email as string],
      ["Signed",      signedDate],
      ["Sig. method", agreement.signature_type === "typed" ? "Typed (cursive render)" : "Hand-drawn"],
    ];
    if (agreement.expires_at) {
      fields.push(["Expires", agreement.expires_at as string]);
    }
    if (agreement.voided_at) {
      fields.push(["VOIDED", new Date(agreement.voided_at as string).toLocaleString("en-US")]);
    }

    for (const [label, value] of fields) {
      page.drawText(`${label}:`, { x: margin, y, size: 10, font: fontBold, color: rgb(0.3, 0.3, 0.3) });
      page.drawText(value, { x: margin + 90, y, size: 10, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });
      y -= 16;
    }

    y -= 12;

    // ── Signature image ───────────────────────────────────────────────
    try {
      const sigData  = agreement.signature_data as string;
      const base64   = sigData.replace(/^data:image\/png;base64,/, "");
      const sigBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const sigImg   = await pdfDoc.embedPng(sigBytes);
      const sigDims  = sigImg.scaleToFit(240, 80);

      page.drawText("Signature:", { x: margin, y, size: 10, font: fontBold, color: rgb(0.3, 0.3, 0.3) });
      y -= 8;
      page.drawRectangle({ x: margin, y: y - sigDims.height, width: sigDims.width, height: sigDims.height, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 1 });
      page.drawImage(sigImg, { x: margin, y: y - sigDims.height, width: sigDims.width, height: sigDims.height });
      y -= sigDims.height + 20;
    } catch (e) {
      page.drawText("[Signature image unavailable]", { x: margin, y, size: 10, font: fontRegular, color: rgb(0.6, 0.6, 0.6) });
      y -= 16;
    }

    // ── Footer (content hash + audit note) ───────────────────────────
    const footerY = margin;
    page.drawLine({ start: { x: margin, y: footerY + 24 }, end: { x: width - margin, y: footerY + 24 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
    page.drawText(`Document hash: ${agreement.content_hash ?? "n/a"}`, {
      x: margin, y: footerY + 10, size: 8, font: fontRegular, color: rgb(0.6, 0.6, 0.6)
    });
    page.drawText(`Agreement ID: ${agreement.id}`, {
      x: margin, y: footerY, size: 8, font: fontRegular, color: rgb(0.6, 0.6, 0.6)
    });

    // ── Serialize ─────────────────────────────────────────────────────
    const pdfBytes = await pdfDoc.save();

    const safeName = `${String(agreement.signer_name ?? "agreement").replace(/[^a-z0-9]/gi, "_")}_${(agreement.signed_at as string).slice(0, 10)}`;

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeName}.pdf"`,
      },
    });

  } catch (err) {
    console.error("compliance_form_pdf error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/?(h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
