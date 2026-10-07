/** Pure display scheduling contracts; browser raster checks live in test/render-readonly.mjs. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VisualSnapshots, visualAngleDelta, VISUAL_CORRECTION_MS, VISUAL_CORRECTION_LIMIT_PX,
  type VisualCaptureOptions } from "./render/interpolation.js";
import { SpriteRenderer } from "./render/sprites.js";
import { Sprite, TextField } from "./flash/flash.js";
import { Game, resetClock } from "./game/game.js";
import { GameHost } from "./net/gamehost.js";
import type { Ported } from "./ported.js";

const pose = (x = 0, y = 0, rot = 0) => ({ x, y, sx: 1, sy: 1, rot });
const root = Object.freeze({}), local = Object.freeze({}), remote = Object.freeze({});
const s = new VisualSnapshots();
s.begin(); s.capture(local, pose(), root, "predict"); s.capture(remote, pose(), root, "interpolate");
s.begin(); s.capture(local, pose(4), root, "predict"); s.capture(remote, pose(4), root, "interpolate");
assert.equal(s.sample(local, pose(4), 0).x, 4, "local input appears in the same simulation step");
assert.equal(s.sample(local, pose(4), 0.5).x, 6);
assert.equal(s.sample(remote, pose(4), 0.5).x, 2);
assert.equal(s.sample(local, pose(4), 20).x, 8, "prediction is at most one observed step");
assert.equal(s.sample(remote, pose(4), 20).x, 4, "world interpolation never extrapolates during a stall");
s.inputChanged();
assert.equal(s.sample(local, pose(4), 0.5).x, 4, "new/released input immediately cancels stale prediction");
s.begin(); s.capture(local, pose(0), root, "predict");
assert.equal(s.sample(local, pose(0), 0.5).x, 0, "observed reversal snaps instead of continuing old velocity");
s.begin(); s.capture(local, pose(-4), root, "predict");
s.begin(); s.capture(local, pose(-4), root, "predict");
assert.equal(s.sample(local, pose(-4), 0.9).x, -4, "observed collision/stop removes extrapolation");

const correction = new VisualSnapshots();
correction.begin(); correction.capture(remote, pose(0), root, "interpolate");
correction.begin(); correction.capture(remote, pose(10), root, "interpolate");
correction.capture(remote, pose(10), root, "interpolate", true);
assert.equal(correction.presentationDirty, false, "unchanged maintenance does not schedule a correction draw");
assert.equal(correction.sample(remote, pose(10), 0.5).x, 5, "unchanged rollback maintenance preserves interpolation");
correction.capture(remote, pose(30), root, "interpolate", true);
assert.equal(correction.presentationDirty, true, "changed same-frame correction requires presentation");
assert.equal(correction.sample(remote, pose(30), 0).x, 30, "rollback correction publishes only the final corrected state");
correction.presented();
assert.equal(correction.presentationDirty, false, "correction invalidation is consumed by one presentation");
correction.begin(); correction.capture(remote, pose(300), root, "interpolate");
assert.equal(correction.sample(remote, pose(300), 0.5).x, 300, "teleport does not sweep across the level");
correction.begin(); correction.begin(); correction.capture(remote, pose(310), root, "interpolate");
assert.equal(correction.sample(remote, pose(310), 0).x, 310, "a newly visible node has no stale history");
correction.begin(); correction.capture(remote, pose(320), Object.freeze({}), "interpolate");
assert.equal(correction.sample(remote, pose(320), 0).x, 320, "reparented nodes snap");
assert.equal(visualAngleDelta(359, 1), 2);
assert.equal(visualAngleDelta(1, 359), -2);
correction.clear(); correction.begin(); correction.capture(remote, pose(900), root, "interpolate");
assert.equal(correction.sample(remote, pose(900), 0).x, 900, "tab/level reset discards old transforms");

// Virtual monotonic time, with an explicit actual-draw marker. Probes are not
// presentations, and no test waits for a browser timer or wall clock.
let visualNow = 0;
const residual = new VisualSnapshots({ rollbackSmoothing: true, now: () => visualNow });
const show = (snapshots: VisualSnapshots, node: object, x: number, alpha = 0): number => {
  const output = snapshots.sample(node, pose(x), alpha, visualNow);
  const result = output.x;
  snapshots.recordPresented(node, output);
  snapshots.presented(visualNow);
  return result;
};
residual.begin(); residual.capture(remote, pose(), root, "interpolate");
residual.begin(); residual.capture(remote, pose(10), root, "interpolate");
assert.equal(show(residual, remote, 10, 0.5), 5);
residual.capture(remote, pose(30), root, "interpolate", true);
assert.equal(show(residual, remote, 30), 5, "small correction starts at the last actual interpolated draw");
assert.equal(residual.presentationDirty, false);
assert.equal(residual.hasMotion, true, "residual continues drawing during a simulation stall");
visualNow = 20;
residual.capture(remote, pose(30), root, "interpolate", true);
visualNow = 40;
assert.equal(show(residual, remote, 30), 17.5, "unchanged maintenance did not restart the 80 ms decay");
residual.sample(remote, pose(30), 1, 79);
residual.capture(remote, pose(10), root, "interpolate", true);
assert.equal(show(residual, remote, 10), 17.5, "repeat correction uses the last draw, never a hit-test/probe sample");
visualNow = 80;
assert.equal(show(residual, remote, 10), 13.75);
visualNow = 120;
assert.equal(show(residual, remote, 10), 10, "residual settles on corrected state after exactly 80 ms");
assert.equal(residual.hasMotion, true, "normal interpolation retains its existing scheduling state until next capture");
residual.begin(); residual.capture(remote, pose(10), root, "interpolate");
assert.equal(residual.hasMotion, false, "stationary scene stops drawing after the final correction draw");

function correctionCase(dx: number, dy = 0, initial: VisualCaptureOptions = {},
                        changed: VisualCaptureOptions = {}, changedParent: object = root): VisualSnapshots {
  visualNow = 0;
  const snapshots = new VisualSnapshots({ rollbackSmoothing: true, now: () => visualNow });
  snapshots.begin(); snapshots.capture(local, pose(), root, "predict", false, initial);
  show(snapshots, local, 0);
  snapshots.capture(local, pose(dx, dy), changedParent, "predict", true, { ...initial, ...changed });
  return snapshots;
}
assert.equal(VISUAL_CORRECTION_MS, 80);
assert.equal(VISUAL_CORRECTION_LIMIT_PX, 56);
assert.equal(correctionCase(40, 40).sample(local, pose(40, 40), 0).x, 40, "diagonal distance over threshold snaps");
assert.equal(correctionCase(70, 0, { worldScale: 0.8 }).sample(local, pose(70), 0).x, 0,
  "70 local units at level scale 0.8 are within the 56 stage-pixel limit");
assert.equal(correctionCase(71, 0, { worldScale: 0.8 }).sample(local, pose(71), 0).x, 71);
assert.equal(correctionCase(400, 0, { worldScale: 0.108 }).sample(local, pose(400), 0).x, 0,
  "scaled local limb corrections are measured in stage pixels");
for (const [label, initial, changed, parent] of [
  ["identity", { identity: 1 }, { identity: 2 }, root],
  ["revision", { revision: 1 }, { revision: 2 }, root],
  ["death", { state: "alive" }, { state: "dead" }, root],
  ["respawn", { state: "dead" }, { state: "alive" }, root],
  ["explicit teleport", {}, { snap: true }, root],
  ["parent", {}, {}, Object.freeze({})],
] as const) {
  const snapshots = correctionCase(10, 0, initial, changed, parent);
  assert.equal(snapshots.sample(local, pose(10), 0).x, 10, `${label} snaps despite a small correction`);
  assert.equal(snapshots.hasMotion, false, `${label} leaves no residual draw work`);
}
for (const changed of [{ ...pose(10), sx: -1 }, { ...pose(10), sy: 0 }, pose(10, 0, 100)]) {
  const snapshots = correctionCase(5);
  snapshots.capture(local, changed, root, "predict", true);
  assert.deepEqual(snapshots.sample(local, changed, 0), changed, "flip, hidden scale and large rotation remain discrete");
}
const noHistory = new VisualSnapshots({ rollbackSmoothing: true, now: () => 0 });
noHistory.begin(); noHistory.capture(local, pose(), root, "predict");
noHistory.capture(local, pose(10), root, "predict", true);
assert.equal(noHistory.sample(local, pose(10), 0).x, 10, "never smooth from a transform that was not presented");
show(noHistory, local, 10);
noHistory.forget(local);
noHistory.capture(local, pose(20), root, "predict", true);
assert.equal(noHistory.sample(local, pose(20), 0).x, 20, "same-capture hide and respawn cannot reuse visual history");
const advances = correctionCase(10);
visualNow = 40;
advances.begin(); advances.capture(local, pose(14), root, "predict");
assert.equal(advances.sample(local, pose(14), 0).x, 9, "normal corrected simulation advancement retains only presentation error");
visualNow = 80;
assert.equal(advances.sample(local, pose(14), 0.5).x, 16, "prediction resumes from corrected authoritative velocity");
advances.clear();
assert.equal(advances.hasMotion, false);
const slowDraw = correctionCase(10);
slowDraw.beginPresentation(70);
visualNow = 85;
slowDraw.presented();
assert.equal(slowDraw.hasMotion, true, "a draw ending past the deadline still needs its final zero-residual image");
slowDraw.beginPresentation(85);
assert.equal(slowDraw.sample(local, pose(10), 0, 85).x, 10);
slowDraw.presented();
assert.equal(slowDraw.hasMotion, false);

for (const hz of [60, 120, 144, 240]) {
  const snapshots = new VisualSnapshots();
  let frame = 0, lastLocal = NaN, lastRemote = NaN, localUpdates = 0, worldUpdates = 0;
  snapshots.begin(); snapshots.capture(local, pose(), root, "predict"); snapshots.capture(remote, pose(), root, "interpolate");
  for (let display = 1; display <= hz * 3; display++) {
    const clock = display * 26 / hz;
    while (frame < Math.floor(clock)) {
      frame++;
      snapshots.begin(); snapshots.capture(local, pose(frame * 3), root, "predict");
      snapshots.capture(remote, pose(frame * 3), root, "interpolate");
    }
    const alpha = clock - frame;
    const x = snapshots.sample(local, pose(frame * 3), alpha).x;
    const y = snapshots.sample(remote, pose(frame * 3), alpha).x;
    if (x !== lastLocal) localUpdates++;
    if (y !== lastRemote) worldUpdates++;
    lastLocal = x; lastRemote = y;
  }
  assert.equal(frame, 78, `${hz} Hz presentation preserves the 26 Hz authoritative clock`);
  assert.ok(localUpdates > hz * 2.9 && worldUpdates > hz * 2.9, `${hz} Hz presents distinct transforms`);
  console.log(`${hz} Hz: local ${localUpdates / 3}/s, world ${worldUpdates / 3}/s; simulation ${frame / 3}/s`);
}

const manifest = JSON.parse(readFileSync(new URL("../../extracted/assets/sprites.json", import.meta.url), "utf8"));

// Eligibility is local to child transforms: roots respond immediately while
// pose switches, mirrored art, masks and text remain discrete.
const renderer = new SpriteRenderer(manifest, "unused");
const scene = new Sprite(), character = scene.addChild(new Sprite()); character.name = "pers1";
const limb = character.addChild(new Sprite()), mask = character.addChild(new Sprite()); mask.isMask = true;
const label = character.addChild(new TextField());
const descendants = new VisualSnapshots({ localDescendantInterpolation: true, rollbackSmoothing: true, now: () => 0 });
const legacyDescendants = new VisualSnapshots();
for (const snapshots of [descendants, legacyDescendants]) renderer.captureTransforms(scene, snapshots, 1, false, 0);
character.x = 4; limb.x = 4; mask.x = 4; label.x = 4;
for (const snapshots of [descendants, legacyDescendants]) renderer.captureTransforms(scene, snapshots, 1, false, 0);
assert.equal(descendants.sample(character, pose(4), 0.5, 0).x, 6, "local root keeps same-frame prediction");
assert.equal(descendants.sample(limb, pose(4), 0.5, 0).x, 2, "eligible local descendant interpolates its local transform");
assert.equal(legacyDescendants.sample(limb, pose(4), 0.5, 0).x, 4, "rollback switch restores latest-only descendants");
assert.equal(descendants.sample(mask, pose(4), 0.5, 0).x, 4, "mask transforms are discrete");
assert.equal(descendants.sample(label, pose(4), 0.5, 0).x, 4, "text transforms are discrete");
const scaledChild = new VisualSnapshots({ localDescendantInterpolation: true });
scaledChild.begin(); scaledChild.capture(limb, pose(), character, "interpolate", false, { worldScale: 0.108 });
scaledChild.begin(); scaledChild.capture(limb, pose(100), character, "interpolate", false, { worldScale: 0.108 });
assert.equal(scaledChild.sample(limb, pose(100), 0.5, 0).x, 50,
  "descendant interpolation uses stage-scale thresholds independently of rollback smoothing");
limb.visible = false;
renderer.captureTransforms(scene, descendants, 1, true, 0);
limb.visible = true; limb.x = 8;
renderer.captureTransforms(scene, descendants, 1, true, 0);
assert.equal(descendants.sample(limb, pose(8), 0, 0).x, 8, "same-frame semantic pose changes snap on reappearance");
limb.scaleX = -1; limb.x = 12;
renderer.captureTransforms(scene, descendants, 1, false, 0);
assert.equal(descendants.sample(limb, { ...pose(12), sx: -1 }, 0, 0).x, 12, "mirror flips never sweep between poses");

function replay(rendering: boolean): string[] {
  resetClock();
  const game = new (Game as Ported)(), host = new GameHost(game), renderer = new SpriteRenderer(manifest, "unused");
  const visuals = new VisualSnapshots({ rollbackSmoothing: true, localDescendantInterpolation: true, now: () => 0 });
  host.start("adventure", 1);
  const hashes = [];
  for (let frame = 0; frame < 160; frame++) {
    host.step(frame % 16 < 8 ? 2 : 1, frame);
    const before = host.hash();
    if (rendering) {
      renderer.captureTransforms(game, visuals, 3);
      const visit = (n: Ported): void => {
        for (let sample = 0; sample <= 6; sample++) {
          const output = visuals.sample(n, pose(n.x, n.y, n.rotation), sample / 6, frame * 1000 / 26);
          visuals.recordPresented(n, output);
        }
        for (const c of n.children ?? []) visit(c);
      };
      visit(game);
    }
    assert.equal(host.hash(), before, "render sampling cannot mutate a simulation digest");
    hashes.push(before);
  }
  return hashes;
}
assert.deepEqual(replay(true), replay(false), "render snapshots do not change replay outcomes");
console.log("interpolation contracts, high-refresh scheduling and real replay digests passed");
