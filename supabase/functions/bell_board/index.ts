import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Feed for bell pages (app/bells.html). Token-authenticated: the caller
// presents a bell_schedules.feed_token, so this must be deployed with
// verify_jwt = false (see supabase/config.toml).
//
//   GET ?action=time           -> { now }
//   GET ?t=<feed_token>&v=<v>  -> { now, version, unchanged: true }
//                              or { now, version, timeline }
//
// `now` is this server's clock in epoch ms. Bell pages derive their own
// offset from it and never trust the device clock.
//
// Load: every open bell page polls about once a minute, but the timeline
// is cached per schedule in this isolate, so the database sees at most
// one small read per schedule per CACHE_MS no matter how many screens are
// open. Nothing here touches the carline tables or Realtime.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const CACHE_MS = 30_000;
const TIMELINE_DAYS = 3;
const MAX_CACHE_ENTRIES = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// timeline === null means "no such schedule" (unknown or rotated token,
// inactive schedule, or module off). That is cached too, so a screen left
// polling a dead token cannot turn into a query per request.
type CacheEntry = { at: number; version: string | null; timeline: unknown | null };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 8), b => b.toString(16).padStart(2, "0")).join("");
}

async function load(token: string): Promise<CacheEntry> {
  const { data, error } = await supabase.rpc("bell_timeline", {
    p_feed_token: token,
    p_days: TIMELINE_DAYS,
  });
  if (error) throw error;

  const entry: CacheEntry = {
    at: Date.now(),
    version: data ? await hash(data) : null,
    timeline: data ?? null,
  };

  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(token, entry);
  return entry;
}

// Concurrent requests for the same schedule share one database read.
function getTimeline(token: string): Promise<CacheEntry> {
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit);

  let pending = inflight.get(token);
  if (!pending) {
    pending = load(token).finally(() => inflight.delete(token));
    inflight.set(token, pending);
  }
  return pending;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return json({ error: "Not found" }, 404);
  }

  try {
    const url = new URL(req.url);

    if (url.searchParams.get("action") === "time") {
      return json({ now: Date.now() });
    }

    const token = (url.searchParams.get("t") ?? "").toLowerCase();
    if (!UUID_RE.test(token)) {
      return json({ error: "A schedule token is required" }, 400);
    }

    let entry: CacheEntry;
    try {
      entry = await getTimeline(token);
    } catch (err) {
      // A failed refresh should not silence bells: fall back to the last
      // good copy if there is one, and let the page keep its own cache
      // otherwise (it treats a non-OK response as "try again next cycle").
      console.error("bell_board timeline load failed:", err);
      const stale = cache.get(token);
      if (!stale) return json({ error: "Internal server error" }, 500);
      entry = stale;
    }

    if (!entry.timeline) {
      return json({ error: "Schedule not found", now: Date.now() }, 404);
    }

    if (url.searchParams.get("v") === entry.version) {
      return json({ now: Date.now(), version: entry.version, unchanged: true });
    }
    return json({ now: Date.now(), version: entry.version, timeline: entry.timeline });
  } catch (err) {
    console.error("bell_board error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
