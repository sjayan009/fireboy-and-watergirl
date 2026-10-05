/**
 * The CI credential broker, against tokens signed the way GitHub signs them.
 *
 * A real RSA key pair stands in for GitHub's: the handler gets its public half
 * as the JWKS and every token below is genuinely signed with the private half,
 * so the signature check is exercised rather than mocked. Then each rule is
 * broken one at a time -- the branch, the repository, the workflow file, the
 * event, the audience, the age -- and must refuse.
 */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import ts from "typescript";

async function load(source) {
  const code = ts.transpileModule(readFileSync(new URL(source, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}
const broker = await load("../supabase/functions/ci-credentials/handler.ts");
const { createCiHandler, decide, AUDIENCE, GITHUB_ISSUER, REPOSITORY, REPOSITORY_ID, OWNER_ID } = broker;

const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "test-key" };
const stranger = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const NOW = 1_800_000_000;

async function sign(claims, { kid = "test-key", alg = "RS256", key = pair.privateKey } = {}) {
  const head = b64(JSON.stringify({ alg, kid, typ: "JWT" }));
  const body = b64(JSON.stringify(claims));
  if (alg === "none") return `${head}.${body}.`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(new Uint8Array(sig))}`;
}

/** What GitHub puts in a `deployed` run's token on main. */
const workflow = (file, ref = "refs/heads/main") => `${REPOSITORY}/.github/workflows/${file}@${ref}`;
function main(file = "deployed.yml", extra = {}) {
  return {
    iss: GITHUB_ISSUER, aud: AUDIENCE, iat: NOW - 5, nbf: NOW - 5, exp: NOW + 300,
    repository: REPOSITORY, repository_id: REPOSITORY_ID, repository_owner_id: OWNER_ID,
    ref: "refs/heads/main", ref_type: "branch", event_name: "push",
    runner_environment: "github-hosted",
    workflow_ref: workflow(file), job_workflow_ref: workflow(file),
    run_id: "1", run_attempt: "1",
    ...extra,
  };
}

const secrets = {
  FBWG_CI_DB_PASSWORD: "fake-db-password-for-tests",
  FBWG_CI_SECRET_KEY: "fake-secret-key-for-tests",
  FBWG_CI_BROWSERBASE_API_KEY: "fake-browserbase-key",
};
const lines = [];
let refreshed = 0;
const handler = createCiHandler({
  env: (name) => secrets[name],
  keys: async (refresh) => { if (refresh) refreshed++; return [publicJwk]; },
  now: () => NOW * 1000,
  log: (line) => lines.push(line),
});
const call = async (token, body, method = "POST") => {
  const res = await handler(new Request("https://x.supabase.co/functions/v1/ci-credentials", {
    method, headers: token === null ? {} : { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: res.status, body: await res.json().catch(() => null), cache: res.headers.get("cache-control") };
};

// ---- what main gets --------------------------------------------------------
let r = await call(await sign(main("deployed.yml")));
assert.equal(r.status, 200);
assert.equal(r.cache, "no-store");
assert.deepEqual(r.body.credentials, {
  SUPABASE_DB_PASSWORD: secrets.FBWG_CI_DB_PASSWORD, SUPABASE_SECRET_KEY: secrets.FBWG_CI_SECRET_KEY,
});
r = await call(await sign(main("full.yml", { event_name: "schedule" })), { scopes: ["db"] });
assert.deepEqual(Object.keys(r.body.credentials), ["SUPABASE_DB_PASSWORD"], "a job gets only what it asks for");
r = await call(await sign(main("network-hosted.yml", { event_name: "workflow_dispatch" })));
assert.deepEqual(Object.keys(r.body.credentials), ["SUPABASE_SECRET_KEY"], "the hosted gate never sees the database password");
// A reusable workflow is judged as itself, not as the release gate that called it.
r = await call(await sign(main("play-release.yml", { event_name: "workflow_dispatch", job_workflow_ref: workflow("network-remote.yml") })));
assert.deepEqual(Object.keys(r.body.credentials).sort(), ["BROWSERBASE_API_KEY", "SUPABASE_SECRET_KEY"]);
r = await call(await sign(main("network-remote.yml")), { scopes: ["db"] });
assert.deepEqual(r.body.credentials, {}, "asking for more than the file may have gets nothing extra");

// ---- what a branch gets, however its workflow file was edited ---------------
const refusals = [
  ["a branch run", main("full.yml", { ref: "refs/heads/feature", workflow_ref: workflow("full.yml", "refs/heads/feature"), job_workflow_ref: workflow("full.yml", "refs/heads/feature") }), "ref"],
  ["a branch run that claims main in nothing it controls", main("full.yml", { ref: "refs/heads/net/realtime-hardening" }), "ref"],
  ["main's ref with a branch's workflow file", main("full.yml", { workflow_ref: workflow("full.yml", "refs/heads/feature") }), "workflow_ref"],
  ["main calling a reusable workflow from a branch", main("play-release.yml", { job_workflow_ref: workflow("network-remote.yml", "refs/heads/feature") }), "job_workflow_ref"],
  ["a tag", main("deployed.yml", { ref: "refs/tags/v1", ref_type: "tag" }), "ref"],
  ["a pull request", main("deployed.yml", { event_name: "pull_request" }), "event_name"],
  ["pull_request_target", main("deployed.yml", { event_name: "pull_request_target" }), "event_name"],
  ["a fork with the same name", main("deployed.yml", { repository_id: "999" }), "repository_id"],
  ["a renamed lookalike", main("deployed.yml", { repository: "someone/fireboy-and-watergirl" }), "repository"],
  ["a different owner", main("deployed.yml", { repository_owner_id: "1" }), "repository_owner_id"],
  ["a self-hosted runner", main("deployed.yml", { runner_environment: "self-hosted" }), "runner_environment"],
  ["a workflow with no credentials", main("fast.yml"), "no credentials for fast.yml"],
  ["another repository's workflow", main("deployed.yml", { workflow_ref: `someone/else/.github/workflows/deployed.yml@refs/heads/main` }), "workflow_ref"],
];
for (const [what, claims, rule] of refusals) {
  r = await call(await sign(claims));
  assert.equal(r.status, 403, what);
  assert.equal(r.body.rule, rule, what);
  assert.equal(JSON.stringify(r.body).includes("fake-"), false, `${what}: no secret in a refusal`);
}

// ---- tokens that are not GitHub's, or not for us, or not now ----------------
const forged = [
  ["no token", null],
  ["garbage", "not.a.jwt"],
  ["alg none", await sign(main(), { alg: "none" })],
  ["HS256", await sign(main(), { alg: "HS256" })],
  ["signed by somebody else", await sign(main(), { key: stranger.privateKey })],
  ["an unknown key id", await sign(main(), { kid: "other" })],
  ["the wrong audience", await sign(main("deployed.yml", { aud: "sts.amazonaws.com" }))],
  ["the wrong issuer", await sign(main("deployed.yml", { iss: "https://evil.example" }))],
  ["expired", await sign(main("deployed.yml", { exp: NOW - 1 }))],
  ["minted long ago", await sign(main("deployed.yml", { iat: NOW - 3600, exp: NOW + 300 }))],
  ["from the future", await sign(main("deployed.yml", { iat: NOW + 600 }))],
];
for (const [what, token] of forged) {
  r = await call(token);
  assert.equal(r.status, 401, what);
}
assert.ok(refreshed >= 1, "an unknown kid triggers one fresh look at the keys");
const tampered = (await sign(main("deployed.yml"))).split(".");
tampered[1] = b64(JSON.stringify(main("deployed.yml", { ref: "refs/heads/main", extra: 1 })));
assert.equal((await call(tampered.join("."))).status, 401, "a re-encoded payload fails the signature");

assert.equal((await call(await sign(main()), undefined, "GET")).status, 405);

// ---- a broker that is missing a secret says so, without leaking the others --
const half = createCiHandler({ env: (n) => (n === "FBWG_CI_DB_PASSWORD" ? undefined : secrets[n]), keys: async () => [publicJwk], now: () => NOW * 1000, log: () => {} });
const res = await half(new Request("https://x/", { method: "POST", headers: { authorization: `Bearer ${await sign(main())}` } }));
assert.equal(res.status, 500);
assert.equal((await res.text()).includes("fake-"), false);

// ---- and nothing it logs is a secret ------------------------------------
assert.equal(lines.some((l) => l.includes("fake-")), false, "secrets never reach the log");
assert.ok(lines.some((l) => l.startsWith("ci-credentials issued")));
assert.equal(decide(main("deployed.yml")).scopes.join(), "db,api");

// ---- the action's script, end to end, against the real handler ------------
//
// A local server plays both parts: GitHub's token endpoint, minting a token
// signed with the test key for whatever claims the case sets, and the broker,
// answering with the REAL handler. The script then runs exactly as a runner
// would run it, and what it wrote to GITHUB_ENV and stdout is inspected.
let mintClaims = main("deployed.yml");
let liveSecrets = { ...secrets };
const served = createCiHandler({
  env: (name) => liveSecrets[name], keys: async () => [publicJwk],
  now: () => Date.now(), log: () => {},
});
const server = createServer(async (req, res) => {
  if (req.url.startsWith("/token")) {
    const audience = new URL(req.url, "http://x").searchParams.get("audience");
    const now = Math.floor(Date.now() / 1000);
    const token = await sign({ ...mintClaims, aud: audience, iat: now - 1, nbf: now - 1, exp: now + 300 });
    res.end(JSON.stringify({ value: token }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const answer = await served(new Request("http://x/broker", {
    method: req.method, headers: req.headers, body: Buffer.concat(chunks),
  }));
  res.statusCode = answer.status;
  res.end(await answer.text());
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const script = new URL("../.github/actions/ci-credentials/fetch.mjs", import.meta.url);

async function action(scopes) {
  const dir = mkdtempSync(join(tmpdir(), "ci-credentials-"));
  const envFile = join(dir, "env");
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [fileURLToPath(script)], {
      env: { ...process.env, ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/token?x=1`,
             ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
             BROKER: `${base}/broker`, SCOPES: scopes, GITHUB_ENV: envFile },
    }, (error, stdout) => resolve({ code: error ? error.code : 0, stdout }));
  });
  let exported = "";
  try { exported = readFileSync(envFile, "utf8"); } catch { /* nothing written */ }
  rmSync(dir, { recursive: true, force: true });
  return { ...result, exported };
}

