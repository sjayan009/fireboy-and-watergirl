/**
 * Apply the migrations, in order, once each.
 *
 * Small enough to be obvious: a table of what has run, a transaction per file,
 * and a refusal to re-run one. There is no Supabase CLI or Docker on this
 * machine, so this is the whole migration story -- but it is the same story
 * the CLI tells, and the files are plain SQL either way.
 *
 * ## Two things a filename cannot tell you
 *
 * The ledger held a name and nothing else, which makes two failures invisible.
 *
 * The first is drift. Edit an applied file -- fix a typo in a policy, tighten a
 * predicate, "just this once" -- and the runner skips it forever and reports
 * everything as up to date. The schema and the source then disagree with no
 * signal anywhere, which for an authorization migration means the repository
 * says one thing and the database enforces another. So every applied file is
 * recorded with the SHA-256 of its contents and checked against it on every
 * run; a changed file is a hard failure with the two digests printed.
 *
 * Rows written before checksums existed are adopted on the first run after
 * this, and say so. Adoption is not verification -- nothing can retroactively
 * prove what those files contained when they ran -- it is the point from which
 * drift becomes detectable.
 *
 * The second is concurrency. The runner read the completed set once and then
 * worked through the pending files, so two runners started together -- the
 * nightly and a deploy, or either and somebody at a terminal -- both saw the
 * same file as pending and both ran it. A session-level advisory lock makes
 * the whole run exclusive: the second waits, then finds nothing to do.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { open } from "./connect.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, "migrations");

/**
 * The lock every entry point takes, so there is only ever one migrator.
 *
 * A constant rather than a hash of anything, because the two halves have to
 * agree across processes that share no code but this file, and a number written
 * down is easier to find than a number computed.
 */
const LOCK_KEY = 728_401_553;

const sha = (s) => createHash("sha256").update(s).digest("hex");

const client = await open();
let locked = false;
try {
  // Session level, not transaction level: it has to span every file, and each
  // file is its own transaction.
  await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
  locked = true;

  await client.query(`
    create table if not exists public.schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
  // Added rather than assumed: this runs against databases whose ledger predates
  // checksums entirely.
  await client.query(
    "alter table public.schema_migrations add column if not exists checksum text");

  const done = new Map(
    (await client.query("select name, checksum from public.schema_migrations")).rows
      .map((r) => [r.name, r.checksum]));

  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;
  let adopted = 0;
  const drifted = [];

  for (const f of files) {
    const sql = readFileSync(join(DIR, f), "utf8");
    const digest = sha(sql);

    if (done.has(f)) {
      const recorded = done.get(f);
      if (recorded === null || recorded === undefined) {
        await client.query(
          "update public.schema_migrations set checksum = $2 where name = $1",
          [f, digest]);
        console.log(`  adopt ${f}`);
        adopted++;
      } else if (recorded !== digest) {
        console.error(`  DRIFT ${f}`);
        console.error(`        applied ${recorded}`);
        console.error(`        on disk ${digest}`);
        drifted.push(f);
      } else {
        console.log(`  skip  ${f}`);
      }
      continue;
    }

    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        "insert into public.schema_migrations (name, checksum) values ($1, $2)",
        [f, digest]);
      await client.query("commit");
      console.log(`  ok    ${f}`);
      ran++;
    } catch (e) {
      await client.query("rollback");
      console.error(`  FAIL  ${f}\n        ${e.message}`);
      process.exitCode = 1;
      break;
    }
  }

  if (drifted.length > 0) {
    console.error(
      `\n${drifted.length} applied migration(s) have been edited since they ` +
      `ran: ${drifted.join(", ")}.\nAn applied migration is history and cannot ` +
      "be rewritten -- put the change in a new file. If the edit is known to " +
      "be cosmetic, clear the recorded checksum for that row by hand.");
    process.exitCode = 1;
  } else if (process.exitCode !== 1) {
    console.log(`\n${ran} applied, ${files.length - ran} already there` +
                (adopted ? `, ${adopted} adopted into the checksum ledger` : ""));
  }
} finally {
  // Released explicitly rather than by disconnecting, so a pooled connection
  // handed back to somebody else does not carry the lock with it.
  if (locked) {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY])
      .catch(() => { /* the session is going anyway */ });
  }
  await client.end();
}
