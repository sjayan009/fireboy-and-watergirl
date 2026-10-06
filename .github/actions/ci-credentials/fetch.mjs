/**
 * Ask the ci-credentials broker for this job's credentials, with this job's
 * GitHub Actions OIDC token, and export them -- masked -- to the steps after.
 *
 * Node rather than curl and jq so it is the same script on a runner and in
 * `test/ci-credentials-action.mjs`. No dependencies: global fetch only.
 *
 *   BROKER   the function's URL
 *   SCOPES   space-separated: db, api, browserbase
 */
import { appendFileSync } from "node:fs";

const NAMES = { db: "SUPABASE_DB_PASSWORD", api: "SUPABASE_SECRET_KEY", browserbase: "BROWSERBASE_API_KEY" };
const out = (line) => process.stdout.write(line + "\n");
const fail = (message) => { out(`::error::${message}`); process.exit(1); };

const { ACTIONS_ID_TOKEN_REQUEST_URL: tokenUrl, ACTIONS_ID_TOKEN_REQUEST_TOKEN: tokenAuth,
        BROKER: broker, SCOPES = "", GITHUB_ENV: envFile } = process.env;
if (!tokenUrl || !tokenAuth) fail("this job needs 'permissions: id-token: write' to ask the broker");
if (!broker || !envFile) fail("BROKER and GITHUB_ENV must be set");

const scopes = SCOPES.split(/\s+/).filter(Boolean);
for (const s of scopes) if (!(s in NAMES)) fail(`unknown scope ${s}`);

const minted = await fetch(`${tokenUrl}&audience=fbwg-ci-credentials`, {
  headers: { Authorization: `Bearer ${tokenAuth}` }, signal: AbortSignal.timeout(15000),
}).catch((e) => fail(`could not get an OIDC token: ${e.message}`));
if (!minted.ok) fail(`could not get an OIDC token: HTTP ${minted.status}`);
const oidc = (await minted.json()).value;
if (typeof oidc !== "string" || !oidc) fail("GitHub returned no OIDC token");
out(`::add-mask::${oidc}`);

const res = await fetch(broker, {
  method: "POST",
  headers: { Authorization: `Bearer ${oidc}`, "content-type": "application/json" },
  body: JSON.stringify({ scopes }),
  signal: AbortSignal.timeout(20000),
}).catch((e) => fail(`could not reach the broker: ${e.message}`));
const body = await res.json().catch(() => ({}));
// One line: `fail` prints a workflow command, and a newline would start another.
if (res.status !== 200) fail(`ci-credentials answered ${res.status} (${String(body.rule ?? body.error ?? "no detail").replace(/[\r\n]/g, " ")})`);

const credentials = body.credentials ?? {};
const allowed = new Set(Object.values(NAMES));
// Every value is masked before ANY of them is written, and none may carry a
// newline: one would let a value write a second variable into GITHUB_ENV.
for (const [name, value] of Object.entries(credentials)) {
  if (!allowed.has(name)) fail(`unexpected credential ${name}`);
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) fail(`unusable value for ${name}`);
  out(`::add-mask::${value}`);
}
for (const s of scopes) {
  if (!(NAMES[s] in credentials)) fail(`the broker did not grant ${s} to this workflow`);
}
for (const [name, value] of Object.entries(credentials)) appendFileSync(envFile, `${name}=${value}\n`);
out(`credentials for: ${scopes.join(", ")}`);
