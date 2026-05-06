
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const { preview_result, filename } = await req.json();

    if (!preview_result || preview_result.blockingErrors) {
      return new Response(
        JSON.stringify({ error: "Cannot commit with blocking errors" }),
        { status: 400, headers: corsHeaders }
      );
    }

    // --------------------------------------------------
    // Auth + permission
    // --------------------------------------------------
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
      .select("school_id, can_bulk_upload")
      .eq("user_id", user.id)
      .single();

    if (!profile?.can_bulk_upload) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: corsHeaders
      });
    }

    const school_id = profile.school_id;

    // ✅ Collect rollback metadata DURING commit
    const rollbackRows: Record<string, any[]> = {};

    // --------------------------------------------------
    // Families
    // --------------------------------------------------
    if (preview_result.details.Families) {
      for (const row of preview_result.details.Families) {

        if (row.action === "insert") {
          const { data, error } = await admin
            .from("families")
            .insert({ ...row.data, school_id })
            .select("id")
            .single();

          if (error) throw error;

          rollbackRows.Families ??= [];
          rollbackRows.Families.push({
            action: "insert",
            inserted_id: data.id
          });
        }

        if (row.action === "update") {
          const { error } = await admin
            .from("families")
            .update(row.data)
            .eq("id", row.existing_id);

          if (error) throw error;

          rollbackRows.Families ??= [];
          rollbackRows.Families.push({
            action: "update",
            existing_id: row.existing_id,
            diff: row.diff
          });
        }
      }
    }

    // --------------------------------------------------
    // Bus Groups
    // --------------------------------------------------
    if (preview_result.details["Bus Groups"]) {
      for (const row of preview_result.details["Bus Groups"]) {

        if (row.action === "insert") {
          const { data, error } = await admin
            .from("bus_groups")
            .insert({ ...row.data, school_id })
            .select("id")
            .single();

          if (error) throw error;

          rollbackRows["Bus Groups"] ??= [];
          rollbackRows["Bus Groups"].push({
            action: "insert",
            inserted_id: data.id
          });
        }

        if (row.action === "update") {
          const { error } = await admin
            .from("bus_groups")
            .update(row.data)
            .eq("id", row.existing_id);

          if (error) throw error;

          rollbackRows["Bus Groups"] ??= [];
          rollbackRows["Bus Groups"].push({
            action: "update",
            existing_id: row.existing_id,
            diff: row.diff
          });
        }
      }
    }

    // --------------------------------------------------
    // Students
    // --------------------------------------------------
    if (preview_result.details.Students) {
      for (const row of preview_result.details.Students) {

        if (row.action === "insert") {
          const { data, error } = await admin
            .from("students")
            .insert({ ...row.data, school_id })
            .select("id")
            .single();

          if (error) throw error;

          rollbackRows.Students ??= [];
          rollbackRows.Students.push({
            action: "insert",
            inserted_id: data.id
          });
        }

        if (row.action === "update") {
          const { error } = await admin
            .from("students")
            .update(row.data)
            .eq("id", row.existing_id);

          if (error) throw error;

          rollbackRows.Students ??= [];
          rollbackRows.Students.push({
            action: "update",
            existing_id: row.existing_id,
            diff: row.diff
          });
        }
      }
    }

    // --------------------------------------------------
    // Guardians
    // --------------------------------------------------
    if (preview_result.details.Guardians) {
      for (const row of preview_result.details.Guardians) {
        if (row.action !== "insert") continue;

        const { data, error } = await admin
          .from("guardians")
          .insert({ ...row.data, school_id })
          .select("id")
          .single();

        if (error) throw error;

        rollbackRows.Guardians ??= [];
        rollbackRows.Guardians.push({
          action: "insert",
          inserted_id: data.id
        });
      }
    }

    // --------------------------------------------------
    // Staff (employees)
    // --------------------------------------------------
    if (preview_result.details.Staff) {
      for (const row of preview_result.details.Staff) {

        if (row.action === "insert") {
          const { profile: p, ...employeeData } = row.data;

          const { data: emp, error } = await admin
            .from("employees")
            .insert({ ...employeeData, school_id })
            .select("id")
            .single();

          if (error) throw error;

          await admin.from("profiles").insert({
            employee_id: emp.id,
            school_id,
            role: p.role,
            can_view_carline: p.can_view_carline,
            can_view_pto_calendar: p.can_view_pto_calendar,
            can_review_pto: p.can_review_pto,
            can_approve_pto: p.can_approve_pto,
            can_adjust_pto: p.can_adjust_pto,
            can_bulk_upload: p.can_bulk_upload
          });

          rollbackRows.Staff ??= [];
          rollbackRows.Staff.push({
            action: "insert",
            inserted_id: emp.id
          });
        }

        if (row.action === "update") {
          const { error } = await admin
            .from("employees")
            .update(row.data)
            .eq("id", row.existing_id);

          if (error) throw error;

          rollbackRows.Staff ??= [];
          rollbackRows.Staff.push({
            action: "update",
            existing_id: row.existing_id,
            diff: row.diff
          });
        }
      }
    }

    // --------------------------------------------------
    // ✅ Audit log: COMMIT (rollback-ready)
    // --------------------------------------------------
    await admin.from("bulk_upload_logs").insert({
      school_id,
      uploaded_by: user.id,
      mode: "commit",
      summary: preview_result.summary,
      filename,
      rows: rollbackRows,
       });

    return new Response(
      JSON.stringify({ success: true }),
      { headers: corsHeaders }
    );

  } catch (err) {
    console.error("Bulk upload commit failed:", err);
    return new Response(
      JSON.stringify({ error: "Bulk upload commit failed" }),
      { status: 500, headers: corsHeaders }
    );
  }
});
