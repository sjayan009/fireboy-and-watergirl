/**
 * Determinism over a long time, on every level.
 *
 * `determinism.ts` replays 600 frames of one level. `leveldigests.ts` pins
 * 3,000 frames of all 32. Neither would notice drift that takes ten minutes to
 * become visible -- and ten minutes is a perfectly ordinary length for two
 * people to spend on one level of this game.
 *
 * So: every level, 10,000 frames -- about six and a half minutes each, and a
 * little under seven hours of play across the set -- run twice from scratch and
 * compared at every thousandth frame. Comparing at checkpoints rather than only
 * at the end means a divergence reports WHEN it started, which is most of the
 * work of finding it.
 *
 * `verify(true)` is on throughout, so the snapshot's assumption that an
 * object's field names stop changing is checked against every object of every
 * level for the whole run, rather than for the handful of frames the snapshot
 * tests cover.
 */
import { level, resetClock, tickClock } from "./game/game.js";
import { hostLevel } from "./game/headless.js";
import { Event, advanceTree, enterFrameTree, SoundBus } from "./flash/flash.js";
import { hashLevel, applyInput } from "./net/hash.js";
import { Snapshot, verify } from "./net/snapshot.js";
import type { Ported } from "./ported.js";

verify(true);

const LEVELS: [string, number][] = [
  ...Array.from({ length: 17 }, (_, i) => ["adventure", i + 1] as [string, number]),
  ...Array.from({ length: 9 }, (_, i) => ["puzzle", i + 1] as [string, number]),
  ...Array.from({ length: 6 }, (_, i) => ["speed", i + 1] as [string, number]),
];

const FRAMES = Number(process.env.FBWG_SOAK_FRAMES ?? 10000);
const EVERY = 1000;

/** As in leveldigests: deterministic, and different for the two characters. */
function input(f: number): number {
  const a = ((f >> 4) & 1 ? 2 : 0) | ((f >> 6) & 1 ? 1 : 0) |
            (f % 53 === 0 ? 4 : 0);
  const b = ((f >> 5) & 1 ? 1 : 0) | ((f >> 3) & 1 ? 2 : 0) |
            (f % 37 === 0 ? 4 : 0);
  return a | (b << 3);
}

/**
 * One run: the checkpoints, and how many times the level had to be rebuilt.
 *
 * The rebuild is what keeps the run live. Left alone, most levels end inside
 * the first minute and the remaining nine thousand frames soak a frozen world.
 */
function run(mode: string, num: number): { marks: string[]; lives: number } {
  resetClock();
  let lv: Ported = new (level as Ported)(mode, num);
  hostLevel(lv);
  SoundBus.drain();

  const marks: string[] = [];
  let lives = 1;
  for (let f = 0; f < FRAMES; f++) {
    tickClock();
    applyInput(lv, input(f));
    advanceTree(lv);
    enterFrameTree(lv);
    lv.Update(new Event(Event.ENTER_FRAME));
    SoundBus.drain();
    if ((f + 1) % EVERY === 0) marks.push(hashLevel(lv));
    if (lv.ended && f < FRAMES - 1) {
      lv = new (level as Ported)(mode, num);
      hostLevel(lv);
      lives++;
    }
  }
  return { marks, lives };
}

let failures = 0;
const started = Date.now();
let frames = 0;

console.log(`soak: ${LEVELS.length} levels, ${FRAMES} frames each, twice`);

for (const [mode, num] of LEVELS) {
  const first = run(mode, num);
  const second = run(mode, num);
  frames += FRAMES * 2;

  let diverged = -1;
  for (let i = 0; i < first.marks.length; i++) {
    if (first.marks[i] !== second.marks[i]) { diverged = (i + 1) * EVERY; break; }
  }
  const name = `${mode}-${num}`;
  if (diverged < 0) {
    console.log(`  ok   ${name.padEnd(13)} ${first.marks.at(-1)} ` +
                `${first.lives} lives`);
  } else {
    failures++;
    console.log(`  FAIL ${name.padEnd(13)} diverged by frame ${diverged}`);
  }
  if (first.lives !== second.lives) {
    failures++;
    console.log(`  FAIL ${name.padEnd(13)} died a different number of times: ` +
                `${first.lives} then ${second.lives}`);
  }
}

// One snapshot at the end, purely to make the run assert something about the
// thing `verify(true)` was turned on for.
{
  const lv: Ported = new (level as Ported)("adventure", 1);
  const host = hostLevel(lv);
  for (let i = 0; i < 200; i++) {
    tickClock();
    advanceTree(lv);
    enterFrameTree(lv);
    lv.Update(new Event(Event.ENTER_FRAME));
  }
  const foreign = new Snapshot().capture([host]).foreign;
  if (foreign !== 0) {
    failures++;
    console.log(`  FAIL the walk reached ${foreign} host objects`);
  }
}

const secs = (Date.now() - started) / 1000;
console.log(`\n${(frames / 1000).toFixed(0)}k frames in ${secs.toFixed(1)}s ` +
            `(${(frames / secs / 1000).toFixed(0)}k frames/s, ` +
            `${(frames / 26 / 3600).toFixed(1)} hours of play)`);
console.log(failures === 0 ? "SOAK PASSED" : `SOAK FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
