/** Pure display scheduling contracts; browser raster checks live in test/render-readonly.mjs. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VisualSnapshots, visualAngleDelta } from "./render/interpolation.js";
import { SpriteRenderer } from "./render/sprites.js";
import { Game, resetClock } from "./game/game.js";
import { GameHost } from "./net/gamehost.js";

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
function replay(rendering: boolean): string[] {
  resetClock();
  const game = new (Game as any)(), host = new GameHost(game), renderer = new SpriteRenderer(manifest, "unused");
  const visuals = new VisualSnapshots();
  host.start("adventure", 1);
  const hashes = [];
  for (let frame = 0; frame < 160; frame++) {
    host.step(frame % 16 < 8 ? 2 : 1, frame);
    const before = host.hash();
    if (rendering) {
      renderer.captureTransforms(game, visuals, 3);
      const visit = (n: any): void => {
        for (let sample = 0; sample <= 6; sample++) visuals.sample(n, pose(n.x, n.y, n.rotation), sample / 6);
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
