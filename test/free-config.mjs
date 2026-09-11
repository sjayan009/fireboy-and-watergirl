import assert from "node:assert/strict";
import { freeIceServers } from "../app/scripts/free-config.mjs";
import { readFileSync } from "node:fs";
import { assertStaticHosting } from "../app/scripts/static-hosting.mjs";
assert.equal(freeIceServers(""), "");
assert.equal(freeIceServers('[{"urls":"stun:stun.l.google.com:19302"}]'), '[{"urls":"stun:stun.l.google.com:19302"}]');
for (const bad of ['null', '{}', '[{}]', '[{"urls":"turn:relay.example"}]', '[{"urls":["stun:host","turns:host"]}]', '[{"urls":"stun:host","credential":"secret"}]', '[{"urls":"https://host"}]']) assert.throws(() => freeIceServers(bad));
console.log("Zero-cost ICE configuration: STUN accepted; TURN, credentials, malformed configuration refused");
const hosting = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"));
assertStaticHosting(hosting);
for (const extra of [{ main: "worker.js" }, { durable_objects: {} }, { r2_buckets: [] }, { env: {} }, { build: { command: "other-build" } }]) {
  assert.throws(() => assertStaticHosting({ ...hosting, ...extra }));
}
for (const extra of [{ run_worker_first: true }, { binding: "ASSETS" }, { not_found_handling: "single-page-application" }, { directory: "." }]) {
  assert.throws(() => assertStaticHosting({ ...hosting, assets: { ...hosting.assets, ...extra } }));
}
console.log("Zero-cost hosting: runtime/bindings/build hooks/source uploads refused; real 404s preserved");
