import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import ExcelJS from "https://esm.sh/exceljs@4.4.0";


console.log("ENV CHECK", {
  hasUrl: Boolean(Deno.env.get("SUPABASE_URL")),
  hasAnon: Boolean(Deno.env.get("SUPABASE_ANON_KEY")),
  hasServiceRole: Boolean(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")),
});

/* =====================================================
   CORS
===================================================== */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    const { report_type, start_date, end_date } = await req.json();

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const workbook = new ExcelJS.Workbook();

    /* =====================================================
   AUTH + PERMISSION CHECK (can_review_pto)
===================================================== */

// 1️⃣ Get Authorization header (added automatically by invoke())
const authHeader = req.headers.get("authorization");
if (!authHeader) {
  return new Response(
    JSON.stringify({ error: "Unauthorized" }),
    { status: 401, headers: corsHeaders }
  );
}

// 2️⃣ Auth client using anon key + caller JWT
const authClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_ANON_KEY")!,
  {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  }
);

// 3️⃣ Resolve current user
const {
  data: { user },
  error: authError,
} = await authClient.auth.getUser();

if (authError || !user) {
  return new Response(
    JSON.stringify({ error: "Unauthorized" }),
    { status: 401, headers: corsHeaders }
  );
}

// 4️⃣ Load profile with service role

const { data: profile, error: profileError } = await admin
  .from("profiles")
  .select("school_id, can_generate_pto_reports")
  .eq("user_id", user.id)
  .single();


// 5️⃣ Enforce permission
if (profileError || !profile?.can_generate_pto_reports) {
  return new Response(
    JSON.stringify({ error: "Forbidden" }),
    { status: 403, headers: corsHeaders }
  );
}


/* =====================================================
   6️⃣ MODULE GUARD (PTO)
===================================================== */
const { data: moduleRow, error: moduleError } = await admin
  .from("school_modules")
  .select("enabled")
  .eq("school_id", profile.school_id)
  .eq("module", "pto")
  .single();

if (moduleError || !moduleRow?.enabled) {
  return new Response(
    JSON.stringify({ error: "PTO module not enabled for this school" }),
    { status: 403, headers: corsHeaders }
  );
}



    /* =====================================================
       PTO BALANCES REPORT
    ===================================================== */
    if (report_type === "balances") {
      const { data, error } = await admin
        .from("employees")
        .select(`
          first_name,
          last_name,
          pto_balances (
            pto_type,
            balance_hours
          )
        `)
        .eq("active", true)
        .eq("school_id", profile.school_id)
        .order("last_name");

      if (error) throw error;

      const sheet = workbook.addWorksheet("PTO Balances", {
        views: [{ state: "frozen", ySplit: 1 }],
      });

      sheet.columns = [
        { header: "Employee", key: "employee", width: 28 },
        { header: "PTO Type", key: "type", width: 16 },
        { header: "Balance", key: "balance", width: 14 },
      ];

      sheet.getRow(1).font = { bold: true };

      data.forEach(emp => {
        emp.pto_balances.forEach(b => {
          sheet.addRow({
            employee: `${emp.first_name} ${emp.last_name}`,
            type: b.pto_type,
            balance: Number(b.balance_hours || 0),
          });
        });
      });

      sheet.getColumn("balance").numFmt = "0.00";
    }

    /* =====================================================
       PTO TRANSACTIONS REPORT
    ===================================================== */
    else if (report_type === "transactions") {
      if (!start_date || !end_date) {
        throw new Error("Missing date range");
      }

      const { data, error } = await admin
        .from("pto_ledger")
        .select(`
          pto_type,
          delta_hours,
          reason,
          created_at,
          employees (
            first_name,
            last_name
          )
        `)
        .eq("school_id", profile.school_id)
        .gte("created_at", start_date)
        .lte("created_at", end_date)
        .order("created_at");

      if (error) throw error;

      const sheet = workbook.addWorksheet("PTO Transactions", {
        views: [{ state: "frozen", ySplit: 1 }],
      });

      sheet.columns = [
        { header: "Employee", key: "employee", width: 28 },
        { header: "PTO Type", key: "type", width: 14 },
        { header: "Event Type", key: "event", width: 20 },
        { header: "Hours (+/-)", key: "hours", width: 14 },
        { header: "Date", key: "date", width: 14 },
      ];

      sheet.getRow(1).font = { bold: true };

      data.forEach(r => {
        sheet.addRow({
          employee: `${r.employees.first_name} ${r.employees.last_name}`,
          type: r.pto_type,
          event: r.reason,
          hours: r.delta_hours,
          date: r.created_at.slice(0, 10),
        });
      });

      sheet.getColumn("hours").numFmt = "0.00";
    }

    /* =====================================================
       PAYROLL PTO USAGE REPORT
    ===================================================== */
    else if (report_type === "payroll") {
      if (!start_date || !end_date) {
        throw new Error("Missing date range");
      }

      const { data, error } = await admin
        .from("pto_ledger")
        .select(`
          employee_id,
          pto_type,
          delta_hours,
          employees (
            first_name,
            last_name
          )
        `)
        .eq("reason", "REQUEST_APPROVED")
        .eq("school_id", profile.school_id)
        .gte("created_at", start_date)
        .lte("created_at", end_date);

      if (error) throw error;

      const usageMap: Record<string, any> = {};

      data.forEach(r => {
        if (r.delta_hours >= 0) return;

        const key = `${r.employee_id}_${r.pto_type}`;
        if (!usageMap[key]) {
          usageMap[key] = {
            employee: `${r.employees.first_name} ${r.employees.last_name}`,
            type: r.pto_type,
            hours: 0,
          };
        }
        usageMap[key].hours += Math.abs(r.delta_hours);
      });

      const sheet = workbook.addWorksheet("Payroll PTO Usage", {
        views: [{ state: "frozen", ySplit: 1 }],
      });

      sheet.columns = [
        { header: "Employee", key: "employee", width: 28 },
        { header: "PTO Type", key: "type", width: 14 },
        { header: "Hours Used", key: "hours", width: 14 },
        { header: "Period Start", key: "start", width: 14 },
        { header: "Period End", key: "end", width: 14 },
      ];

      sheet.getRow(1).font = { bold: true };

      Object.values(usageMap).forEach(r => {
        sheet.addRow({
          employee: r.employee,
          type: r.type,
          hours: r.hours,
          start: start_date,
          end: end_date,
        });
      });

      sheet.getColumn("hours").numFmt = "0.00";
    }

    else {
      throw new Error("Invalid report_type");
    }

    /* =====================================================
       RETURN EXCEL (BASE64)
    ===================================================== */
    const buffer = await workbook.xlsx.writeBuffer();
   
// ✅ Deno-compatible Base64 encoding
const uint8 = new Uint8Array(buffer);
const base64 = btoa(
  Array.from(uint8, byte => String.fromCharCode(byte)).join("")
);

return new Response(
  JSON.stringify({
    filename: `PTO_${report_type}.xlsx`,
    file: base64,
  }),
  {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  }
);


  } catch (err: any) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
});
