/** Deterministic loading/ownership fixture. No network or browser process required. */
import assert from "node:assert/strict";
import { setMaxListeners } from "node:events";
import { readFile } from "node:fs/promises";
import { assetContentState, assetContentRevision, assetMetrics, configureAssetBudget, createAssetOwner } from "../dist/render/assets.js";
import { prepareLevelAssets } from "../dist/render/levelassets.js";
setMaxListeners(0);
const starts = [], pending = new Map(), failures = new Set();
globalThis.Image = class {
  complete = false; naturalWidth = 0; naturalHeight = 0; onload = null; onerror = null;
  set src(value) {
    this.url = value;
    if (!value) { pending.delete(this.url); return; }
    starts.push(value); pending.set(value, this);
    if (value.includes("auto") || value.startsWith("/soak/")) queueMicrotask(() => load(value, failures.has(value)));
  }
  get src() { return this.url; }
  decode() { return Promise.resolve(); }
};
function load(url, fail = false) {
  const image = pending.get(url); assert.ok(image, `Pending image ${url}`); pending.delete(url);
  if (fail) image.onerror?.();
  else { image.complete = true; image.naturalWidth = 16; image.naturalHeight = 16; image.onload?.(); }
}
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
const jsonResponses = new Map();
globalThis.fetch = (url, { signal }) => {
  const value = jsonResponses.get(url);
  if (value === "hung") return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  return Promise.resolve({ ok: value !== undefined, status: value === undefined ? 404 : 200, json: () => Promise.resolve(value) });
};

configureAssetBudget({ lanes: 1, bytes: 4096, documents: 8 });
const blocker = createAssetOwner(), old = createAssetOwner({ priority: "background" }), live = createAssetOwner({ priority: "critical" });
const block = blocker.image("block").ready;
const obsolete = old.image("obsolete").ready;
const obsoleteFailure = assert.rejects(obsolete, /cancelled/);
const urgent = live.image("urgent").ready;
old.release(); await obsoleteFailure;
load("block"); await block; await flush();
assert.equal(starts.at(-1), "urgent"); assert.ok(!starts.includes("obsolete"));
load("urgent"); await urgent;

const first = createAssetOwner(), second = createAssetOwner();
const shared1 = first.image("shared"), shared2 = second.image("shared");
assert.equal(shared1.image, shared2.image);
const firstFailure = assert.rejects(shared1.ready, /cancelled/);
first.release(); await firstFailure;
assert.equal(assetContentState("shared").state, "pending");
load("shared"); await shared2.ready;
assert.equal(starts.filter(url => url === "shared").length, 1);

const gated = blocker.image("gate").ready;
const expiring = live.image("expires", { deadlineMs: 15 }).ready;
await assert.rejects(expiring, /deadline/);
assert.ok(!starts.includes("expires"));
assert.equal(assetContentState("expires").state, "error");
load("gate"); await gated;
const failed = second.image("retry").ready; load("retry", true);
await assert.rejects(failed, /could not be loaded/);
const failureRevision = assetContentRevision("retry");
const retried = second.image("retry").ready; load("retry"); await retried;
assert.ok(assetContentRevision("retry") > failureRevision);

jsonResponses.set("metadata", "hung");
await assert.rejects(live.json("metadata", { deadlineMs: 15 }), /deadline/);
jsonResponses.set("metadata", { ok: true });
assert.deepEqual(await live.json("metadata"), { ok: true });

const promoted = createAssetOwner({ priority: "background" });
const promotedBlock = blocker.image("promotion-gate").ready;
const promotedWork = promoted.image("promotion").ready;
const afterWork = live.image("after").ready;
promoted.promote("critical"); load("promotion-gate"); await promotedBlock; await flush();
assert.equal(starts.at(-1), "promotion"); load("promotion"); await promotedWork; await flush();
load("after"); await afterWork;

