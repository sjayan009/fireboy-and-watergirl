import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { secretHits, scanClientSecrets } from "../app/scripts/secret-scan.mjs";

async function load(source, replace = (s) => s) {
  const code = ts.transpileModule(replace(readFileSync(new URL(source, import.meta.url), "utf8")), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}
const { createTurnHandler, TURN_TTL_SECONDS } = await load("../supabase/functions/turn-credentials/handler.ts");
const { createRuntimeIceLoader, parseTurnCredentials } = await load("../app/src/net/turn-loader.ts");
const servers = [
  { urls: ["stun:stun.cloudflare.com:3478"] },
  { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
    username: "test-short-lived-user", credential: "test-short-lived-password" },
];
let time = 1_800_000_000_000;
const master = "fake-test-only-master-token-never-a-real-secret";
const env = { CLOUDFLARE_TURN_KEY_ID: "fake-key-id", CLOUDFLARE_TURN_API_TOKEN: master,
  TURN_ALLOWED_ORIGINS: "https://game.example,http://localhost:5174" };
let authCalls = 0, upstreamCalls = 0;
let response = () => Response.json({ iceServers: servers, debug: master });
let charge = async () => "ok";
const handler = createTurnHandler({
  env: (key) => env[key], now: () => time,
  verifyUser: async (token) => { authCalls++; return token === "valid-user-token" ? { id: "user-a" } : null; },
  charge: (token) => charge(token),
  fetch: async (url, init) => {
    upstreamCalls++;
    assert.equal(url, "https://rtc.live.cloudflare.com/v1/turn/keys/fake-key-id/credentials/generate-ice-servers");
    assert.equal(init.headers.Authorization, `Bearer ${master}`);
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), { ttl: 14400 });
    assert.equal(init.redirect, "error");
    return response();
  },
});
function req(token = "valid-user-token", method = "POST", origin = "https://game.example") {
  return new Request("https://project.supabase.co/functions/v1/turn-credentials", {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), origin },
  });
}
assert.equal((await handler(req("", "OPTIONS"))).status, 204);
assert.equal(authCalls, 0);
for (const token of ["", "forged-jwt", "sb_publishable_fake"]) {
  const result = await handler(req(token));
  assert.equal(result.status, 401);
  assert.equal(result.headers.get("cache-control"), "no-store");
}
assert.equal(upstreamCalls, 0, "unverified callers never spend TURN issuance");
assert.equal((await handler(req("valid-user-token", "GET"))).status, 405);
const wrongOrigin = await handler(req("valid-user-token", "POST", "https://untrusted.example"));
assert.equal(wrongOrigin.status, 403);
assert.equal(wrongOrigin.headers.get("access-control-allow-origin"), null);
let result = await handler(req());
assert.equal(result.status, 200);
assert.equal(result.headers.get("access-control-allow-origin"), "https://game.example");
assert.equal(result.headers.get("cache-control"), "no-store");
const credential = await result.json();
assert.deepEqual(credential, { iceServers: servers, expiresAt: time + TURN_TTL_SECONDS * 1000 });
assert(!JSON.stringify(credential).includes(master));

response = () => new Response(master, { status: 500 });
result = await handler(req());
assert.equal(result.status, 502);
assert(!(await result.text()).includes(master));
response = () => { throw new Error(master); };
result = await handler(req());
assert.equal(result.status, 502);
assert(!(await result.text()).includes(master));
response = () => Response.json({ iceServers: [{ urls: "turn:evil.example:3478", username: "x", credential: "y" }] });
assert.equal((await handler(req())).status, 502);
response = () => Response.json({ iceServers: servers });
for (let i = 0; i < 4; i++) assert.equal((await handler(req())).status, 200);
result = await handler(req());
assert.equal(result.status, 429);
assert.equal(result.headers.get("retry-after"), "600");
time += 600_000;
assert.equal((await handler(req())).status, 200);
// The database's budget, which holds across isolates, and its player check.
const before = upstreamCalls;
charge = async () => "refused";
assert.equal((await handler(req())).status, 403, "an account without a profile mints nothing");
charge = async () => "limited";
assert.equal((await handler(req())).status, 429, "over the durable budget");
charge = async () => { throw new Error("database down"); };
assert.equal((await handler(req())).status, 503, "no budget, no credential");
assert.equal(upstreamCalls, before, "none of those reached Cloudflare");
charge = async () => "ok";

const noFetch = async () => { throw new Error("must not fetch"); };
const origins = (key) => key === "TURN_ALLOWED_ORIGINS" ? env.TURN_ALLOWED_ORIGINS : undefined;
const unlisted = createTurnHandler({ env: () => undefined, verifyUser: async () => ({ id: "x" }), charge: async () => "ok", fetch: noFetch });
assert.equal((await unlisted(req())).status, 403, "an unset allowlist admits no browser origin");
const misconfigured = createTurnHandler({ env: origins, verifyUser: async () => ({ id: "x" }), charge: async () => "ok", fetch: noFetch });
assert.equal((await misconfigured(req())).status, 503);
const anonymous = createTurnHandler({ env: origins, verifyUser: async () => ({ id: "x", is_anonymous: true }), charge: async () => "ok", fetch: noFetch });
assert.equal((await anonymous(req())).status, 401);
console.log("TURN broker: verified auth gate, CORS, bounded TTL, generic failures, response allowlist and throttle passed");

