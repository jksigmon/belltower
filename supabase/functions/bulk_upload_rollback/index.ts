
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

    // ✅ Load most recent commit log
    const { data: log } = await admin
      .from("bulk_upload_logs")
      .select("*")
      .eq("school_id", profile.school_id)
      .eq("mode", "commit")
      .order("uploaded_at", { ascending: false })
      .limit(1)
      .single();

 
if (!log || !log.rows) {
  return new Response(
    JSON.stringify({
      error: "No recent bulk upload found to roll back."
    }),
    { status: 400, headers: corsHeaders }
  );
}


    const rows = log.rows;

    // ✅ PER-ENTITY rollback
    const rollbackEntity = async (table: string, entityRows: any[]) => {
      for (const row of entityRows) {

        // DELETE inserted rows
        if (row.action === "insert" && row.inserted_id) {
          await admin.from(table).delete().eq("id", row.inserted_id);
          continue;
        }

        // RESTORE updated rows
        if (row.action === "update" && row.existing_id && row.diff) {
          const restoreData: any = {};

          for (const [field, change] of Object.entries(row.diff)) {
            restoreData[field] = (change as any).before;
          }

          await admin.from(table)
            .update(restoreData)
            .eq("id", row.existing_id);
        }
      }
    };

    // ✅ Apply rollback (order matters)
    if (rows.Students)   await rollbackEntity("students", rows.Students);
    if (rows.Guardians)  await rollbackEntity("guardians", rows.Guardians);
    if (rows.Staff)      await rollbackEntity("employees", rows.Staff);
    if (rows["Bus Groups"]) await rollbackEntity("bus_groups", rows["Bus Groups"]);
    if (rows.Families)   await rollbackEntity("families", rows.Families);

    // ✅ Record rollback event
    await admin.from("bulk_upload_logs").insert({
      school_id: profile.school_id,
      uploaded_by: user.id,
      mode: "rollback",
      rolled_back_commit_id: log.id,
      rolled_back_at: new Date().toISOString()
    });

    

const rollbackSummary: Record<string, {
  reverted_updates: number;
  removed_inserts: number;
}> = {};

for (const [sheet, sheetRows] of Object.entries(rows as Record<string, any[]>)) {
  rollbackSummary[sheet] = {
    reverted_updates: sheetRows.filter(r => r.action === "update").length,
    removed_inserts: sheetRows.filter(r => r.action === "insert").length
  };
}

return new Response(
  JSON.stringify({
    success: true,
    summary: rollbackSummary
  }),
  { headers: corsHeaders }
);


  } catch (err) {
    console.error("Rollback failed:", err);
    return new Response(
      JSON.stringify({ error: "Rollback failed" }),
      { status: 500, headers: corsHeaders }
    );
  }
});
