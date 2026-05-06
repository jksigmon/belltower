import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    /* --------------------------------------------------
       Parse request
    -------------------------------------------------- */
    
const { type, split } = await req.json();
// split can be: "grade" | "homeroom" | undefined
    if (!type) {
      return new Response(
        JSON.stringify({ error: "Missing export type" }),
        { status: 400, headers: corsHeaders }
      );
    }

    /* --------------------------------------------------
       Auth
    -------------------------------------------------- */
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders
      });
    }

    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: profile } = await admin
      .from("profiles")
      .select("school_id, can_export_data")
      .eq("user_id", user.id)
      .single();

    if (!profile?.can_export_data) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: corsHeaders
      });
    }

    /* --------------------------------------------------
       CLASS PLACEMENT EXPORT
    -------------------------------------------------- */
    if (type === "class_placement") {
      const { data, error } = await admin
        .from("students")
        .select(`
          grade_level,
          first_name,
          last_name,
          student_number,
          active,
          families (
            family_name,
            carline_tag_number
          ),
          employees:homeroom_teacher_id (
            first_name,
            last_name
          )
        `)
        .eq("school_id", profile.school_id)
        .order("grade_level", { ascending: true })
        .order("last_name", { ascending: true });

      if (error) throw error;

      const rows = (data ?? []).map(s => ({
        Grade: s.grade_level ?? "",
        "Homeroom Teacher": s.employees
          ? `${s.employees.last_name}, ${s.employees.first_name}`
          : "",
        "Student Last Name": s.last_name ?? "",
        "Student First Name": s.first_name ?? "",
        "Student Number": s.student_number ?? "",
        Family: s.families?.family_name ?? "",
        "Carline Tag": s.families?.carline_tag_number ?? "",
        Active: s.active ? "Yes" : "No"
      }));

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, "Class Placement");

      const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      const base64 = btoa(
        String.fromCharCode(...new Uint8Array(buffer))
      );

      const filename = `class-placement-${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`;

return new Response(
  JSON.stringify({
    file_base64: base64,
    filename,
    mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }),
  {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"   // ✅ REQUIRED
    }
  }
);

    }

/* --------------------------------------------------
   TEACHER ROSTERS EXPORT
-------------------------------------------------- */
if (type === "teacher_rosters") {
  const { data, error } = await admin
    .from("students")
    .select(`
      grade_level,
      first_name,
      last_name,
      student_number,
      active,
      families (
        family_name,
        carline_tag_number
      ),
      employees:homeroom_teacher_id (
        id,
        first_name,
        last_name
      )
    `)
    .eq("school_id", profile.school_id)
    .order("last_name", { ascending: true });

  if (error) throw error;

  // Group students by teacher
  const byTeacher = new Map<string, {
    teacherName: string;
    rows: any[];
  }>();

  for (const s of data ?? []) {
    if (!s.employees) continue;

    const key = s.employees.id;
    if (!byTeacher.has(key)) {
      byTeacher.set(key, {
        teacherName: `${s.employees.last_name}, ${s.employees.first_name}`,
        rows: []
      });
    }

    byTeacher.get(key)!.rows.push({
      "Student Last Name": s.last_name ?? "",
      "Student First Name": s.first_name ?? "",
      Grade: s.grade_level ?? "",
      "Student Number": s.student_number ?? "",
      Family: s.families?.family_name ?? "",
      "Carline Tag": s.families?.carline_tag_number ?? "",
      Active: s.active ? "Yes" : "No"
    });
  }

  const wb = XLSX.utils.book_new();

  for (const { teacherName, rows } of byTeacher.values()) {
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(
      wb,
      ws,
      teacherName.substring(0, 31) // Excel sheet name limit
    );
  }

  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const base64 = btoa(
    String.fromCharCode(...new Uint8Array(buffer))
  );

  const filename = `teacher-rosters-${new Date()
    .toISOString()
    .slice(0, 10)}.xlsx`;

  return new Response(
    JSON.stringify({
      file_base64: base64,
      filename,
      mime_type:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }),
    {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    }
  );
}