const fallback = [{ urls: "stun:stun.l.google.com:19302" }];
let invocations = 0, fail = false;
const loader = createRuntimeIceLoader(async () => {
  invocations++;
  return { data: { iceServers: servers, expiresAt: time + TURN_TTL_SECONDS * 1000 }, error: fail ? new Error("unavailable") : null };
}, () => time);
assert.deepEqual(await Promise.all([loader.load(fallback), loader.load(fallback)]), [servers, servers]);
assert.equal(invocations, 1, "concurrent link attempts share issuance");
const mutable = await loader.load(fallback);
mutable[1].credential = "mutated";
mutable[0].urls.push("stun:injected");
assert.deepEqual(await loader.load(fallback), servers, "callers cannot mutate cached credentials");
time += (4 * 60 - 6) * 60_000;
await loader.load(fallback);
assert.equal(invocations, 1);
time += 60_001;
await loader.load(fallback);
assert.equal(invocations, 2, "refresh five minutes before expiry");
fail = true;
assert.deepEqual(await loader.load(fallback, { forceRefresh: true }), fallback);
assert.deepEqual(await loader.load(fallback), fallback);
assert.equal(invocations, 3, "outage cooldown prevents reconnect stampede");
time += 30_001;
fail = false;
assert.deepEqual(await loader.load(fallback), servers);
assert.equal(invocations, 4);
loader.clear();
await loader.load(fallback);
assert.equal(invocations, 5);
let finish;
const inflight = createRuntimeIceLoader(() => new Promise((resolve) => { finish = resolve; }), () => time);
const waiting = inflight.load(fallback);
inflight.clear();
finish({ data: { iceServers: servers, expiresAt: time + TURN_TTL_SECONDS * 1000 }, error: null });
assert.deepEqual(await waiting, fallback, "sign-out invalidates pending credential response");
const valid = { iceServers: servers, expiresAt: time + TURN_TTL_SECONDS * 1000 };
for (const bad of [null, {}, { ...valid, expiresAt: Infinity }, { ...valid, expiresAt: time },
  { ...valid, expiresAt: time + 49 * 60 * 60_000 }, { ...valid, iceServers: [] },
  { ...valid, iceServers: [{ urls: "turn:relay.example" }] },
  { ...valid, iceServers: [{ urls: "https://relay.example", username: "x", credential: "y" }] },
  { ...valid, iceServers: [{ urls: "turn:relay.example", username: "x", credential: { token: "y" } }] },
  { ...valid, iceServers: [{ urls: "turn:relay.example", username: "x", credential: "y", key: master }] },
  { ...valid, iceServers: [{ urls: "stun:relay.example", credential: "secret" }] },
]) assert.equal(parseTurnCredentials(bad, time), null);
assert(parseTurnCredentials(valid, time));
console.log("Runtime ICE: validation, expiration, cache isolation, concurrent loading, refresh, outage fallback and auth clearing passed");

assert.equal(secretHits("sb_publishable_test_key and turn-credentials").length, 0);
for (const body of ["CLOUDFLARE_TURN_API_TOKEN", "VITE_CLOUDFLARE_TURN_KEY_ID", master,
  "https://rtc.live.cloudflare.com/v1/turn/keys/fake/credentials/generate-ice-servers", "sb_secret_abcdefghijklmnop"]) {
  const hits = secretHits(body, env);
  assert(hits.length > 0);
  assert(!JSON.stringify(hits).includes(master));
}
assert(secretHits(master, { VITE_CLOUDFLARE_TURN_API_TOKEN: `'${master}'` }).length);
const runtimeSource = readFileSync(new URL("../app/src/net/turn.ts", import.meta.url), "utf8");
assert.equal(secretHits(runtimeSource, env).length, 0);
const entry = readFileSync(new URL("../supabase/functions/turn-credentials/index.ts", import.meta.url), "utf8");
assert(entry.includes("client.auth.getUser(token)"));
console.log("Secret scan: master references/values, prefixed CI secrets and old Supabase detectors passed; failure output is redacted");

const fixture = mkdtempSync(join(tmpdir(), "fbwg-turn-scan-"));
const dirs = ["app", "app/src", "app/public", "dist", "dist/assets"].map((p) => join(fixture, p));
for (const dir of dirs) mkdirSync(dir);
const paths = ["app/src/injected.ts", "app/public/injected.svg", "dist/assets/injected.js", "app/vite.config.ts"].map((p) => join(fixture, p));
try {
  for (const file of paths) writeFileSync(file, "safe public fixture");
  assert.equal(scanClientSecrets(fixture, join(fixture, "dist"), env).hits.length, 0);
  for (const file of paths) {
    writeFileSync(file, `const injected = '${master}';`);
    const scan = scanClientSecrets(fixture, join(fixture, "dist"), env);
    assert(scan.hits.some((hit) => hit.includes(file)), "actual source/public/bundle/config scanner must find injected value");
    assert(!JSON.stringify(scan.hits).includes(master), "file scan must not print the leaked value");
    assert(scanClientSecrets(fixture, join(fixture, "dist"), env, { CLOUDFLARE_TURN_API_TOKEN: "different-ci-token-value" }).hits.length,
      "a CI override must not hide a leaked local secret");
    writeFileSync(file, "safe public fixture");
  }
} finally {
  for (const file of paths) unlinkSync(file);
  for (const dir of dirs.reverse()) rmdirSync(dir);
  rmdirSync(fixture);
}
console.log("Secret scan mutation fixtures: literal master injections detected in source, public SVG, production JS and Vite config");
