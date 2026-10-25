/** Exercise the real GameView accumulator/input/snapshot wiring at virtual display rates. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startServer } from "./harness.mjs";

const server = await startServer(5192);
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route("http://localhost:5192/virtual-display", route => route.fulfill({
    contentType: "text/html", body: '<!doctype html><canvas tabindex="0"></canvas>',
  }));
  await page.goto("http://localhost:5192/virtual-display");
  const { rows, rollback, caps } = await page.evaluate(async () => {
    const [{ GameView }, { GameHost }, { MemorySave }] = await Promise.all([
      import("/dist/embed.js"), import("/dist/net/gamehost.js"), import("/dist/game/save.js"),
    ]);
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
    const rows = [];
    for (const hz of [60, 120, 144, 240]) {
      for (const smoothing of [false, true]) {
        clock = 0;
        const view = new GameView({ canvas: document.querySelector("canvas"), assets: "/extracted/assets", save: new MemorySave(), smoothing });
        view.setMuted(true); await view.prepare(); view.setRunning(false);
        new GameHost(view.game).start("adventure", 1); await view.sprites.prepare(view.game);
        const character = view.game.m_level.pers1.m_userData;
        const transforms = [], hashes = [];
        let response = null, inputAt = null, initialX = null, draws = 0, lastVisualX = null;
        // Keep the real render() and snapshot arguments, replace only raster
        // traversal so this test checks schedules without faking frame costs.
        view.sprites.draw = (_ctx, _root, snapshots, alpha) => {
          const real = { x: character.x, y: character.y, sx: character.scaleX, sy: character.scaleY, rot: character.rotation };
          const visual = snapshots ? snapshots.sample(character, real, alpha) : real;
          lastVisualX = visual.x; draws++;
          if (inputAt !== null && response === null && character.x > initialX + 0.001) {
            response = { simFrame: view.simFrame, elapsed: clock - inputAt, real: character.x, visual: visual.x };
          }
        };
        view.setRunning(true);
        const started = clock;
        const pressAt = Math.ceil(hz / 4), releaseAt = Math.ceil(hz * 0.5);
        for (let display = 1; display <= hz; display++) {
          if (display === pressAt) {
            initialX = character.x; inputAt = clock;
            dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
          }
          if (display === releaseAt) dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
          tick(1000 / hz);
          hashes.push(view.digest());
          if (display > pressAt + 2 && display < releaseAt) transforms.push(lastVisualX);
        }
        const unique = new Set(transforms.map(x => Math.round(x * 1e6))).size;
        dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        tick(1000 / 26);
        const beforeThrottle = view.simFrame;
        tick(500);
        const firstResume = { steps: view.simFrame - beforeThrottle, real: character.x, visual: lastVisualX };
        for (let i = 0; i < 10; i++) tick(1000 / hz);
        const beforeLongThrottle = view.simFrame;
        tick(1500);
        const longResume = { steps: view.simFrame - beforeLongThrottle, real: character.x, visual: lastVisualX };
        dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
        rows.push({ hz, smoothing, elapsed: clock - started, response, unique, samples: transforms.length, draws, hashes, firstResume, longResume });
        view.destroy();
      }
    }
    const caps = [];
    for (const cap of [0, 30, 60, 120, 144, 240]) {
      clock = 0;
      const canvas = document.querySelector("canvas");
      const view = new GameView({ canvas, assets: "/extracted/assets", save: new MemorySave(),
        presentationFps: cap, outputScale: 2 });
      view.setMuted(true); await view.prepare(); view.setRunning(false);
      new GameHost(view.game).start("adventure", 1); await view.sprites.prepare(view.game);
      let draws = 0;
      view.sprites.draw = () => { draws++; };
      view.setRunning(true); dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      const hashes = [];
      for (let i = 0; i < 240; i++) { tick(1000 / 240); hashes.push(view.digest()); }
      dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
      caps.push({ cap, draws, hashes, frame: view.simFrame, width: canvas.width, height: canvas.height });
      view.destroy();
    }
    // Actual late-input rollback with no elapsed display time. A previous
    // frame with no motion must still publish a correction, even when the
    // session has no accumulator budget for a normal simulation step.
    clock = 0;
    const corrected = new GameView({ canvas: document.querySelector("canvas"), assets: "/extracted/assets", save: new MemorySave() });
    corrected.setMuted(true); await corrected.prepare(); corrected.setRunning(false);
    let receive;
    const session = corrected.join({ send() {}, onMessage(fn) { receive = fn; }, close() {}, rttMs: 0 }, 0);
    session.begin("adventure", 1); await corrected.prepare();
    const { encodeInput } = await import("/dist/net/protocol.js");
    // The partner's opening input, as a real peer sends the moment it is ready.
    // Under rollback a level runs no frame until it has heard one (session.ts
    // `ready`), so without it the session never leaves frame 0 and the late
    // input below has no past to correct.
    receive(encodeInput({ kind: 1, slot: 1, epoch: session.generation, frame: 0,
      bits: [0], hashFrame: 0, hash: 0 }));
    const remote = corrected.game.m_level.pers2.m_userData;
    let correctionDraws = 0, presentedX = null;
    corrected.sprites.draw = (_ctx, _root, snapshots, alpha) => {
      const real = { x: remote.x, y: remote.y, sx: remote.scaleX, sy: remote.scaleY, rot: remote.rotation };
      presentedX = snapshots.sample(remote, real, alpha).x; correctionDraws++;
    };
    corrected.setRunning(true);
    for (let i = 0; i < 6; i++) tick(40);
    session.acc = 0;
    // Seed an explicitly stationary last presentation without changing any
    // game state, emulating a frame whose transforms had already settled.
    corrected.visuals.clear(); corrected.captureVisuals(); corrected.render();
    const beforeCorrection = { frame: corrected.simFrame, x: remote.x, draws: correctionDraws,
      motion: corrected.visuals.hasMotion, dirty: corrected.visuals.presentationDirty };
    // Frames 1 onward were predicted as no keys; the partner was holding right.
    receive(encodeInput({ kind: 1, slot: 1, epoch: session.generation, frame: session.frame - 1,
      bits: Array(session.frame - 1).fill(2), hashFrame: 0, hash: 0 }));
    tick(0);
    const rollback = { before: beforeCorrection, frame: corrected.simFrame, realX: remote.x, presentedX,
      drawDelta: correctionDraws - beforeCorrection.draws, rollbacks: session.rollbacks,
      dirtyAfterPresentation: corrected.visuals.presentationDirty };
    tick(0);
    rollback.extraDraws = correctionDraws - beforeCorrection.draws - rollback.drawDelta;
    corrected.destroy();
    return { rows, rollback, caps };
  });
  for (const hz of [60, 120, 144, 240]) {
    const exact = rows.find(r => r.hz === hz && !r.smoothing), smooth = rows.find(r => r.hz === hz && r.smoothing);
    assert.deepEqual(smooth.hashes, exact.hashes, `${hz} Hz real view simulation unchanged`);
    assert.ok(smooth.response && exact.response, `${hz} Hz received local input`);
    assert.equal(smooth.response.simFrame, exact.response.simFrame, "input visible in identical simulation frame");
    assert.equal(smooth.response.elapsed, exact.response.elapsed, "input visible in identical display callback");
    assert.ok(smooth.response.visual >= smooth.response.real, "local presentation never trails the first response");
    assert.ok(smooth.unique > exact.unique, `${hz} Hz has more distinct controlled-character transforms`);
    for (const resume of [smooth.firstResume, smooth.longResume]) {
      assert.ok(resume.steps <= 5, "throttle recovery stays within the existing simulation work budget");
      assert.equal(resume.visual, resume.real, "throttle resume snaps to current state");
    }
    console.log(`${hz} Hz: distinct local samples ${exact.unique} -> ${smooth.unique}; input ${smooth.response.elapsed.toFixed(2)}ms at same sim frame ${smooth.response.simFrame}; 500/1500ms throttle bounded`);
  }
  assert.equal(rollback.before.motion, false);
  assert.equal(rollback.before.dirty, false);
  assert.ok(rollback.rollbacks > 0, "late remote input triggered real rollback");
  assert.equal(rollback.frame, rollback.before.frame, "correction required no normal simulation step");
  assert.notEqual(rollback.realX, rollback.before.x, "rollback changed the remote character position");
  assert.equal(rollback.presentedX, rollback.realX, "same-frame stationary correction presented immediately");
  assert.equal(rollback.drawDelta, 1, "correction caused one real GameView render");
  assert.equal(rollback.dirtyAfterPresentation, false);
  assert.equal(rollback.extraDraws, 0, "correction invalidation is consumed after presentation");
  console.log("same-frame late-input rollback presented exactly once with zero accumulator");
  for (const row of caps) {
    assert.deepEqual(row.hashes, caps[0].hashes, `${row.cap} FPS cap leaves every simulation digest unchanged`);
    assert.equal(row.frame, caps[0].frame, "cap never changes fixed-step count");
    assert.equal(row.width, 1280); assert.equal(row.height, 960);
    assert.ok(row.draws > 0 && row.draws <= (row.cap || 240) + 1, "local draw count respects configured cap");
    console.log(`${row.cap || "display"} FPS cap: ${row.draws} local draws, ${row.frame} shared simulation frames, 1280x960 output`);
  }
} finally { await browser?.close(); server.kill(); }