/* --------------------------------------------------
   GRADE ROSTERS EXPORT
-------------------------------------------------- */
if (type === "grade_rosters") {
  const { data, error } = await admin
    .from("students")
    .select(`
      grade_level,
      first_name,
      last_name,
      student_number,
      active,
      families (
        family_name,
        carline_tag_number
      ),
      employees:homeroom_teacher_id (
        first_name,
        last_name
      )
    `)
    .eq("school_id", profile.school_id)
    .order("grade_level", { ascending: true })
    .order("last_name", { ascending: true });

  if (error) throw error;

  // Group students by grade
  const byGrade = new Map<string, any[]>();

  for (const s of data ?? []) {
    const grade = s.grade_level ?? "Unassigned";

    if (!byGrade.has(grade)) {
      byGrade.set(grade, []);
    }

    byGrade.get(grade)!.push({
      "Homeroom Teacher": s.employees
        ? `${s.employees.last_name}, ${s.employees.first_name}`
        : "",
      "Student Last Name": s.last_name ?? "",
      "Student First Name": s.first_name ?? "",
      "Student Number": s.student_number ?? "",
      Family: s.families?.family_name ?? "",
      "Carline Tag": s.families?.carline_tag_number ?? "",
      Active: s.active ? "Yes" : "No"
    });
  }

  const wb = XLSX.utils.book_new();

  for (const [grade, rows] of byGrade.entries()) {
    const sheetName = `Grade ${grade}`.substring(0, 31);
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const base64 = btoa(
    String.fromCharCode(...new Uint8Array(buffer))
  );

  const filename = `grade-rosters-${new Date()
    .toISOString()
    .slice(0, 10)}.xlsx`;

  return new Response(
    JSON.stringify({
      file_base64: base64,
      filename,
      mime_type:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }),
    {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    }
  );
}

/* --------------------------------------------------
   BUS GROUP ASSIGNMENTS EXPORT
-------------------------------------------------- */
if (type === "bus_assignments") {
  const { data, error } = await admin
    .from("students")
    .select(`
      grade_level,
      first_name,
      last_name,
      active,
      families (
        family_name,
        carline_tag_number
      ),
      bus_groups (
        name,
        route_number
      ),
      employees:homeroom_teacher_id (
        first_name,
        last_name
      )
    `)
    .eq("school_id", profile.school_id)
    .order("last_name", { ascending: true });

  if (error) throw error;

  // Group students by bus group
  const byBusGroup = new Map<string, {
    groupName: string;
    routeNumber: string | null;
    rows: any[];
  }>();

  for (const s of data ?? []) {
    if (!s.bus_groups) continue;

    const key = s.bus_groups.name;

    if (!byBusGroup.has(key)) {
      byBusGroup.set(key, {
        groupName: s.bus_groups.name,
        routeNumber: s.bus_groups.route_number,
        rows: []
      });
    }

    byBusGroup.get(key)!.rows.push({
      "Bus Group": s.bus_groups.name,
      "Route Number": s.bus_groups.route_number ?? "",
      "Student Last Name": s.last_name ?? "",
      "Student First Name": s.first_name ?? "",
      Grade: s.grade_level ?? "",
      "Homeroom Teacher": s.employees
        ? `${s.employees.last_name}, ${s.employees.first_name}`
        : "",
      Family: s.families?.family_name ?? "",
      "Carline Tag": s.families?.carline_tag_number ?? "",
      Active: s.active ? "Yes" : "No"
    });
  }

  const wb = XLSX.utils.book_new();

  for (const { groupName, rows } of byBusGroup.values()) {
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(
      wb,
      ws,
      groupName.substring(0, 31) // Excel sheet name limit
    );
  }

  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const base64 = btoa(
    String.fromCharCode(...new Uint8Array(buffer))
  );

  const filename = `bus-group-assignments-${new Date()
    .toISOString()
    .slice(0, 10)}.xlsx`;

  return new Response(
    JSON.stringify({
      file_base64: base64,
      filename,
      mime_type:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }),
    {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    }
  );
}


/* --------------------------------------------------
   CONTACT LISTS EXPORT (optionally split)
-------------------------------------------------- */
if (type === "contact_lists") {
  const { data, error } = await admin
    .from("guardians")
    .select(`
      first_name,
      last_name,
      phone,
      email,
      families (
        family_name,
        carline_tag_number,
        students (
          first_name,
          last_name,
          grade_level,
          active,
          employees:homeroom_teacher_id (
            first_name,
            last_name
          )
        )
      )
    `)
    .eq("school_id", profile.school_id)
    .eq("active", true);

  if (error) throw error;

  const groups = new Map<string, any[]>();

  const addRow = (key: string, row: any) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  };

  for (const g of data ?? []) {
    const family = g.families;
    if (!family?.students?.length) continue;

    for (const s of family.students) {
      const row = {
        Family: family.family_name ?? "",
        "Carline Tag": family.carline_tag_number ?? "",
        "Guardian First Name": g.first_name ?? "",
        "Guardian Last Name": g.last_name ?? "",
        "Guardian Phone": g.phone ?? "",
        "Guardian Email": g.email ?? "",
        "Student First Name": s.first_name ?? "",
        "Student Last Name": s.last_name ?? "",
        Grade: s.grade_level ?? "",
        "Homeroom Teacher": s.employees
          ? `${s.employees.last_name}, ${s.employees.first_name}`
          : "",
        "Student Active": s.active ? "Yes" : "No"
      };

      // ✅ Determine grouping key
      let groupKey = "All Contacts";

      if (split === "grade") {
        groupKey = `Grade ${s.grade_level ?? "Unassigned"}`;
      }

      if (split === "homeroom") {
        groupKey = s.employees
          ? `${s.employees.last_name}, ${s.employees.first_name}`
          : "Unassigned Homeroom";
      }

      addRow(groupKey, row);
    }
  }

  const wb = XLSX.utils.book_new();

  for (const [group, rows] of groups.entries()) {
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(
      wb,
      ws,
      group.substring(0, 31) // Excel limit
    );
  }

  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const base64 = btoa(
    String.fromCharCode(...new Uint8Array(buffer))
  );

  const suffix =
    split === "grade"
      ? "by-grade"
      : split === "homeroom"
      ? "by-homeroom"
      : "all";

  const filename = `contact-lists-${suffix}-${new Date()
    .toISOString()
    .slice(0, 10)}.xlsx`;

  return new Response(
    JSON.stringify({
      file_base64: base64,
      filename,
      mime_type:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }),
    {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    }
  );
}

    /* --------------------------------------------------
       Unknown export
    -------------------------------------------------- */

return new Response(
  JSON.stringify({ error: "Unknown export type" }),
  {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  }
);


  } catch (err) {
    console.error("Export error:", err);
    return new Response(
      JSON.stringify({ error: "Export failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
  }
);
  }
});

