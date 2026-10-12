import assert from "node:assert/strict";
import { freeIceServers } from "../app/scripts/free-config.mjs";
import { readFileSync } from "node:fs";
import { assertStaticHosting } from "../app/scripts/static-hosting.mjs";
assert.equal(freeIceServers(""), "");
assert.equal(freeIceServers('[{"urls":"stun:stun.l.google.com:19302"}]'), '[{"urls":"stun:stun.l.google.com:19302"}]');
for (const bad of ['null', '{}', '[{}]', '[{"urls":"turn:relay.example"}]', '[{"urls":["stun:host","turns:host"]}]', '[{"urls":"stun:host","credential":"secret"}]', '[{"urls":"https://host"}]']) assert.throws(() => freeIceServers(bad));
for (const field of ["username", "credential", "credentialType", "password", "CLOUDFLARE_TURN_API_TOKEN"]) {
  assert.throws(() => freeIceServers(JSON.stringify([{ urls: "stun:host", [field]: "secret" }])));
}
assert.equal(freeIceServers('[{"urls":["stun:host:3478","stuns:host:5349"]}]'), '[{"urls":["stun:host:3478","stuns:host:5349"]}]');
console.log("Static ICE: STUN accepted; static TURN/credentials refused; short-lived TURN uses the runtime broker");
const hosting = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"));
assertStaticHosting(hosting);
for (const extra of [{ main: "worker.js" }, { kv_namespaces: [] }, { durable_objects: {} }, { r2_buckets: [] }, { env: {} }, { build: { command: "other-build" } }]) {
  assert.throws(() => assertStaticHosting({ ...hosting, ...extra }));
}
for (const extra of [{ run_worker_first: true }, { run_worker_first: ["/"] }, { binding: "OTHER" }, { not_found_handling: "single-page-application" }, { not_found_handling: "404-page" }, { directory: "." }]) {
  assert.throws(() => assertStaticHosting({ ...hosting, assets: { ...hosting.assets, ...extra } }));
}
console.log("Zero-cost hosting: only edge.mjs, for unmatched paths alone; other runtime/bindings/build hooks refused; real 404s preserved");
