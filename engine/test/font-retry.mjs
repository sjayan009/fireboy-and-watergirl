/** Partial font failure/deadlines preserve successful faces and stay retryable. */
import assert from "node:assert/strict";
const attempts = new Map(), registered = new Set();
const context = { save() {}, restore() {}, scale() {}, translate() {}, setTransform() {}, clearRect() {}, globalAlpha: 1 };
globalThis.document = {
  fonts: { add(face) { registered.add(face); } },
  createElement() { return { width: 0, height: 0, getContext() { return context; } }; },
};
globalThis.FontFace = class {
  constructor(family) { this.family = family; }
  load() {
    const count = (attempts.get(this.family) ?? 0) + 1; attempts.set(this.family, count);
    if (["swf-font-4902", "swf-font-4922"].includes(this.family) && count === 1) return Promise.reject(new Error("Temporary font failure"));
    if (this.family === "swf-font-4912" && count === 1) return new Promise(() => {});
    return Promise.resolve(this);
  }
};
globalThis.fetch = async url => {
  const stem = url.startsWith("/hung-font-fixture") ? 4910 : url.startsWith("/renderer-font-fixture") ? 4920 : 4900;
  const value = url.endsWith("sprites.json") ? { byName: {}, sprites: {} }
    : url.endsWith("buttons.json") ? { buttons: {}, parts: {} }
    : { [stem + 1]: { file: "good.ttf", name: "Good" }, [stem + 2]: { file: "retry.ttf", name: "Retry" } };
  return { ok: true, async json() { return value; } };
};
const { FontSet } = await import("../dist/render/fonts.js");
const first = await FontSet.load("/font-fixture", 50);
assert.equal(first.missing, 1); assert.equal(registered.size, 1);
const second = await FontSet.load("/font-fixture", 50);
assert.equal(second.missing, 0); assert.equal(registered.size, 2);
assert.equal(attempts.get("swf-font-4901"), 1, "successful faces are not downloaded or registered again");
assert.equal(attempts.get("swf-font-4902"), 2, "failed face retried exactly once");
assert.equal(await FontSet.load("/font-fixture", 50), second, "complete result remains document-cached");
const started = Date.now(), hung = await FontSet.load("/hung-font-fixture", 50);
assert.equal(hung.missing, 1); assert.ok(Date.now() - started < 1000, "hung face reaches a bounded partial result");
const recovered = await FontSet.load("/hung-font-fixture", 50);
assert.equal(recovered.missing, 0); assert.equal(attempts.get("swf-font-4911"), 1);
const { SpriteRenderer } = await import("../dist/render/sprites.js");
const renderer = await SpriteRenderer.load("/renderer-font-fixture");
const settled = async () => {
  const deadline = Date.now() + 1000;
  while (renderer.loading) { assert.ok(Date.now() < deadline, "renderer font preparation settles"); await new Promise(resolve => setTimeout(resolve, 1)); }
};
await settled(); assert.equal(renderer.missing, 1, "renderer reports partial font readiness honestly");
const revision = renderer.revision;
await renderer.prepare({ children: [] }); await settled();
assert.equal(renderer.missing, 0, "explicit reprepare recovers failed faces");
assert.ok(renderer.revision > revision, "font completion schedules a stationary redraw");
assert.equal(attempts.get("swf-font-4921"), 1); assert.equal(attempts.get("swf-font-4922"), 2);
renderer.dispose();
console.log("font partial failure, bounded deadline, successful-face reuse, renderer status/retry passed");
