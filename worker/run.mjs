import pg from "pg";
import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { versions } from "./versions.mjs";

if (!process.env.VERIFIER_DATABASE_URL) throw new Error("VERIFIER_DATABASE_URL is required");
const url = new URL(process.env.VERIFIER_DATABASE_URL);
const local = process.env.VERIFIER_LOCAL_FIXTURE === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
// pg connection-string SSL parameters must not replace the verified TLS options.
for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(name);
const ca = readFileSync(process.env.VERIFIER_CA_FILE || new URL("../supabase/certs/prod-ca-2021.crt", import.meta.url), "utf8");
const pool = new pg.Pool({ connectionString: url.href, max: 4, application_name: "fbwg-verifier", connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 10000, ssl: local ? false : { rejectUnauthorized: true, ca } });
const threads = new Set();
let stopping = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (event, fields = {}) => console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));

async function execute(job) {
  const start = Date.now();
  const worker = new Worker(new URL("./replay-slot.mjs", import.meta.url), {
    workerData: { module: versions.get(job.engine), job }, env: {},
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    stdout: true, stderr: true,
  });
  threads.add(worker);
  worker.stdout.resume(); worker.stderr.resume();
  let leaseValid = true;
  let renewing = false;
  const renew = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void pool.query("select play_private.renew_replay($1,$2) as ok", [job.id,job.lease]).then(({ rows }) => {
      if (!rows[0]?.ok) { leaseValid = false; void worker.terminate(); }
    }).catch(() => { leaseValid = false; void worker.terminate(); }).finally(() => { renewing = false; });
  }, 10000);
  const timeout = setTimeout(() => { void worker.terminate(); }, 60000);
  try {
    const outcome = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("Replay process interrupted")));
    });
    if (!stopping && leaseValid) {
      const { rows } = await pool.query("select play_private.finish_replay($1,$2,$3,$4) as ok", [job.id,job.lease,outcome.result,outcome.reason ?? null]);
      log(rows[0]?.ok ? "verification_finished" : "lease_lost", { attempt: job.id, verified: !!outcome.result, duration_ms: Date.now() - start });
    }
  } finally {
    clearTimeout(timeout); clearInterval(renew); threads.delete(worker); await worker.terminate();
  }
}
async function slot(number) {
  while (!stopping) {
    try {
      const { rows } = await pool.query("select * from play_private.claim_replay($1)", [[...versions.keys()]]);
      if (!rows.length) { await sleep(2000); continue; }
      await execute(rows[0]);
    } catch (e) {
      // The durable lease expires; another instance can retry after a crash.
      //
      // The CODE and not the message: the README promises these logs carry no
      // database URLs, and a connection failure's message is largely the host
      // and port it could not reach. A code still separates "nothing is
      // listening" from "the password is wrong" from "the query was refused",
      // which is the difference between the three operational responses --
      // and without it this line said only that something, somewhere, failed.
      log("verification_retry", { slot: number, code: e?.code ?? e?.name ?? "unknown" });
      if (!stopping) await sleep(2000);
    }
  }
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  stopping = true;
  for (const worker of threads) void worker.terminate();
});
log("verifier_started", { slots: 2, versions: [...versions.keys()] });
await Promise.all([slot(0),slot(1)]);
await pool.end();
