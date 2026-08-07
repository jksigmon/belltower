// One-off connectivity test for the Infinite Campus OneRoster v1p2 API.
// Not part of the app build — run manually with `node scripts/test-oneroster.mjs`.
//
// Usage:
//   1. Create a `.env.oneroster` file in the project root (already gitignored — verify before running) with:
//        IC_CLIENT_ID=...
//        IC_CLIENT_SECRET=...
//        IC_TOKEN_URL=https://41q.ncsis.gov/campus/oauth2/token?appName=psu41qrevolution
//        IC_BASE_URL=https://41q.ncsis.gov/campus/api/oneroster/v1p2/psu41qrevolution/ims/oneroster
//   2. Run: node scripts/test-oneroster.mjs

import { readFileSync } from "node:fs";

function loadEnvFile(path) {
  const env = {};
  const contents = readFileSync(path, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = { ...loadEnvFile(new URL("../.env.oneroster", import.meta.url)), ...process.env };

const { IC_CLIENT_ID, IC_CLIENT_SECRET, IC_TOKEN_URL, IC_BASE_URL } = env;

if (!IC_CLIENT_ID || !IC_CLIENT_SECRET || !IC_TOKEN_URL || !IC_BASE_URL) {
  console.error("Missing one of IC_CLIENT_ID / IC_CLIENT_SECRET / IC_TOKEN_URL / IC_BASE_URL");
  process.exit(1);
}

async function getAccessToken() {
  const basicAuth = Buffer.from(`${IC_CLIENT_ID}:${IC_CLIENT_SECRET}`).toString("base64");

  const res = await fetch(IC_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: "grant_type=client_credentials",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }

  const json = JSON.parse(text);
  console.log(`Got access token (expires_in=${json.expires_in}s)`);
  return json.access_token;
}

async function callEndpoint(token, path, params = "limit=5") {
  const url = `${IC_BASE_URL}/rostering/v1p2${path}${params ? `?${params}` : ""}`;
  console.log(`\n--- GET ${url} ---`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  console.log(`Status: ${res.status}`);
  try {
    const json = JSON.parse(text);
    console.log(JSON.stringify(json, null, 2).slice(0, 3000));
  } catch {
    console.log(text.slice(0, 1000));
  }
}

const token = await getAccessToken();

// Sanity-check a handful of standard OneRoster v1p2 endpoints to see what's actually exposed.
await callEndpoint(token, "/orgs");
await callEndpoint(token, "/schools");
await callEndpoint(token, "/students");
await callEndpoint(token, "/demographics");
await callEndpoint(token, "/enrollments");
await callEndpoint(token, "/classes");