const identity = "a".repeat(64);
jsonResponses.set("/assets/levels.json", { schema: 1, identity, common: { critical: ["auto-shared"] }, levels: {
  "adventure-01": { symbols: [], critical: ["auto-shared", "auto-level"], background: ["auto-later"] },
} });
jsonResponses.set("/assets/sprites.json", { levelDependencies: identity });
const prepared = await prepareLevelAssets("/assets", "adventure", 1);
assert.deepEqual(prepared.critical, { total: 2, ready: 2, failed: 0 });
assert.equal(await prepared.complete, "complete"); assert.equal(prepared.background.total, 1);
prepared.release();
jsonResponses.set("/partial/levels.json", { schema: 1, identity, common: { critical: ["auto-missing"] }, levels: {
  "adventure-01": { symbols: [], critical: [], background: [] },
} });
jsonResponses.set("/partial/sprites.json", {}); failures.add("/partial/auto-missing");
const partial = await prepareLevelAssets("/partial", "adventure", 1);
assert.equal(await partial.complete, "partial"); assert.equal(partial.critical.failed, 1);
failures.delete("/partial/auto-missing");
assert.equal(await partial.retry(), "complete");
assert.deepEqual(partial.critical, { total: 1, ready: 1, failed: 0 }); partial.release();
jsonResponses.set("/atlas/levels.json", { schema: 1, identity, common: { critical: ["auto-atlas"] },
  fallbacks: { "auto-atlas": ["auto-frame1", "auto-frame2"] }, levels: {
  "adventure-01": { symbols: [], critical: [], background: [] },
} });
jsonResponses.set("/atlas/sprites.json", {}); failures.add("/atlas/auto-atlas");
const recovered = await prepareLevelAssets("/atlas", "adventure", 1);
assert.equal(await recovered.complete, "complete");
assert.equal(recovered.critical.total, 1); assert.equal(recovered.critical.ready, 1);
assert.ok(starts.includes("/atlas/auto-frame1") && starts.includes("/atlas/auto-frame2")); recovered.release();
jsonResponses.set("/bad/levels.json", { schema: 1, identity, common: { critical: [] }, levels: {} });
jsonResponses.set("/bad/sprites.json", { levelDependencies: "b".repeat(64) });
await assert.rejects(prepareLevelAssets("/bad", "adventure", 1), /releases disagree/);

for (const owner of [blocker, old, live, first, second, promoted]) owner.release();
configureAssetBudget({ bytes: 1024, documents: 2 });
const metrics = assetMetrics();
assert.equal(metrics.active, 0); assert.equal(metrics.queued, 0); assert.equal(metrics.owners, 0);
assert.ok(metrics.decodedBytes <= 1024); assert.ok(metrics.evictions > 0);
const realManifest = JSON.parse(await readFile(new URL("../../extracted/assets/levels.json", import.meta.url), "utf8"));
jsonResponses.set("/soak/levels.json", realManifest); jsonResponses.set("/soak/sprites.json", {});
let plateau = 0;
for (const key of Object.keys(realManifest.levels)) {
  const cut = key.lastIndexOf("-"), ready = await prepareLevelAssets("/soak", key.slice(0, cut), Number(key.slice(cut + 1)));
  assert.equal(await ready.complete, "complete"); ready.release();
  const retained = assetMetrics(); plateau = Math.max(plateau, retained.decodedBytes);
  assert.equal(retained.owners, 0); assert.equal(retained.active, 0); assert.equal(retained.queued, 0);
  assert.ok(retained.decodedBytes <= 1024, `Cold cache exceeded budget after ${key}`);
}
assert.equal(plateau, 1024);
console.log("ASSET OWNERSHIP, PRIORITY, CANCELLATION, DEADLINES, RETRY, MANIFEST AND BUDGET PASSED", metrics);
console.log("ALL32 LOW-BUDGET NAVIGATION SERVICE PLATEAU PASSED", { retainedDecodedBytes: plateau, note: "Synthetic16px images; native/GPU browser-memory validation remains separate" });
