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
 * Rows written before checksums existed were adopted on the first run after
 * that, and said so. Adoption is not verification -- nothing can retroactively
 * prove what those files contained when they ran -- it is the point from which
 * drift becomes detectable. Every such row has been adopted now, so a row with
 * no checksum is adopted only with `--adopt`: otherwise anything able to write
 * one could make a pending migration be skipped for ever.
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

/** `--adopt`: accept ledger rows that have no checksum as applied. */
const ADOPT = process.argv.includes("--adopt");

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
  // The ledger decides what runs as postgres and what is skipped, and it lives
  // in the API-exposed schema -- where Supabase's default privileges hand anon
  // and authenticated every verb by name. RLS with no policy already refused
  // them on the live project, but only because a platform trigger outside this
  // repository switched it on. Said here, every run, so it is true of any
  // database this runner touches.
  await client.query(
    "alter table public.schema_migrations enable row level security");
  await client.query(
    "revoke all on public.schema_migrations from public, anon, authenticated");

  const done = new Map(
    (await client.query("select name, checksum from public.schema_migrations")).rows
      .map((r) => [r.name, r.checksum]));

  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;
  let adopted = 0;
  const drifted = [];
  const unadopted = [];

  for (const f of files) {
    const sql = readFileSync(join(DIR, f), "utf8");
    const digest = sha(sql);

    if (done.has(f)) {
      const recorded = done.get(f);
      if (recorded === null || recorded === undefined) {
        // A row with no checksum makes its file be skipped without running.
        // That was how pre-checksum rows were adopted, and every one of them
        // has been; a row like that now is either a hand edit or somebody
        // writing to the ledger, so it stops the run unless an operator says
        // otherwise.
        if (!ADOPT) {
          // Stop here rather than carry on: the files after this one were
          // written assuming this one ran, and nothing says it did.
          console.error(`  NULL  ${f} has a ledger row with no checksum`);
          unadopted.push(f);
          break;
        }
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

  if (unadopted.length > 0) {
    console.error(
      `\n${unadopted.length} ledger row(s) have no checksum: ` +
      `${unadopted.join(", ")}.\nNothing ran them under this runner, so they ` +
      "are not adopted automatically. If you cleared the checksum yourself " +
      "after a cosmetic edit, run `npm run db:migrate -- --adopt`.");
    process.exitCode = 1;
  }
  if (drifted.length > 0) {
    console.error(
      `\n${drifted.length} applied migration(s) have been edited since they ` +
      `ran: ${drifted.join(", ")}.\nAn applied migration is history and cannot ` +
      "be rewritten -- put the change in a new file. If the edit is known to " +
      "be cosmetic, clear the recorded checksum for that row by hand and run " +
      "`npm run db:migrate -- --adopt`.");
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
