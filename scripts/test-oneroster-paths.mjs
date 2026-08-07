import { readFileSync } from "node:fs";

function loadEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

const env = { ...loadEnvFile(new URL("../.env.oneroster", import.meta.url)), ...process.env };
const { IC_CLIENT_ID, IC_CLIENT_SECRET, IC_TOKEN_URL, IC_BASE_URL } = env;

const basicAuth = Buffer.from(`${IC_CLIENT_ID}:${IC_CLIENT_SECRET}`).toString("base64");
const tokenRes = await fetch(IC_TOKEN_URL, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basicAuth}` },
  body: "grant_type=client_credentials",
});
const { access_token } = await tokenRes.json();
console.log("token ok:", access_token.slice(0, 15) + "...");

const paths = [
  "rostering/orgs",
  "rostering/students",
  "v1p2/rostering/orgs",
  "ims/oneroster/rostering/orgs",
  "orgs/",
  "",
  "resources",
  "rostering/schools",
];

for (const p of paths) {
  const url = `${IC_BASE_URL}/${p}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
  const text = await res.text();
  console.log(`\n=== ${url} ===`);
  console.log("status:", res.status);
  console.log(text.slice(0, 300));
}
