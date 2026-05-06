#!/usr/bin/env node
// Runs at build time (via `npm run build` / `vercel dev` / Vercel CI).
// Reads SUPABASE_URL and SUPABASE_ANON_KEY from the environment and writes
// app/config.js so the client-side Supabase module can import them without
// any credentials being hard-coded in source.
const fs   = require('fs');
const path = require('path');

// Load .env.local when running locally. No-op in Vercel CI (vars come from the dashboard).
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });

const url     = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url)     { console.error('ERROR: SUPABASE_URL is not set');     process.exit(1); }
if (!anonKey) { console.error('ERROR: SUPABASE_ANON_KEY is not set'); process.exit(1); }

const out = path.join(__dirname, '..', 'app', 'config.js');

fs.writeFileSync(out, `// Auto-generated at build time — do not edit or commit.\nexport const SUPABASE_URL      = '${url}';\nexport const SUPABASE_ANON_KEY = '${anonKey}';\n`, 'utf8');

console.log(`build-config: wrote ${out}`);
