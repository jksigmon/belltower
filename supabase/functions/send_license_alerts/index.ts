import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
if (!RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const FROM_ADDRESS = "Belltower Compliance <compliance@belltower.school>";

/* ─────────────────────────────────────────────────────
   ENTRY POINT
   Can be triggered by:
   - Supabase scheduled function (cron)
   - Manual POST to /functions/v1/send_license_alerts
     with optional body: { school_id: "..." } to run for one school
───────────────────────────────────────────────────── */
serve(async (req) => {
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const targetSchoolId: string | null = body.school_id ?? null;

    // Load all schools with licensure module enabled
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

  // Thresholds: days remaining → alert_type
  const thresholds = [
    { days: 7,  type: "7_day"   },
    { days: 30, type: "30_day"  },
    { days: 60, type: "60_day"  },
    { days: 90, type: "90_day"  },
  ];

  // Load active licenses with upcoming expirations (not already expired, not muted)
  const windowDate = offsetDate(today, 91);
  const { data: licenses, error: licErr } = await supabase
    .from("staff_licenses")
    .select(`
      id, employee_id, license_type, license_area, grade_authorization,
      expiration_date, status, alert_muted, license_number
    `)
    .eq("school_id", schoolId)
    .eq("alert_muted", false)
    .lte("expiration_date", windowDate)
    .gte("expiration_date", todayStr)
    .neq("status", "revoked");

  if (licErr) { console.error(licErr); return { error: licErr.message }; }
  if (!licenses?.length) return { alertsSent: 0 };

  // Load already-sent alerts today (to avoid duplicates)
  const { data: sentToday } = await supabase
    .from("license_alert_log")
    .select("license_id, alert_type")
    .eq("school_id", schoolId)
    .gte("sent_at", todayStr);

  const alreadySent = new Set(
    (sentToday ?? []).map((r: { license_id: string; alert_type: string }) =>
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

  // Load admin emails (can_manage_licensure)
  const { data: admins } = await supabase
    .from("profiles")
    .select("email, display_name")
    .eq("school_id", schoolId)
    .eq("can_manage_licensure", true)
    .eq("status", "active");

  const adminEmails = (admins ?? []).map((a: { email: string }) => a.email).filter(Boolean);

  let alertsSent = 0;
  const adminDigestItems: DigestItem[] = [];

  for (const lic of licenses as License[]) {
    const daysLeft = daysBetween(todayStr, lic.expiration_date);
    const emp = empMap[lic.employee_id];
    if (!emp?.email) continue;

    // Determine which threshold this license hits (smallest applicable)
    for (const { days, type } of thresholds) {
      if (daysLeft > days) continue;

      const key = `${lic.id}::${type}`;
      if (alreadySent.has(key)) continue;

      // Send to employee
      await sendEmail({
        to: emp.email,
        subject: `License Expiring in ${daysLeft} Day${daysLeft === 1 ? "" : "s"} — Action Required`,
        html: staffAlertEmail({
          name: emp.first_name,
          licenseType: lic.license_type,
          licenseArea: lic.license_area,
          expDate: formatDate(lic.expiration_date),
          daysLeft,
        }),
      });

      // Log the alert
      await supabase.from("license_alert_log").insert({
        school_id:   schoolId,
        license_id:  lic.id,
        employee_id: lic.employee_id,
        alert_type:  type,
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
      break; // only fire the most urgent threshold per license
    }
  }

  // Send admin digest if there's anything to report
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
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: toArr,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("Resend error:", err);
  }
}

/* ─────────────────────────────────────────────────────
   EMAIL TEMPLATES
───────────────────────────────────────────────────── */
function staffAlertEmail({ name, licenseType, licenseArea, expDate, daysLeft }: {
  name: string; licenseType: string; licenseArea: string | null;
  expDate: string; daysLeft: number;
}) {
  const urgencyColor = daysLeft <= 7 ? "#dc2626" : daysLeft <= 30 ? "#ea580c" : "#f59e0b";
  const areaLine = licenseArea ? ` (${licenseArea})` : "";
  return `
    <div style="font-family:system-ui,sans-serif;max-width:540px;margin:0 auto;">
      <div style="background:#0b2d4f;padding:20px 24px;border-radius:10px 10px 0 0;">
        <p style="color:#f59e0b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 4px;">Belltower</p>
        <p style="color:#fff;font-size:18px;font-weight:700;margin:0;">License Expiration Notice</p>
      </div>
      <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:24px;">
        <p>Hi ${name},</p>
        <p>Your <strong>${licenseType}${areaLine}</strong> license expires on <strong>${expDate}</strong>.</p>
        <div style="background:#fef9c3;border-left:4px solid ${urgencyColor};padding:12px 16px;border-radius:6px;margin:16px 0;">
          <strong style="color:${urgencyColor};">${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining</strong>
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
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:${i.daysLeft <= 30 ? "#dc2626" : "#ea580c"};font-weight:600;">${i.daysLeft}d</td>
    </tr>`).join("");

  return `
    <div style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;">
      <div style="background:#0b2d4f;padding:20px 24px;border-radius:10px 10px 0 0;">
        <p style="color:#f59e0b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 4px;">Belltower</p>
        <p style="color:#fff;font-size:18px;font-weight:700;margin:0;">Licensure Compliance Digest</p>
      </div>
      <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:24px;">
        <p>The following staff licenses are expiring soon and require attention:</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <thead>
            <tr style="background:#f9fafb;">
              <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;">Staff</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;">License</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;">Expires</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;">Days Left</th>
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
  grade_authorization: string | null;
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
