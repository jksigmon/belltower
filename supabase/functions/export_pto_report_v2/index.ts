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
    const { report_type, start_date, end_date, campus_id } = await req.json();

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
  .maybeSingle();


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
  .maybeSingle();

if (moduleError || !moduleRow?.enabled) {
  return new Response(
    JSON.stringify({ error: "PTO module not enabled for this school" }),
    { status: 403, headers: corsHeaders }
  );
}



    /* =====================================================
       CAMPUS FILTER — resolve to employee ID list
    ===================================================== */
    let campusEmployeeIds: string[] | null = null;
    if (campus_id) {
      const { data: campusEmps } = await admin
        .from("employees")
        .select("id")
        .eq("campus_id", campus_id)
        .eq("school_id", profile.school_id);
      campusEmployeeIds = (campusEmps || []).map((e: any) => e.id);
    }

    /* =====================================================
       PTO BALANCES REPORT
    ===================================================== */
    if (report_type === "balances") {
      const { data: settingsData } = await admin
        .from("school_settings")
        .select("workday_hours")
        .eq("school_id", profile.school_id)
        .maybeSingle();

      const workdayHours = Number(settingsData?.workday_hours ?? 8);

      let balancesQuery = admin
        .from("employees")
        .select(`
          first_name,
          last_name,
          employment_months,
          pto_balances (
            pto_type,
            balance_hours
          )
        `)
        .eq("active", true)
        .eq("school_id", profile.school_id)
        .order("last_name");
      if (campusEmployeeIds) balancesQuery = balancesQuery.in("id", campusEmployeeIds);
      const { data, error } = await balancesQuery;

      if (error) throw error;

      const sheet = workbook.addWorksheet("PTO Balances", {
        views: [{ state: "frozen", ySplit: 1 }],
      });

      sheet.columns = [
        { header: "Employee", key: "employee", width: 28 },
        { header: "Employment", key: "employment", width: 14 },
        { header: "PTO Type", key: "type", width: 16 },
        { header: "Balance (hrs)", key: "balance", width: 14 },
        { header: "Balance (days)", key: "days", width: 14 },
      ];

      sheet.getRow(1).font = { bold: true };

      data.forEach(emp => {
        emp.pto_balances.forEach(b => {
          const hours = Number(b.balance_hours || 0);
          sheet.addRow({
            employee: `${emp.last_name}, ${emp.first_name}`,
            employment: emp.employment_months ? `${emp.employment_months}-month` : "—",
            type: b.pto_type,
            balance: hours,
            days: Number((hours / workdayHours).toFixed(2)),
          });
        });
      });

      sheet.getColumn("balance").numFmt = "0.00";
      sheet.getColumn("days").numFmt = "0.00";
    }

    /* =====================================================
       PTO TRANSACTIONS REPORT
    ===================================================== */
    else if (report_type === "transactions") {
      if (!start_date || !end_date) {
        throw new Error("Missing date range");
      }

      let txQuery = admin
        .from("pto_ledger")
        .select(`
          pto_type,
          delta_hours,
          reason,
          created_at,
          employees!pto_ledger_employee_id_fkey (
            first_name,
            last_name
          )
        `)
        .eq("school_id", profile.school_id)
        .gte("created_at", start_date)
        .lte("created_at", end_date)
        .order("created_at");
      if (campusEmployeeIds) txQuery = txQuery.in("employee_id", campusEmployeeIds);
      const { data, error } = await txQuery;

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

      const { data: settingsData } = await admin
        .from("school_settings")
        .select("workday_hours")
        .eq("school_id", profile.school_id)
        .maybeSingle();

      const workdayHours = Number(settingsData?.workday_hours ?? 8);

      let payrollQuery = admin
        .from("pto_ledger")
        .select(`
          employee_id,
          pto_type,
          delta_hours,
          employees!pto_ledger_employee_id_fkey (
            first_name,
            last_name
          )
        `)
        .eq("reason", "REQUEST APPROVED")
        .eq("school_id", profile.school_id)
        .gte("created_at", start_date)
        .lte("created_at", end_date);
      if (campusEmployeeIds) payrollQuery = payrollQuery.in("employee_id", campusEmployeeIds);
      const { data, error } = await payrollQuery;

      if (error) throw error;

      const usageMap: Record<string, any> = {};

      data.forEach(r => {
        if (r.delta_hours >= 0) return;

        const key = `${r.employee_id}_${r.pto_type}`;
        if (!usageMap[key]) {
          usageMap[key] = {
            employee: `${r.employees.last_name}, ${r.employees.first_name}`,
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
        { header: "Days Used", key: "days", width: 12 },
        { header: "Period Start", key: "start", width: 14 },
        { header: "Period End", key: "end", width: 14 },
      ];

      sheet.getRow(1).font = { bold: true };

      const sortedPayroll = Object.values(usageMap).sort((a, b) =>
        a.employee.localeCompare(b.employee)
      );

      sortedPayroll.forEach(r => {
        sheet.addRow({
          employee: r.employee,
          type: r.type,
          hours: r.hours,
          days: Number((r.hours / workdayHours).toFixed(2)),
          start: start_date,
          end: end_date,
        });
      });

      sheet.getColumn("hours").numFmt = "0.00";
      sheet.getColumn("days").numFmt = "0.00";
    }

    /* =====================================================
       NEGATIVE BALANCES REPORT
    ===================================================== */
    else if (report_type === "negative_balances") {
      const { data: settingsData } = await admin
        .from("school_settings")
        .select("workday_hours")
        .eq("school_id", profile.school_id)
        .maybeSingle();

      const workdayHours = Number(settingsData?.workday_hours ?? 8);

      let negQuery = admin
        .from("employees")
        .select(`
          first_name,
          last_name,
          employment_months,
          pto_balances (
            pto_type,
            balance_hours
          )
        `)
        .eq("active", true)
        .eq("school_id", profile.school_id)
        .order("last_name");
      if (campusEmployeeIds) negQuery = negQuery.in("id", campusEmployeeIds);
      const { data, error } = await negQuery;

      if (error) throw error;

      const sheet = workbook.addWorksheet("Negative Balances", {
        views: [{ state: "frozen", ySplit: 1 }],
      });

      sheet.columns = [
        { header: "Employee", key: "employee", width: 28 },
        { header: "Employment", key: "employment", width: 14 },
        { header: "PTO Type", key: "type", width: 14 },
        { header: "Balance (hrs)", key: "balance", width: 16 },
        { header: "Balance (days)", key: "days", width: 16 },
      ];

      sheet.getRow(1).font = { bold: true };

      let hasNegative = false;

      data.forEach(emp => {
        (emp.pto_balances as any[])
          .filter(b => Number(b.balance_hours) < 0)
          .forEach(b => {
            hasNegative = true;
            const hours = Number(b.balance_hours);
            const row = sheet.addRow({
              employee: `${emp.last_name}, ${emp.first_name}`,
              employment: (emp as any).employment_months ? `${(emp as any).employment_months}-month` : "—",
              type: b.pto_type,
              balance: hours,
              days: Number((hours / workdayHours).toFixed(2)),
            });
            row.getCell("balance").font = { color: { argb: "FFDC2626" } };
            row.getCell("days").font = { color: { argb: "FFDC2626" } };
          });
      });

      if (!hasNegative) {
        sheet.addRow({
          employee: "No employees with negative balances",
          employment: "", type: "", balance: "", days: ""
        });
      }

      sheet.getColumn("balance").numFmt = "0.00";
      sheet.getColumn("days").numFmt = "0.00";
    }

    /* =====================================================
       YEAR-END SUMMARY REPORT
    ===================================================== */
    else if (report_type === "year_end_summary") {
      if (!start_date || !end_date) {
        throw new Error("Missing date range");
      }

      const { data: settingsData } = await admin
        .from("school_settings")
        .select("workday_hours")
        .eq("school_id", profile.school_id)
        .maybeSingle();

      const workdayHours = Number(settingsData?.workday_hours ?? 8);

      let yesEmpQuery = admin
        .from("employees")
        .select("id, first_name, last_name, employment_months")
        .eq("school_id", profile.school_id)
        .eq("active", true)
        .order("last_name");
      if (campusEmployeeIds) yesEmpQuery = yesEmpQuery.in("id", campusEmployeeIds);
      const { data: employees, error: empErr } = await yesEmpQuery;

      if (empErr) throw empErr;

      let balQuery = admin
        .from("pto_balances")
        .select("employee_id, pto_type, balance_hours")
        .eq("school_id", profile.school_id);
      if (campusEmployeeIds) balQuery = balQuery.in("employee_id", campusEmployeeIds);
      const { data: balances, error: balErr } = await balQuery;

      if (balErr) throw balErr;

      const balanceMap: Record<string, Record<string, number>> = {};
      (balances as any[]).forEach(b => {
        if (!balanceMap[b.employee_id]) balanceMap[b.employee_id] = {};
        balanceMap[b.employee_id][b.pto_type] = Number(b.balance_hours);
      });

      let ledgerQuery = admin
        .from("pto_ledger")
        .select("employee_id, pto_type, delta_hours, reason")
        .eq("school_id", profile.school_id)
        .gte("created_at", start_date)
        .lte("created_at", end_date);
      if (campusEmployeeIds) ledgerQuery = ledgerQuery.in("employee_id", campusEmployeeIds);
      const { data: ledger, error: ledErr } = await ledgerQuery;

      if (ledErr) throw ledErr;

      type Summary = { allotted: number; used: number; adjusted: number; rollover: number; };
      const summaryMap: Record<string, Record<string, Summary>> = {};

      (ledger as any[]).forEach(l => {
        const empId = l.employee_id;
        const type = l.pto_type;
        if (!summaryMap[empId]) summaryMap[empId] = {};
        if (!summaryMap[empId][type]) summaryMap[empId][type] = { allotted: 0, used: 0, adjusted: 0, rollover: 0 };

        const s = summaryMap[empId][type];
        const hours = Number(l.delta_hours);
        const reason: string = l.reason || "";

        if (reason.includes("ANNUAL_ALLOTMENT")) {
          s.allotted += hours;
        } else if (reason === "REQUEST APPROVED") {
          s.used += Math.abs(hours);
        } else if (reason.includes("MANUAL_ADJUSTMENT")) {
          s.adjusted += hours;
        } else if (reason.includes("YEAR_END") && reason.includes("ROLLOVER") && hours > 0) {
          s.rollover += hours;
        }
      });

      const sheet = workbook.addWorksheet("Year-End Summary", {
        views: [{ state: "frozen", ySplit: 1 }],
      });

      sheet.columns = [
        { header: "Employee", key: "employee", width: 28 },
        { header: "Employment", key: "employment", width: 14 },
        { header: "PTO Type", key: "type", width: 14 },
        { header: "Allotted (hrs)", key: "allotted", width: 14 },
        { header: "Used (hrs)", key: "used", width: 12 },
        { header: "Used (days)", key: "used_days", width: 12 },
        { header: "Adjusted (hrs)", key: "adjusted", width: 14 },
        { header: "Rollover Credited (hrs)", key: "rollover", width: 20 },
        { header: "Current Balance (hrs)", key: "balance", width: 20 },
        { header: "Current Balance (days)", key: "balance_days", width: 20 },
      ];

      sheet.getRow(1).font = { bold: true };

      (employees as any[]).forEach(emp => {
        const empBalances = balanceMap[emp.id] || {};
        const empSummary = summaryMap[emp.id] || {};

        const types = new Set([
          ...Object.keys(empBalances),
          ...Object.keys(empSummary),
        ]);

        types.forEach(type => {
          const s = empSummary[type] || { allotted: 0, used: 0, adjusted: 0, rollover: 0 };
          const balance = empBalances[type] ?? 0;

          const row = sheet.addRow({
            employee: `${emp.last_name}, ${emp.first_name}`,
            employment: emp.employment_months ? `${emp.employment_months}-month` : "—",
            type,
            allotted: s.allotted,
            used: s.used,
            used_days: Number((s.used / workdayHours).toFixed(2)),
            adjusted: s.adjusted,
            rollover: s.rollover,
            balance,
            balance_days: Number((balance / workdayHours).toFixed(2)),
          });

          if (balance < 0) {
            row.getCell("balance").font = { color: { argb: "FFDC2626" } };
            row.getCell("balance_days").font = { color: { argb: "FFDC2626" } };
          }
        });
      });

      ["allotted", "used", "used_days", "adjusted", "rollover", "balance", "balance_days"].forEach(col => {
        sheet.getColumn(col).numFmt = "0.00";
      });
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

const today = new Date().toISOString().slice(0, 10);
const rangeLabel = (report_type !== "balances" && start_date && end_date)
  ? `_${start_date}_to_${end_date}`
  : `_as-of_${today}`;

return new Response(
  JSON.stringify({
    filename: `PTO_${report_type}${rangeLabel}.xlsx`,
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
