/**
 * Finding a way in to the database.
 *
 * Supabase offers several hostnames and the right one depends on the project:
 * the direct connection is IPv6-only unless the IPv4 add-on is enabled, and the
 * pooler is per-region. Rather than guess, try each and report which worked.
 *
 * Session mode (port 5432) rather than transaction mode (6543), because
 * migrations run DDL and transaction pooling does not support it.
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function env() {
  const out = {};
  for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "eu-west-1", "eu-west-2", "eu-central-1", "eu-central-2",
  "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-2",
  "ap-south-1", "sa-east-1", "ca-central-1",
];

function candidates(e) {
  const ref = e.SUPABASE_PROJECT_REF;
  const pw = encodeURIComponent(e.SUPABASE_DB_PASSWORD);
  const out = [
    { name: "direct", url: `postgresql://postgres:${pw}@db.${ref}.supabase.co:5432/postgres` },
  ];
  for (const r of REGIONS) {
    for (const host of [`aws-0-${r}`, `aws-1-${r}`]) {
      out.push({
        name: `pooler ${host}`,
        url: `postgresql://postgres.${ref}:${pw}@${host}.pooler.supabase.com:5432/postgres`,
      });
    }
  }
  return out;
}

export async function open({ quiet = false } = {}) {
  const e = env();
  let lastErr;
  for (const c of candidates(e)) {
    const client = new pg.Client({
      connectionString: c.url,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 6000,
      statement_timeout: 120000,
    });
    try {
      await client.connect();
      if (!quiet) console.log(`connected via ${c.name}`);
      return client;
    } catch (err) {
      lastErr = err;
      try { await client.end(); } catch { /* never opened */ }
    }
  }
  throw new Error("no route to the database. last error: " + lastErr?.message);
}

// Only when run directly, not when imported.
if ((process.argv[1] ?? "").endsWith("connect.mjs")) {
  const c = await open();
  const r = await c.query("select current_database() db, version()");
  console.log(r.rows[0].db, "|", r.rows[0].version.split(",")[0]);
  await c.end();
}
