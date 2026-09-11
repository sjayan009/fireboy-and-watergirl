/** Real canvas traversal must not write even temporarily to simulation objects. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startServer } from "./harness.mjs";

const server = await startServer(5193);
let browser;
try {
  // Missing/blocked browsers are a failure, not a successful skipped test.
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("http://localhost:5193/");
  const result = await page.evaluate(async () => {
    const [{ Game }, { GameHost }, { SpriteRenderer }, { VisualSnapshots }, { Snapshot }] = await Promise.all([
      import("/dist/game/game.js"), import("/dist/net/gamehost.js"), import("/dist/render/sprites.js"),
      import("/dist/render/interpolation.js"), import("/dist/net/snapshot.js"),
    ]);
    const renderer = await SpriteRenderer.load("/extracted/assets");
    const results = [];
    for (const num of [1, 8]) {
      const game = new Game(), host = new GameHost(game), visuals = new VisualSnapshots();
      host.start("adventure", num);
      host.step(2, 0); renderer.captureTransforms(game, visuals, 1);
      host.step(2, 1); renderer.captureTransforms(game, visuals, 1);
      await renderer.prepare(game);
      const before = new Snapshot().capture([game]);
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
      const seen = new Set();
      const guard = n => {
        if (!n || seen.has(n)) return;
        seen.add(n);
        // Catch transient mask/filter writes even if a renderer restores them
        // before the final snapshot. Snapshot bookkeeping stays writable.
        for (const name of ["x", "y", "rotation", "scaleX", "scaleY", "filters", "mask", "isMask", "currentFrame", "visible"]) {
          const d = Object.getOwnPropertyDescriptor(n, name);
          if (d && "value" in d) Object.defineProperty(n, name, { ...d, writable: false });
        }
        for (const c of n.children ?? []) guard(c);
        guard(n.mask); guard(n.bitmapData?.source);
      };
      guard(game);
      for (const alpha of [0, 0.25, 0.5, 0.75, 1]) renderer.draw(canvas.getContext("2d"), game, visuals, alpha);
      const after = new Snapshot().capture([game]);
      const equal = before.nObj === after.nObj && before.nSlot === after.nSlot && before.nOther === after.nOther &&
        before.objs.every((v, i) => v === after.objs[i]) && before.others.every((v, i) => Object.is(v, after.others[i])) &&
        before.tags.subarray(0, before.nSlot).every((v, i) => v === after.tags[i]) &&
        before.nums.subarray(0, before.nSlot).every((v, i) => Object.is(v, after.nums[i])) &&
        JSON.stringify(before.keys.slice(0, before.nObj)) === JSON.stringify(after.keys.slice(0, after.nObj));
      results.push({ level: num, equal, objects: after.nObj, slots: after.nSlot, missing: renderer.missing });
    }
    return results;
  });
  for (const row of result) { assert.ok(row.equal, `full snapshot unchanged, adventure ${row.level}`); assert.equal(row.missing, 0); }
  console.log(JSON.stringify(result));
} finally { await browser?.close(); server.kill(); }
