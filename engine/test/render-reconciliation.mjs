/** Opt-in presentation: real filtered art, immutable simulation, and stalled rollback decay. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { startServer, ROOT } from "./harness.mjs";

const server = await startServer(5194);
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route("http://localhost:5194/presentation-test", route => route.fulfill({
    contentType: "text/html", body: '<!doctype html><canvas tabindex="0"></canvas>',
  }));
  await page.goto("http://localhost:5194/presentation-test");
  const result = await page.evaluate(async () => {
    const [{ Game }, { GameHost }, { SpriteRenderer }, { VisualSnapshots }, { Snapshot }, { GameView }, { MemorySave }] = await Promise.all([
      import("/dist/game/game.js"), import("/dist/net/gamehost.js"), import("/dist/render/sprites.js"),
      import("/dist/render/interpolation.js"), import("/dist/net/snapshot.js"), import("/dist/embed.js"),
      import("/dist/game/save.js"),
    ]);
    const renderer = await SpriteRenderer.load("/extracted/assets");
    const rows = [];
    const canvas = document.querySelector("canvas"); canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext("2d");
    const pose = n => ({ x: n.x, y: n.y, sx: n.scaleX, sy: n.scaleY, rot: n.rotation });
    const equalSnapshot = (before, after) => before.nObj === after.nObj && before.nSlot === after.nSlot && before.nOther === after.nOther &&
      before.objs.every((v, i) => v === after.objs[i]) && before.others.every((v, i) => Object.is(v, after.others[i])) &&
      before.tags.subarray(0, before.nSlot).every((v, i) => v === after.tags[i]) &&
      before.nums.subarray(0, before.nSlot).every((v, i) => Object.is(v, after.nums[i])) &&
      JSON.stringify(before.keys.slice(0, before.nObj)) === JSON.stringify(after.keys.slice(0, after.nObj));
    for (const num of [1, 8]) {
      const game = new Game(), host = new GameHost(game);
      const visuals = new VisualSnapshots({ rollbackSmoothing: true, localDescendantInterpolation: true, now: () => 0 });
      host.start("adventure", num);
      host.step(2, 0); renderer.captureTransforms(game, visuals, 1, false, 0);
      host.step(2, 1); renderer.captureTransforms(game, visuals, 1, false, 0);
      await renderer.prepare(game);
      renderer.draw(ctx, game, visuals, 0.5, 0); visuals.presented(0);
      const character = game.m_level.pers1.m_userData;
      const limb = character.children.find(child => child.visible && child.name?.startsWith("mc_"));
      if (!limb) throw new Error("Expected visible local character pose");
      const oldX = visuals.sample(character, pose(character), 0.5, 0).x;
      // Inject a small authoritative correction before protecting the tree.
      // The renderer must accept this exact state without writing any field.
      character.x += 12; limb.x += 8;
      renderer.captureTransforms(game, visuals, 1, true, 0);
      const before = new Snapshot().capture([game]), digest = host.hash();
      const seen = new Set();
      const guard = n => {
        if (!n || seen.has(n)) return;
        seen.add(n);
        for (const name of ["x", "y", "rotation", "scaleX", "scaleY", "filters", "mask", "isMask", "currentFrame", "visible"]) {
          const d = Object.getOwnPropertyDescriptor(n, name);
          if (d && "value" in d) Object.defineProperty(n, name, { ...d, writable: false });
        }
        for (const child of n.children ?? []) guard(child);
        guard(n.mask); guard(n.bitmapData?.source);
      };
      guard(game);
      const samples = [];
      for (const now of [0, 40, 80]) {
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 640, 480);
        renderer.draw(ctx, game, visuals, 0, now); visuals.presented(now);
        const x = visuals.sample(character, pose(character), 0, now).x;
        samples.push({ now, x, effectRasters: renderer.diagnostics().effectMisses,
          png: canvas.toDataURL("image/png").split(",")[1] });
      }
      rows.push({ level: num, oldX, correctedX: character.x, samples, missing: renderer.missing,
        hashEqual: host.hash() === digest, snapshotEqual: equalSnapshot(before, new Snapshot().capture([game])) });
    }

    // Inject display time independently of simulation time: actual NetSession
    // late-input rollback first, then no simulation advancement during decay.
    let clock = 0, next = 0;
    const queue = new Map();
    window.requestAnimationFrame = callback => { queue.set(++next, callback); return next; };
    window.cancelAnimationFrame = id => queue.delete(id);
    Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
    const tick = dt => {
      clock += dt;
      const callbacks = [...queue.values()]; queue.clear();
      for (const callback of callbacks) callback(clock);
    };
    const view = new GameView({ canvas, assets: "/extracted/assets", save: new MemorySave(),
      rollbackSmoothing: true, localDescendantInterpolation: true });
    view.setMuted(true); await view.prepare(); view.setRunning(false);
    let receive;
    const session = view.join({ send() {}, onMessage(fn) { receive = fn; }, close() {}, rttMs: 0 }, 0);
    session.begin("adventure", 1); await view.prepare();
    const { encodeInput } = await import("/dist/net/protocol.js");
    // The partner's opening input, as a real peer sends the moment it is ready.
    // Under rollback a level runs no frame until it has heard one (session.ts
    // `ready`), so without it the session never leaves frame 0 and the late
    // input below has no past to correct.
    receive(encodeInput({ kind: 1, slot: 1, epoch: session.generation, frame: 0,
      bits: [0], hashFrame: 0, hash: 0 }));
    const remote = view.game.m_level.pers2.m_userData;
    let draws = 0, presentedX = null;
    const draw = view.sprites.draw.bind(view.sprites);
    view.sprites.draw = (context, root, snapshots, alpha) => {
      draw(context, root, snapshots, alpha, clock);
      presentedX = snapshots.sample(remote, pose(remote), alpha, clock).x; draws++;
    };
    view.setRunning(true);
    for (let i = 0; i < 6; i++) tick(40);
    session.acc = 0;
    view.visuals.clear(); view.captureVisuals(); view.render();
    const before = { frame: view.simFrame, x: presentedX, draws };
    // Frames 1 onward were predicted as no keys; the partner was holding right.
    receive(encodeInput({ kind: 1, slot: 1, epoch: session.generation, frame: session.frame - 1,
      bits: Array(session.frame - 1).fill(2), hashFrame: 0, hash: 0 }));
    tick(0);
    const samples = [{ now: 0, x: presentedX, draws }], correctedX = remote.x, digest = view.digest();
    // The session has already performed a real rollback. Isolate stalled
    // presentation without modifying its corrected simulation or advancing it.
    session.tick = () => {};
    for (const now of [20, 40, 60, 80, 100]) {
      tick(20); samples.push({ now, x: presentedX, draws });
    }
    const rollback = { before, correctedX, samples, rollbacks: session.rollbacks, frame: view.simFrame,
      hashEqual: view.digest() === digest, dirty: view.visuals.presentationDirty };
    view.destroy();
    return { rows, rollback };
  });
  const output = resolve(ROOT, ".cache/render-reconciliation");
  await mkdir(output, { recursive: true });
  for (const row of result.rows) {
    assert.equal(row.missing, 0);
    assert.ok(row.hashEqual && row.snapshotEqual, `all simulation fields unchanged, adventure ${row.level}`);
    assert.equal(row.samples[0].x, row.oldX, "first reconciliation draw retains actual presented position");
    assert.equal(row.samples[2].x, row.correctedX, "80 ms draw reaches corrected authoritative position");
    assert.ok(Math.abs(row.samples[1].x - (row.oldX + row.correctedX) / 2) < 1e-8);
    assert.equal(new Set(row.samples.map(sample => sample.effectRasters)).size, 3,
      "filtered local descendant art follows each intermediate visual transform");
    assert.equal(new Set(row.samples.map(sample => sample.png)).size, 3,
      "continuous filtered presentation produces distinct raster output");
    for (const sample of row.samples) {
      const file = resolve(output, `adventure-${row.level}-${sample.now}ms.png`);
      await writeFile(file, Buffer.from(sample.png, "base64"));
      delete sample.png; sample.image = file;
    }
  }
  const { rollback } = result;
  assert.ok(rollback.rollbacks > 0);
  assert.equal(rollback.frame, rollback.before.frame, "same NetSession/frame survives correction and stalled presentation");
  assert.notEqual(rollback.correctedX, rollback.before.x);
  assert.equal(rollback.samples[0].x, rollback.before.x);
  assert.equal(rollback.samples[0].draws, rollback.before.draws + 1);
  assert.equal(rollback.samples[4].x, rollback.correctedX);
  assert.equal(rollback.samples[5].draws, rollback.samples[4].draws, "stationary view stops after residual reaches zero");
  assert.ok(rollback.hashEqual);
  assert.equal(rollback.dirty, false);
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); server.kill(); }
