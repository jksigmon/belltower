import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};


function generateStudentNumber() {
  return `AUTO-${Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase()}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // --------------------------------------------------
    // 1. Parse request
    // --------------------------------------------------
    const { file_base64, selected_sheets, allow_updates = false, filename = null} = await req.json();

    if (!file_base64 || !Array.isArray(selected_sheets)) {
      return new Response(
        JSON.stringify({ error: "Invalid request payload" }),
        { status: 400, headers: corsHeaders }
      );
    }


    // --------------------------------------------------
    // 2. Auth check
    // --------------------------------------------------
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: corsHeaders }
      );
    }

    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const {
      data: { user }
    } = await authClient.auth.getUser();

    if (!user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: corsHeaders }
      );
    }

    // --------------------------------------------------
    // 3. Admin client + permissions
    // --------------------------------------------------
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: profile } = await admin
      .from("profiles")
      .select("school_id, can_bulk_upload")
      .eq("user_id", user.id)
      .single();

    if (!profile?.can_bulk_upload) {
      return new Response(
        JSON.stringify({ error: "Forbidden" }),
        { status: 403, headers: corsHeaders }
      );
    }

    
const { data: existingFamilies } = await admin
  .from("families")
  .select("id, carline_tag_number, family_name, active")
  .eq("school_id", profile.school_id);


const existingFamiliesByTag = new Map<string, {
  id: string;
  family_name: string | null;
  active: boolean;
}>(
  (existingFamilies ?? []).map(f => [
    String(f.carline_tag_number).trim(),
    {
      id: f.id,
      family_name: f.family_name,
      active: f.active
    }
  ])
);


    // --------------------------------------------------
    // 4. Decode workbook
    // --------------------------------------------------
    const buffer = Uint8Array.from(atob(file_base64), c => c.charCodeAt(0));
    const workbook = XLSX.read(buffer, { type: "array" });

    const result: any = {
      summary: {},
      details: {},
      hasErrors: false,
      blockingErrors: false
    };

    // --------------------------------------------------
    // 5. Dependency checks
    // --------------------------------------------------
    if (selected_sheets.includes("Students") &&
        !selected_sheets.includes("Families")) {
      result.hasErrors = true;
      result.blockingErrors = true;
      result.details.Students = [
        { error: "Students require Families sheet" }
      ];
      return new Response(JSON.stringify(result), {
        headers: corsHeaders
      });
    }



    // --------------------------------------------------
    // 6. Families validation
    // --------------------------------------------------
    if (selected_sheets.includes("Families")) {
      const sheet = workbook.Sheets["Families"];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const seenTags = new Set();
      const table = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as any;
        
const rawTag = row.carline_tag_number;
const tag = rawTag !== undefined && rawTag !== null
  ? String(rawTag).trim()
  : "";


        if (!tag) {
          table.push({ row: i + 2, action: "error", error: "Missing carline tag" });
          result.hasErrors = true;
          result.blockingErrors = true;
        } else if (seenTags.has(tag)) {
          table.push({ row: i + 2, action: "error", error: "Duplicate carline tag in file" });
          result.hasErrors = true;
          result.blockingErrors = true;
        
} else {
  seenTags.add(tag);

  const existing = existingFamiliesByTag.get(tag);

 
if (existing && allow_updates) {
  const newFamilyName = row.family_name
    ? String(row.family_name).trim()
    : null;

  const newActive =
    String(row.active).toUpperCase() !== "FALSE";

  const diff: Record<string, { before: any; after: any }> = {};

  if (existing.family_name !== newFamilyName) {
    diff.family_name = {
      before: existing.family_name,
      after: newFamilyName
    };
  }

  if (existing.active !== newActive) {
    diff.active = {
      before: existing.active,
      after: newActive
    };
  }

 
table.push({
  row: i + 2,
  action: "update",
  existing_id: existing.id,
  key: tag, // ✅ ADD THIS
  data: {
    family_name: newFamilyName,
    active: newActive
  },
  diff
});


  continue;
}

else if (existing && !allow_updates) {
  table.push({
    row: i + 2,
    action: "error",
    error: `Family with carline tag "${tag}" already exists`
  });
  result.hasErrors = true;
  result.blockingErrors = true;
  continue;
}

else {
  table.push({
    row: i + 2,
    action: "insert",
    data: {
      family_name: row.family_name
        ? String(row.family_name).trim()
        : null,
      carline_tag_number: tag,
      active: String(row.active).toUpperCase() !== "FALSE"
    }
  });
  continue;
}

}

      }

      result.details.Families = table;
     
result.summary.Families = {
  insert: table.filter(r => r.action === "insert").length,
  update: table.filter(r => r.action === "update").length,
  error: table.filter(r => r.action === "error").length
};
}

const previewFamiliesByTag = new Set<string>();

if (selected_sheets.includes("Families")) {
  for (const row of result.details.Families) {
    if (row.action === "insert" && row.data?.carline_tag_number) {
      previewFamiliesByTag.add(row.data.carline_tag_number);
    }
  }
}

// --------------------------------------------------
// Guardians validation (FINAL – schema aligned, phone-aware)
// --------------------------------------------------

const { data: existingGuardians } = await admin
  .from("guardians")
  .select("id, family_id, first_name, last_name, phone, email")
  .eq("school_id", profile.school_id);

// ✅ Build lookup map keyed by family_id + name + email
const existingGuardiansByKey = new Map<string, {
  id: string;
  phone: string | null;
}>(
  (existingGuardians ?? []).map(g => [
    `${g.family_id}|${g.first_name.toLowerCase()}|${g.last_name.toLowerCase()}|${(g.email ?? "").toLowerCase()}`,
    {
      id: g.id,
      phone: g.phone
        ? String(g.phone).replace(/\D/g, "")
        : null
    }
  ])
);

if (selected_sheets.includes("Guardians")) {
  const sheet = workbook.Sheets["Guardians"];

  if (!sheet) {
    result.hasErrors = true;
    result.blockingErrors = true;
    result.details.Guardians = [{ error: "Guardians sheet not found in workbook" }];
  } else {
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const table: any[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as any;

      const familyTag = row.family_carline_tag_number
        ? String(row.family_carline_tag_number).trim()
        : "";

      const firstName = row.first_name
        ? String(row.first_name).trim()
        : "";

      const lastName = row.last_name
        ? String(row.last_name).trim()
        : "";

      const emailValue = row.email
        ? String(row.email).trim().toLowerCase()
        : "";

      // ✅ Normalize phone (digits only)
      const normalizedPhone = row.phone
        ? String(row.phone).replace(/\D/g, "")
        : null;

      if (!familyTag) {
        table.push({
          row: i + 2,
          action: "error",
          error: "Missing family_carline_tag_number"
        });
        result.blockingErrors = true;
        continue;
      }

      const family = existingFamiliesByTag.get(familyTag);
      if (!family) {
        table.push({
          row: i + 2,
          action: "error",
          error: `Family not found for carline tag "${familyTag}"`
        });
        result.blockingErrors = true;
        continue;
      }

      if (!firstName || !lastName) {
        table.push({
          row: i + 2,
          action: "error",
          error: "Missing guardian first or last name"
        });
        continue;
      }

      // ✅ Stable dedupe key
      const guardianKey =
        `${family.id}|${firstName.toLowerCase()}|${lastName.toLowerCase()}|${emailValue}`;

      const existingGuardian = existingGuardiansByKey.get(guardianKey);

      // ✅ UPDATE phone if guardian exists and phone changed
      if (existingGuardian) {
        if (existingGuardian.phone !== normalizedPhone) {
          table.push({
            row: i + 2,
            action: "update",
            existing_id: existingGuardian.id,
            data: {
              phone: normalizedPhone
            }
          });
        } else {
          table.push({
            row: i + 2,
            action: "skip",
            reason: "Guardian already exists"
          });
        }
        continue;
      }

      // ✅ INSERT new guardian
      table.push({
        row: i + 2,
        action: "insert",
        data: {
          family_id: family.id,
          first_name: firstName,
          last_name: lastName,
          phone: normalizedPhone,
          email: emailValue || null,
          active: true
        }
      });
    }

    result.details.Guardians = table;
    result.summary.Guardians = {
      insert: table.filter(r => r.action === "insert").length,
      update: table.filter(r => r.action === "update").length,
      skip: table.filter(r => r.action === "skip").length,
      error: table.filter(r => r.action === "error").length
    };
  }
}

// Capture bus groups from preview
const previewBusGroupsByName = new Set<string>();

if (selected_sheets.includes("Bus Groups") && result.details["Bus Groups"]) {
  for (const row of result.details["Bus Groups"]) {
    if (row.action === "insert" && row.data?.name) {
      previewBusGroupsByName.add(String(row.data.name).trim());
    }
  }
}

// Load existing bus groups from DB
const { data: existingBusGroups } = await admin
  .from("bus_groups")
  .select("id, name, route_number")
  .eq("school_id", profile.school_id);


const existingBusGroupsByName = new Map<string, {
  id: string;
  route_number: string | null;
}>(
  (existingBusGroups ?? []).map(bg => [
    String(bg.name).trim(),
    {
      id: bg.id,
      route_number: bg.route_number
    }
  ])
);

// --------------------------------------------------
// Students validation
// --------------------------------------------------

// --------------------------------------------------
// Homeroom teacher lookup (email → employee_id)
// --------------------------------------------------
const { data: teacherEmployees } = await admin
  .from("employees")
  .select("id, email, first_name, last_name, position, active")
  .eq("school_id", profile.school_id)
  .eq("active", true)
  .ilike("position", "%teacher%")
  .not("email", "is", null);

const teachersByEmail = new Map<string, string>(
  (teacherEmployees ?? []).map(t => [
    String(t.email).trim().toLowerCase(),
    t.id
  ])
);


const { data: existingStudents } = await admin
  .from("students")
  .select(
    `
    id,
    family_id,
    student_number,
    first_name,
    last_name,
    grade_level,
    homeroom_teacher_id,
    bus_group_id,
    active
    `
  )
  .eq("school_id", profile.school_id);



// ✅ Key students by student_number ONLY

const existingStudentsByNumber = new Map<
  string,
  {
    id: string;
    family_id: string;
    first_name: string | null;
    last_name: string | null;
    grade_level: string | null;
    homeroom_teacher_id: string | null;
    bus_group_id: string | null;
    active: boolean;
  }
>(
  (existingStudents ?? []).map(s => [
    String(s.student_number).trim(),
    {
      id: s.id,
      family_id: s.family_id,
      first_name: s.first_name,
      last_name: s.last_name,
      grade_level: s.grade_level,
      homeroom_teacher_id: s.homeroom_teacher_id,
      bus_group_id: s.bus_group_id,
      active: s.active
    }
  ])
);


if (selected_sheets.includes("Students")) {
  const sheet = workbook.Sheets["Students"];

  if (!sheet) {
    result.hasErrors = true;
    result.blockingErrors = true;
    result.details.Students = [
      { error: "Students sheet not found in workbook" }
    ];
  } else {
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const table: any[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as any;

      const familyTag = row.family_carline_tag_number
        ? String(row.family_carline_tag_number).trim()
        : "";

      const firstName = row.first_name
        ? String(row.first_name).trim()
        : "";

      const lastName = row.last_name
        ? String(row.last_name).trim()
        : "";

const normalizedGrade =
  row.grade_level !== undefined && row.grade_level !== null
    ? String(row.grade_level).trim()
    : null;


const homeroomEmail = row.homeroom_teacher_email
  ? String(row.homeroom_teacher_email).trim().toLowerCase()
  : null;

let homeroomTeacherId: string | null = null;

if (homeroomEmail) {
  homeroomTeacherId = teachersByEmail.get(homeroomEmail) ?? null;

  if (!homeroomTeacherId) {
    table.push({
      row: i + 2,
      action: "error",
      error: `Homeroom teacher "${homeroomEmail}" not found or is not an active teacher`
    });
    result.blockingErrors = true;
    continue;
  }
}



      if (!familyTag) {
        table.push({
          row: i + 2,
          action: "error",
          error: "Missing family_carline_tag_number"
        });
        result.blockingErrors = true;
        continue;
      }

      const fromPreview = previewFamiliesByTag.has(familyTag);
      const familyId = fromPreview
        ? null  // real UUID resolved at commit time via family_tag field
        : existingFamiliesByTag.get(familyTag)?.id ?? null;

      if (!familyId && !fromPreview) {
        table.push({
          row: i + 2,
          action: "error",
          error: `Family "${familyTag}" not found`
        });
        result.blockingErrors = true;
        continue;
      }

      if (!firstName || !lastName) {
        table.push({
          row: i + 2,
          action: "error",
          error: "Missing student first or last name"
        });
        continue;
      }

      // ✅ Resolve bus group ID
      let busGroupId: string | null = null;
      if (row.bus_group_name) {
        const busName = String(row.bus_group_name).trim();
         busGroupId = existingBusGroupsByName.get(busName)?.id ?? null;

        if (!busGroupId) {
          table.push({
            row: i + 2,
            action: "error",
            error: `Bus group "${busName}" not found`
          });
          result.blockingErrors = true;
          continue;
        }
      }

      let studentNumber = row.student_number
        ? String(row.student_number).trim()
        : null;

      if (!studentNumber) {
        studentNumber = generateStudentNumber();
      }

      const existing = existingStudentsByNumber.get(studentNumber);

      // ===================================================
      // ✅ STRONG GUARD: student_number is IMMUTABLE
      // ===================================================
      if (existing) {
        if (
          row.student_number &&
          String(row.student_number).trim() !== studentNumber
        ) {
          table.push({
            row: i + 2,
            action: "error",
            error: "Student number cannot be changed via bulk upload"
          });
          result.blockingErrors = true;
          continue;
        }

        if (!row.student_number) {
          table.push({
            row: i + 2,
            action: "error",
            error: "Student number is required for existing students"
          });
          result.blockingErrors = true;
          continue;
        }
      }
      // ===================================================

      // ✅ UPDATE
      if (existing && allow_updates) {
        if (existing.family_id !== familyId) {
          table.push({
            row: i + 2,
            action: "error",
            error: "Student number already exists for a different family"
          });
          result.blockingErrors = true;
          continue;
        }

        const newActive = String(row.active).toUpperCase() !== "FALSE";
        const diff: Record<string, { before: any; after: any }> = {};

        if (existing.first_name !== firstName) {
          diff.first_name = { before: existing.first_name, after: firstName };
        }

        if (existing.last_name !== lastName) {
          diff.last_name = { before: existing.last_name, after: lastName };
        }

        if (existing.grade_level !== normalizedGrade) {
        diff.grade_level = {
        before: existing.grade_level,
        after: normalizedGrade
        };
        }
 
        if (existing.homeroom_teacher_id !== homeroomTeacherId) {
          diff.homeroom_teacher_id = {
            before: existing.homeroom_teacher_id,
            after: homeroomTeacherId
          };
        }


        if (existing.bus_group_id !== busGroupId) {
          diff.bus_group_id = {
            before: existing.bus_group_id,
            after: busGroupId
          };
        }

        if (existing.active !== newActive) {
          diff.active = { before: existing.active, after: newActive };
        }
        
  // ✅ If nothing actually changed, SKIP instead of UPDATE
         if (Object.keys(diff).length === 0) {
         table.push({
         row: i + 2,
         action: "skip",
        reason: "Already up to date"
         });
        continue;
       }

        table.push({
          row: i + 2,
          action: "update",
          existing_id: existing.id,    
          data: {
            family_id: familyId,
            first_name: firstName,
            last_name: lastName,
            grade_level: normalizedGrade,
            homeroom_teacher_id: homeroomTeacherId,
            bus_group_id: busGroupId,
            active: newActive
          },
          diff
        });
        continue;
      }

      // ❌ Exists but updates not allowed
      if (existing && !allow_updates) {
        table.push({
          row: i + 2,
          action: "error",
          error: `Student number ${studentNumber} already exists`
        });
        result.blockingErrors = true;
        continue;
      }

      // ✅ INSERT (brand new student)
      table.push({
        row: i + 2,
        action: "insert",
        ...(fromPreview ? { family_tag: familyTag } : {}),
        data: {
          family_id: familyId,
          student_number: studentNumber,
          first_name: firstName,
          last_name: lastName,
          grade_level: normalizedGrade,
          homeroom_teacher_id: homeroomTeacherId,
          bus_group_id: busGroupId,
          active: String(row.active).toUpperCase() !== "FALSE"
        }
      });
    }

    result.details.Students = table;
    result.summary.Students = {
      insert: table.filter(r => r.action === "insert").length,
      update: table.filter(r => r.action === "update").length,
      skip:   table.filter(r => r.action === "skip").length,
      error: table.filter(r => r.action === "error").length
    };
  }
}



// Load existing staff from DB
const { data: existingEmployees } = await admin
  .from("employees")
  .select("id, email, first_name, last_name, position, active, supervisor_id")
  .eq("school_id", profile.school_id)
  .not("email", "is", null);


const existingStaffByEmail = new Map<string, {
  id: string;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  active: boolean;
  supervisor_id: string | null;  // ✅ ADD THIS
}>(
  (existingEmployees ?? []).map(e => [
    String(e.email).trim().toLowerCase(),
    {
      id: e.id,
      first_name: e.first_name,
      last_name: e.last_name,
      position: e.position,
      active: e.active,
      supervisor_id: e.supervisor_id // ✅ ADD THIS
    }
  ])
);

// --------------------------------------------------
// STAFF validation
// --------------------------------------------------

const { data: approverProfiles } = await admin
  .from("profiles")
  .select(`
    employee_id,
    email,
    employees!profiles_employee_id_fkey (
      id,
      email
    )
  `)
  .eq("school_id", profile.school_id)
  .eq("can_approve_pto", true)
  .not("employee_id", "is", null);


const approversByEmail = new Map<string, string>();

for (const p of approverProfiles ?? []) {
  if (p.employees?.email && p.employee_id) {
    approversByEmail.set(
      p.employees.email.toLowerCase(),
      p.employee_id
    );
  }
}



if (selected_sheets.includes("Staff")) {
  const sheet = workbook.Sheets["Staff"];

  if (!sheet) {
    result.hasErrors = true;
    result.blockingErrors = true;
    result.details.Staff = [{ error: "Staff sheet not found in workbook" }];
  } else {
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const table: any[] = [];

    const seenEmails = new Set<string>(); // upload‑only duplicates

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as any;

      const firstName = row.first_name ? String(row.first_name).trim() : "";
      const lastName  = row.last_name  ? String(row.last_name).trim()  : "";

      
const supervisorEmail = row.supervisor_email
  ? String(row.supervisor_email).trim().toLowerCase()
  : null;

let supervisorId: string | null = null;

if (supervisorEmail) {
  supervisorId = approversByEmail.get(supervisorEmail) ?? null;

  if (!supervisorId) {
    table.push({
      row: i + 2,
      action: "error",
      error: `Supervisor "${supervisorEmail}" not found or is not a PTO approver`
    });
    result.hasErrors = true;
    result.blockingErrors = true;
    continue;
  }
}


      let email: string | null = row.email
        ? String(row.email).trim().toLowerCase()
        : null;

      if (!firstName || !lastName) {
        table.push({
          row: i + 2,
          action: "error",
          error: "Missing staff first or last name"
        });
        result.hasErrors = true;
        result.blockingErrors = true;
        continue;
      }

      // Upload‑level duplicate email
      if (email && seenEmails.has(email)) {
        table.push({
          row: i + 2,
          action: "error",
          error: `Duplicate email "${email}" in upload`
        });
        result.hasErrors = true;
        result.blockingErrors = true;
        continue;
      }

      if (email) seenEmails.add(email);

      const existing = email ? existingStaffByEmail.get(email) : undefined;

      // ✅ UPDATE
    

if (existing && allow_updates) {

  // ✅ Prevent self‑supervision
  if (supervisorId && existing.id === supervisorId) {
    table.push({
      row: i + 2,
      action: "error",
      error: "Staff member cannot supervise themselves"
    });
    result.hasErrors = true;
    result.blockingErrors = true;
    continue;
  }

  const newPosition = row.position
    ? String(row.position).trim()
    : null;

  const newActive =
    String(row.active).toUpperCase() !== "FALSE";

  const diff: Record<string, { before: any; after: any }> = {};

  if (existing.first_name !== firstName) {
    diff.first_name = {
      before: existing.first_name,
      after: firstName
    };
  }

  if (existing.last_name !== lastName) {
    diff.last_name = {
      before: existing.last_name,
      after: lastName
    };
  }

  if (existing.position !== newPosition) {
    diff.position = {
      before: existing.position,
      after: newPosition
    };
  }

  if (existing.active !== newActive) {
    diff.active = {
      before: existing.active,
      after: newActive
    };
  }

  // ✅ Supervisor change
  if (existing.supervisor_id !== supervisorId) {
    diff.supervisor_email = {
      before: existing.supervisor_id,
      after: supervisorEmail
    };
  }

  // ✅ Supervisor cleared
  if (!supervisorEmail && existing.supervisor_id) {
    diff.supervisor_email = {
      before: existing.supervisor_id,
      after: null
    };
  }


  // ✅ If nothing actually changed, SKIP instead of UPDATE
  if (Object.keys(diff).length === 0) {
    table.push({
      row: i + 2,
      action: "skip",
      reason: "Already up to date"
    });
    continue;
  }

  table.push({
    row: i + 2,
    action: "update",
    existing_id: existing.id,
    data: {
      first_name: firstName,
      last_name: lastName,
      position: newPosition,
      active: newActive,
      supervisor_id: supervisorId
    },
    diff,
    profile_action: "none"
  });

  continue;
}


      // ❌ EXISTS but updates not allowed
      if (existing && !allow_updates) {
        table.push({
          row: i + 2,
          action: "error",
          error: `Email "${email}" already exists`
        });
        result.hasErrors = true;
        result.blockingErrors = true;
        continue;
      }

      // ✅ INSERT
      table.push({
        row: i + 2,
        action: "insert",
     
data: {
  first_name: firstName,
  last_name: lastName,
  email,
  position: row.position ? String(row.position).trim() : null,
  active: String(row.active).toUpperCase() !== "FALSE",
  supervisor_id: supervisorId, // ✅ ADD THIS

  profile: {
    role: "staff",
    can_view_carline: false,
    can_view_pto_calendar: false,
    can_review_pto: false,
    can_approve_pto: false,
    can_adjust_pto: false,
    can_bulk_upload: false
  }
}

      });
    }

    result.details.Staff = table;
    result.summary.Staff = {
      insert: table.filter(r => r.action === "insert").length,
      update: table.filter(r => r.action === "update").length,
      skip:   table.filter(r => r.action === "skip").length,
      error:  table.filter(r => r.action === "error").length
    };
  }
}

// --------------------------------------------------
// Bus Groups validation
// --------------------------------------------------
if (selected_sheets.includes("Bus Groups")) {
  const sheet = workbook.Sheets["Bus Groups"];

  if (!sheet) {
    result.hasErrors = true;
    result.blockingErrors = true;
    result.details["Bus Groups"] = [
      { error: "Bus Groups sheet not found in workbook" }
    ];
  } else {
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const table: any[] = [];

    const seenNames = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as any;

      const rawName = row.name;
      const name =
        rawName !== undefined && rawName !== null
          ? String(rawName).trim()
          : "";

      if (!name) {
        table.push({
          row: i + 2,
          action: "error",
          error: "Missing bus group name"
        });
        result.hasErrors = true;
        result.blockingErrors = true;
        continue;
      }

      if (seenNames.has(name)) {
        table.push({
          row: i + 2,
          action: "error",
          error: `Duplicate bus group "${name}" in upload`
        });
        result.hasErrors = true;
        result.blockingErrors = true;
        continue;
      }

     const existing = existingBusGroupsByName.get(name);


if (existing && allow_updates) {
  const newRouteNumber = row.route_number
    ? String(row.route_number).trim()
    : null;

  const diff: Record<string, { before: any; after: any }> = {};

  if (existing.route_number !== newRouteNumber) {
    diff.route_number = {
      before: existing.route_number,
      after: newRouteNumber
    };
  }

  table.push({
    row: i + 2,
    action: "update",
    existing_id: existing.id,
    data: {
      route_number: newRouteNumber
    },
    diff
  });

  continue;
}


if (existing && !allow_updates) {
  table.push({
    row: i + 2,
    action: "error",
    error: `Bus group "${name}" already exists`
  });
  result.hasErrors = true;
  result.blockingErrors = true;
  continue;
}

      seenNames.add(name);

      table.push({
        row: i + 2,
        action: "insert",
        data: {
          name,
          route_number: row.route_number
            ? String(row.route_number).trim()
            : null
        }
      });
    }

    result.details["Bus Groups"] = table;
    result.summary["Bus Groups"] = {
      insert: table.filter(r => r.action === "insert").length,
      update: table.filter(r => r.action === "update").length,
      error: table.filter(r => r.action === "error").length
    };
  }
}

// --------------------------------------------------
// Audit log: preview
// --------------------------------------------------
try {
  const errorCount =
    Object.values(result.details || {})
      .flat()
      .filter((r: any) => r.action === "error").length;

  await admin
    .from("bulk_upload_logs")
    .insert({
      school_id: profile.school_id,
      uploaded_by: user.id,
      mode: "preview",
      selected_sheets,
      summary: result.summary,
      filename: filename ?? null,
      error_count: errorCount,
      blocking_errors: result.blockingErrors === true
    });
} catch (logError) {
  // Audit logging must NEVER block preview
  console.error("Bulk upload preview audit log failed:", logError);
}

    // --------------------------------------------------
    // 7. Return preview
    // --------------------------------------------------
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });

  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: "Server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
});