let a = await action("db api");
assert.equal(a.code, 0, a.stdout);
assert.equal(a.exported,
  `SUPABASE_DB_PASSWORD=${secrets.FBWG_CI_DB_PASSWORD}\nSUPABASE_SECRET_KEY=${secrets.FBWG_CI_SECRET_KEY}\n`);
const firstMask = a.stdout.indexOf(`::add-mask::${secrets.FBWG_CI_DB_PASSWORD}`);
assert.ok(firstMask >= 0, "every value is masked");
assert.equal(a.stdout.replace(/::add-mask::.*\n/g, "").includes("fake-"), false,
  "and appears nowhere else in the log");

mintClaims = main("full.yml", { ref: "refs/heads/feature" });
a = await action("db");
assert.equal(a.code, 1);
assert.equal(a.exported, "", "a branch run gets nothing written");
assert.match(a.stdout, /ci-credentials answered 403 \(ref\)/);

mintClaims = main("network-hosted.yml");
a = await action("db");
assert.equal(a.code, 1, "asking for a scope the file may not have fails the job");
assert.equal(a.exported, "");

mintClaims = main("deployed.yml");
liveSecrets = { ...secrets, FBWG_CI_DB_PASSWORD: "line-one\nSUPABASE_SECRET_KEY=injected" };
a = await action("db api");
assert.equal(a.code, 1, "a value with a newline is refused");
assert.equal(a.exported, "", "before anything is written");
server.close();

console.log(`CI CREDENTIALS PASSED: main-only, file-pinned, signature-checked (${refusals.length} rule refusals, ${forged.length + 1} token refusals), and the action script end to end`);
