/**
 * Finding a way in to the database.
 *
 * Supabase offers several hostnames and the right one depends on the project:
 * the direct connection is IPv6-only unless the IPv4 add-on is enabled, and the
 * pooler is per-region. Rather than guess, try each and report which worked.
 *
 * Session mode (port 5432) rather than transaction mode (6543), because
 * migrations run DDL and transaction pooling does not support it.
 *
 * ## The certificate is checked
 *
 * Every candidate used to connect with `rejectUnauthorized: false`, which is
 * encryption without authentication: the traffic could not be read by a passive
 * listener and could be terminated by anybody who could get in the path, who
 * would then be handed the database password and would be answering the
 * migrations. That is not a theoretical difference on a connection whose whole
 * purpose is privileged schema change.
 *
 * Supabase does not use a public CA for Postgres -- the chain is
 * `Supabase Root 2021 CA` -> `Supabase Intermediate 2021 CA` -> the host -- so
 * the system trust store rejects it and there is nothing to fall back to. The
 * root is pinned instead, in `supabase/certs/prod-ca-2021.crt`, which is the
 * certificate Supabase publishes for exactly this. `servername` is set so the
 * hostname is checked as well as the chain; a valid certificate for the wrong
 * host is as bad as an invalid one.
 *
 * SUPABASE_DB_CA points somewhere else, for a self-hosted Postgres or a rotated
 * root. There is deliberately no way to turn verification off.
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CA = resolve(HERE, "certs/prod-ca-2021.crt");

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
    {
      name: "direct",
      host: `db.${ref}.supabase.co`,
      url: `postgresql://postgres:${pw}@db.${ref}.supabase.co:5432/postgres`,
    },
  ];
  for (const r of REGIONS) {
    for (const host of [`aws-0-${r}`, `aws-1-${r}`]) {
      out.push({
        name: `pooler ${host}`,
        host: `${host}.pooler.supabase.com`,
        url: `postgresql://postgres.${ref}:${pw}@${host}.pooler.supabase.com:5432/postgres`,
      });
    }
  }
  return out;
}

/** The root the chain has to lead back to. Read once, and required. */
function rootCertificate() {
  const path = process.env.SUPABASE_DB_CA ?? CA;
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      `no CA certificate to verify the database against at ${path}. ` +
      "Supabase publishes it as prod-ca-2021.crt (dashboard: Project " +
      "Settings -> Database -> SSL Configuration); point SUPABASE_DB_CA at a " +
      `different one if this project uses another. (${e.message})`);
  }
}

export async function open({ quiet = false } = {}) {
  const e = env();
  const ca = rootCertificate();
  let lastErr;
  for (const c of candidates(e)) {
    const client = new pg.Client({
      connectionString: c.url,
      // The chain AND the name. `servername` matters because the connection
      // string's host is what we resolved, and a certificate is only evidence
      // about the name it was issued for.
      ssl: { ca, rejectUnauthorized: true, servername: c.host },
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
