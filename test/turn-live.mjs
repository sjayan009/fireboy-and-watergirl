/** Opt-in live auth/broker + full forced-TURN pair-session acceptance test. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;
const token = process.env.FBWG_TURN_USER_TOKEN;
if (!url || !key || !token) {
  console.error("Live TURN not run: set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and FBWG_TURN_USER_TOKEN (a signed-in user's access token).");
  process.exit(2);
}
const endpoint = `${url.replace(/\/$/, "")}/functions/v1/turn-credentials`;
for (const authorization of [undefined, "Bearer invalid-test-token"]) {
  const denied = await fetch(endpoint, {
    method: "POST", headers: { apikey: key, ...(authorization ? { Authorization: authorization } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(denied.status, 401, "credential endpoint must reject unauthenticated/forged calls");
}
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: identity, error: authError } = await client.auth.getUser(token);
assert(!authError && identity.user, "test caller must be authenticated");
const issuedBefore = Date.now();
const issued = await fetch(endpoint, {
  method: "POST", headers: { apikey: key, Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(15_000),
});
assert.equal(issued.status, 200, "authenticated issuance must succeed");
assert.equal(issued.headers.get("cache-control"), "no-store");
const credentials = await issued.json();
assert.deepEqual(Object.keys(credentials).sort(), ["expiresAt", "iceServers"]);
assert(Array.isArray(credentials.iceServers) && credentials.iceServers.length > 0);
assert(credentials.expiresAt > Date.now() + 60_000 && credentials.expiresAt <= issuedBefore + (4 * 60 * 60 + 60) * 1000);
assert(credentials.iceServers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/.test(u))));
console.log("Live TURN broker: unauthenticated/forged requests rejected; authenticated short-lived response and no-store verified");
// Child gets short-lived credentials only. Exclude unrelated environment
// secrets and the user's bearer token from the test browser/server processes.
const childEnv = {};
for (const [name, value] of Object.entries(process.env)) {
  if (/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|PLAYWRIGHT_BROWSERS_PATH)$/i.test(name)) childEnv[name] = value;
}
childEnv.FBWG_TEST_TURN_CREDENTIALS = JSON.stringify(credentials);
const test = spawnSync(process.execPath, ["engine/test/webrtc.mjs"], { stdio: "inherit", env: childEnv });
if (test.error) throw new Error("Could not launch the forced-TURN browser test");
process.exit(test.status ?? 1);
