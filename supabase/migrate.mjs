/**
 * Apply the migrations, in order, once each.
 *
 * Small enough to be obvious: a table of what has run, a transaction per file,
 * and a refusal to re-run one. There is no Supabase CLI or Docker on this
 * machine, so this is the whole migration story -- but it is the same story
 * the CLI tells, and the files are plain SQL either way.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { open } from "./connect.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, "migrations");

const client = await open();
try {
  await client.query(`
    create table if not exists public.schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);

  const done = new Set(
    (await client.query("select name from public.schema_migrations")).rows
      .map((r) => r.name));

  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;
  for (const f of files) {
    if (done.has(f)) { console.log(`  skip  ${f}`); continue; }
    const sql = readFileSync(join(DIR, f), "utf8");
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        "insert into public.schema_migrations (name) values ($1)", [f]);
      await client.query("commit");
      console.log(`  ok    ${f}`);
      ran++;
    } catch (e) {
      await client.query("rollback");
      console.error(`  FAIL  ${f}\n        ${e.message}`);
      process.exit(1);
    }
  }
  console.log(`\n${ran} applied, ${files.length - ran} already there`);
} finally {
  await client.end();
}
