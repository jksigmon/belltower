import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
if (!RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const FROM_ADDRESS = "Belltower <notifications@belltower.school>";

/* ─────────────────────────────────────────────────────
   ENTRY POINT
   Triggered by:
   - Supabase cron (daily at 8am ET)
   - Manual POST with optional body: { school_id: "..." }
───────────────────────────────────────────────────── */
serve(async (req) => {
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const targetSchoolId: string | null = body.school_id ?? null;

    let schoolQuery = supabase
      .from("school_modules")
      .select("school_id")
      .eq("module", "licensure")
      .eq("enabled", true);

    if (targetSchoolId) schoolQuery = schoolQuery.eq("school_id", targetSchoolId);

    const { data: schoolModules, error: smErr } = await schoolQuery;
    if (smErr) throw smErr;
    if (!schoolModules?.length) {
      return new Response(JSON.stringify({ message: "No schools with licensure enabled." }), { status: 200 });
    }

    const today = new Date();
    const results: Record<string, unknown>[] = [];

    for (const { school_id } of schoolModules) {
      const schoolResult = await processSchool(school_id, today);
      results.push({ school_id, ...schoolResult });
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("send_license_alerts error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

/* ─────────────────────────────────────────────────────
   PER-SCHOOL PROCESSING
───────────────────────────────────────────────────── */
async function processSchool(schoolId: string, today: Date) {
  const todayStr = today.toISOString().slice(0, 10);
  const day90    = offsetDate(today, 90);

  // Load licenses expiring within 90 days OR already expired, not muted, not revoked/suspended
  const { data: licenses, error: licErr } = await supabase
    .from("staff_licenses")
    .select(`id, employee_id, license_type, license_area, expiration_date, status, alert_muted, license_number`)
    .eq("school_id", schoolId)
    .eq("alert_muted", false)
    .lte("expiration_date", day90)        // within 90-day window OR already expired
    .neq("status", "revoked")
    .neq("status", "suspended");

  if (licErr) { console.error(licErr); return { error: licErr.message }; }
  if (!licenses?.length) return { alertsSent: 0 };

  // Load ALL previously sent alert log entries for this school.
  // We check all-time (not just today) so each threshold fires only once per
  // expiration cycle. Alert log entries are cleared on the JS side when
  // expiration_date changes (license renewal).
  const { data: sentAlerts } = await supabase
    .from("license_alert_log")
    .select("license_id, alert_type")
    .eq("school_id", schoolId);

  const alreadySent = new Set(
    (sentAlerts ?? []).map((r: { license_id: string; alert_type: string }) =>
      `${r.license_id}::${r.alert_type}`
    )
  );

  // Load employee emails
  const empIds = [...new Set(licenses.map((l: License) => l.employee_id))];
  const { data: employees } = await supabase
    .from("employees")
    .select("id, first_name, last_name, email")
    .in("id", empIds);

  const empMap: Record<string, Employee> = {};
  (employees ?? []).forEach((e: Employee) => { empMap[e.id] = e; });

  // Load licensure admin emails (for digest)
  const { data: admins } = await supabase
    .from("profiles")
    .select("email")
    .eq("school_id", schoolId)
    .eq("can_manage_licensure", true)
    .eq("status", "active");

  const adminEmails = (admins ?? []).map((a: { email: string }) => a.email).filter(Boolean);

  let alertsSent = 0;
  const adminDigestItems: DigestItem[] = [];

  for (const lic of licenses as License[]) {
    const daysLeft  = daysBetween(todayStr, lic.expiration_date);
    const alertType = getAlertType(daysLeft);
    if (!alertType) continue;

    const emp = empMap[lic.employee_id];
    if (!emp?.email) continue;

    const key = `${lic.id}::${alertType}`;
    if (alreadySent.has(key)) continue; // already sent this threshold for this license

    const subject = daysLeft < 0
      ? `License Expired — Renewal Required`
      : `License Expiring in ${daysLeft} Day${daysLeft === 1 ? "" : "s"} — Action Required`;

    await sendEmail({
      to: emp.email,
      subject,
      html: staffAlertEmail({
        name:        emp.first_name,
        licenseType: lic.license_type,
        licenseArea: lic.license_area,
        expDate:     formatDate(lic.expiration_date),
        daysLeft,
      }),
    });

    await supabase.from("license_alert_log").insert({
      school_id:   schoolId,
      license_id:  lic.id,
      employee_id: lic.employee_id,
      alert_type:  alertType,
    });

    adminDigestItems.push({
      name:    `${emp.first_name} ${emp.last_name}`,
      type:    lic.license_type,
      area:    lic.license_area,
      expDate: lic.expiration_date,
      daysLeft,
    });

    alreadySent.add(key);
    alertsSent++;
  }

  // Send admin digest if anything went out
  if (adminDigestItems.length && adminEmails.length) {
    await sendEmail({
      to: adminEmails,
      subject: `Licensure Alert: ${adminDigestItems.length} License${adminDigestItems.length === 1 ? "" : "s"} Expiring Soon`,
      html: adminDigestEmail(adminDigestItems),
    });
  }

  return { alertsSent };
}

/* ─────────────────────────────────────────────────────
   ALERT TYPE RESOLUTION
   Returns the single alert_type for today's days-remaining value.
   Each license fires exactly one threshold per expiration cycle.
───────────────────────────────────────────────────── */
function getAlertType(daysLeft: number): string | null {
  if (daysLeft < 0)   return "expired";
  if (daysLeft <= 30) return "expiring_30";
  if (daysLeft <= 60) return "expiring_60";
  if (daysLeft <= 90) return "expiring_90";
  return null; // more than 90 days out — no alert yet
}

/* ─────────────────────────────────────────────────────
   EMAIL SENDING
───────────────────────────────────────────────────── */
async function sendEmail({ to, subject, html }: { to: string | string[]; subject: string; html: string }) {
  const toArr = Array.isArray(to) ? to : [to];
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: toArr, subject, html }),
  });
  if (!res.ok) console.error("Resend error:", await res.text());
}

/* ─────────────────────────────────────────────────────
   EMAIL TEMPLATES
───────────────────────────────────────────────────── */
function staffAlertEmail({ name, licenseType, licenseArea, expDate, daysLeft }: {
  name: string; licenseType: string; licenseArea: string | null;
  expDate: string; daysLeft: number;
}) {
  const urgencyColor = daysLeft < 0 ? "#dc2626" : daysLeft <= 30 ? "#ea580c" : "#f59e0b";
  const areaLine     = licenseArea ? ` (${licenseArea})` : "";
  const urgencyLabel = daysLeft < 0
    ? `${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? "" : "s"} overdue`
    : `${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining`;

  return `
    <div style="font-family:system-ui,sans-serif;max-width:540px;margin:0 auto;">
      <div style="background:#0b2d4f;padding:20px 24px;border-radius:10px 10px 0 0;">
        <p style="color:#f59e0b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 4px;">Belltower</p>
        <p style="color:#fff;font-size:18px;font-weight:700;margin:0;">${daysLeft < 0 ? "License Expired" : "License Expiration Notice"}</p>
      </div>
      <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:24px;">
        <p>Hi ${name},</p>
        <p>${daysLeft < 0
          ? `Your <strong>${licenseType}${areaLine}</strong> license expired on <strong>${expDate}</strong> and requires immediate renewal.`
          : `Your <strong>${licenseType}${areaLine}</strong> license expires on <strong>${expDate}</strong>.`
        }</p>
        <div style="background:#fef9c3;border-left:4px solid ${urgencyColor};padding:12px 16px;border-radius:6px;margin:16px 0;">
          <strong style="color:${urgencyColor};">${urgencyLabel}</strong>
        </div>
        <p>Please contact your administrator or visit the <a href="https://nclicensure.ncpublicschools.gov" style="color:#0b2d4f;">NC DPI Licensure portal</a> to begin your renewal.</p>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px;">This is an automated message from Belltower. Contact your school administrator with questions.</p>
      </div>
    </div>`;
}

function adminDigestEmail(items: DigestItem[]) {
  const rows = items.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${i.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${i.type}${i.area ? " — " + i.area : ""}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${formatDate(i.expDate)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:${i.daysLeft < 0 ? "#dc2626" : i.daysLeft <= 30 ? "#ea580c" : "#f59e0b"};font-weight:600;">
        ${i.daysLeft < 0 ? Math.abs(i.daysLeft) + "d overdue" : i.daysLeft + "d left"}
      </td>
    </tr>`).join("");

  return `
    <div style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;">
      <div style="background:#0b2d4f;padding:20px 24px;border-radius:10px 10px 0 0;">
        <p style="color:#f59e0b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 4px;">Belltower</p>
        <p style="color:#fff;font-size:18px;font-weight:700;margin:0;">Licensure Compliance Digest</p>
      </div>
      <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:24px;">
        <p>The following staff licenses require attention:</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <thead>
            <tr style="background:#f9fafb;">
              <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;">Staff</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;">License</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;">Expires</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;">Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:20px;">
          <a href="https://belltower.school/app/licensure.html" style="background:#0b2d4f;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">View Licensure Dashboard</a>
        </p>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px;">This is an automated compliance digest from Belltower.</p>
      </div>
    </div>`;
}

/* ─────────────────────────────────────────────────────
   UTILS
───────────────────────────────────────────────────── */
function offsetDate(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000);
}

function formatDate(d: string): string {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}

/* ─────────────────────────────────────────────────────
   TYPES
───────────────────────────────────────────────────── */
interface License {
  id: string;
  employee_id: string;
  license_type: string;
  license_area: string | null;
  expiration_date: string;
  status: string;
  alert_muted: boolean;
  license_number: string | null;
}

interface Employee {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
}

interface DigestItem {
  name: string;
  type: string;
  area: string | null;
  expDate: string;
  daysLeft: number;
}
