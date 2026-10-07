/**
 * The rollback go/no-go gate.
 *
 * Rollback is only worth building if a snapshot is cheap. The thresholds were
 * set before any code was written, so the decision is made by a measurement
 * rather than by how much work has already been sunk:
 *
 *   under  4 ms  -- snapshot every frame, which is what rollback usually wants
 *   4-15 ms      -- snapshot occasionally and re-simulate the difference
 *   over  15 ms  -- abandon rollback, keep lockstep with an adaptive delay
 *
 * It came out in the middle band, which is what shaped the session: one
 * snapshot rather than a ring, refreshed only when it has drifted eight frames
 * behind the settled frontier. Re-simulating a frame is about a hundred times
 * cheaper than saving one, so rewinding further is the right way to pay.
 *
 * It also checks the thing that actually makes a snapshot correct, which is a
 * stronger claim than "it is fast": restoring it has to put the simulation back
 * so exactly that the NEXT thirty frames evolve identically. `hashLevel` is a
 * divergence detector over the state that tends to drift; a snapshot has to
 * cover everything that influences the future, which is a superset. The only
 * way to know it does is to run the future twice.
 */
import { readFileSync } from "node:fs";
import { Game, level, tickClock, getClock, setClock } from "./game/game.js";
import { hostLevel } from "./game/headless.js";
import { Event, advanceTree, enterFrameTree, SoundBus } from "./flash/flash.js";
import { hashLevel, applyInput } from "./net/hash.js";
import { setSaveStore } from "./game/save.js";
import { GameHost } from "./net/gamehost.js";
import { Snapshot, verify } from "./net/snapshot.js";
import type { Ported } from "./ported.js";

const log = readFileSync(new URL("../scriptlog.txt", import.meta.url), "utf8");
const BITS = log.trim().split(",").map(Number);

/** One simulation step, in the same order both SessionHosts use. */
function step(lv: Ported, bits: number): void {
  tickClock();
  applyInput(lv, bits);
  advanceTree(lv);
  enterFrameTree(lv);
  lv.Update(new Event(Event.ENTER_FRAME));
}

function build(mode: string, num: number) {
  const lv: Ported = new (level as Ported)(mode, num);
  const host = hostLevel(lv);
  return { lv, host };
}

/**
 * The roots of the simulation.
 *
 * The host rather than the level, because the level reaches up through `parent`
 * for GameOver and Recuent and those counters are state too. The clock comes
 * along as a plain number because it lives in a module variable, out of reach
 * of any walk.
 */
function roots(host: Ported): Ported[] {
  return [host];
}

let failures = 0;
function check(what: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ": " + detail : ""}`);
}

// ---- cost ---------------------------------------------------------------

console.log("cost, on adventure 1 after 300 frames of play");
{
  // Measured with verification OFF, because verification re-derives every
  // object's field names with Object.keys -- precisely the work the cache
  // exists to avoid. Leaving it on here would be measuring the check rather
  // than the snapshot. It goes back on for the correctness sections below.
  verify(false);
  const { lv, host } = build("adventure", 1);
  for (let i = 0; i < 300; i++) step(lv, BITS[i % BITS.length]);

  const snap = new Snapshot();
  snap.capture(roots(host));
  const st = snap.stats;
  console.log(`  ${st.objects} objects, ${st.slots} slots, ` +
              `${st.foreign} foreign`);

  // Warm the JIT before measuring; the first capture pays for shape discovery
  // it will never pay again, and reporting that as the per-frame cost would
  // overstate it by an order of magnitude.
  for (let i = 0; i < 20; i++) snap.capture(roots(host));

  const N = 200;
  let t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) snap.capture(roots(host));
  const capture = Number(process.hrtime.bigint() - t) / 1e6 / N;

  for (let i = 0; i < 20; i++) snap.restore();
  t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) snap.restore();
  const restore = Number(process.hrtime.bigint() - t) / 1e6 / N;

  const budget = 1000 / 26;
  console.log(`  capture ${capture.toFixed(3)} ms, ` +
              `restore ${restore.toFixed(3)} ms, ` +
              `against a ${budget.toFixed(1)} ms frame`);
  // What the session actually pays, from the rates the rollback test measures
  // on a hostile link: 0.12 captures and 0.55 restores per frame with input
  // flipping every other frame. Real play holds keys, so it is far less.
  const perFrame = 0.12 * capture + 0.55 * restore;
  console.log(`  about ${perFrame.toFixed(2)} ms a frame in the worst case ` +
              `measured (${(perFrame * 100 / budget).toFixed(1)}% of one), ` +
              `at 0.12 captures and 0.55 restores per frame`);
  check("no host objects reached by the walk", st.foreign === 0,
        `${st.foreign}`);
  check("rollback is viable", capture < 15, `${capture.toFixed(3)} ms`);
  check("and its worst case leaves the frame most of its budget",
        perFrame < budget / 4, `${perFrame.toFixed(2)} ms`);
}

// ---- correctness --------------------------------------------------------

/**
 * Snapshot, run forward recording digests, restore, run forward again.
 *
 * If any digest differs, the snapshot is missing state -- and the failing frame
 * number says how long it took the omission to become visible, which is the
 * first thing worth knowing when hunting it.
 */
function roundTrip(mode: string, num: number, at: number, span: number): string {
  const { lv, host } = build(mode, num);
  for (let i = 0; i < at; i++) step(lv, BITS[i % BITS.length]);

  const snap = new Snapshot().capture(roots(host));
  const clock = getClock();

  const first: string[] = [];
  for (let i = 0; i < span; i++) {
    step(lv, BITS[(at + i) % BITS.length]);
    first.push(hashLevel(lv));
  }

  snap.restore();
  setClock(clock);

  for (let i = 0; i < span; i++) {
    step(lv, BITS[(at + i) % BITS.length]);
    const got = hashLevel(lv);
    if (got !== first[i]) {
      return `diverged ${i + 1} frame(s) after the restore ` +
             `(${got} != ${first[i]})`;
    }
  }
  return "";
}

console.log("\nround trip: restore, then re-run 30 frames and compare");
{
  // A spread of levels and frames rather than one: mechanisms differ by level
  // -- ropes, sliders, rotating platforms, buttons -- and a snapshot that
  // happens to cover level 1 need not cover the one with the gear joints.
  // EVERY level, not a sample. Mechanisms differ by level -- ropes, gear
  // joints, wind, sliders, buttons -- and a snapshot that happens to cover the
  // eight that were checked need not cover the one with the pulleys.
  const cases: [string, number][] = [
    ...Array.from({ length: 17 }, (_, i) => ["adventure", i + 1] as [string, number]),
    ...Array.from({ length: 9 }, (_, i) => ["puzzle", i + 1] as [string, number]),
    ...Array.from({ length: 6 }, (_, i) => ["speed", i + 1] as [string, number]),
  ];
  let bad = 0;
  for (const [mode, num] of cases) {
    for (const at of [1, 17, 60, 133, 240]) {
      const failed = roundTrip(mode, num, at, 30);
      if (failed) { bad++; check(`${mode} ${num} at frame ${at}`, false, failed); }
    }
  }
  check(`all ${cases.length} levels restore exactly`, bad === 0,
        bad ? `${bad} restores diverged` : "");
}

// ---- the clock ----------------------------------------------------------

console.log("\nthe clock is state too");
{
  const { lv, host } = build("adventure", 1);
  for (let i = 0; i < 50; i++) step(lv, BITS[i]);
  const snap = new Snapshot().capture(roots(host));
  const clock = getClock();
  for (let i = 0; i < 20; i++) step(lv, BITS[50 + i]);
  check("the walk does not reach the module-level clock",
        getClock() !== clock);
  snap.restore();
  setClock(clock);
  check("so the session has to put it back itself", getClock() === clock);
}

// ---- sound --------------------------------------------------------------

console.log("\nre-simulation re-emits sound, which the session must suppress");
{
  const { lv, host } = build("adventure", 1);
  for (let i = 0; i < 40; i++) step(lv, BITS[i]);
  const snap = new Snapshot().capture(roots(host));
  const clock = getClock();

  SoundBus.drain();
  for (let i = 0; i < 40; i++) step(lv, BITS[40 + i]);
  const once = SoundBus.drain().length;

  snap.restore();
  setClock(clock);
  for (let i = 0; i < 40; i++) step(lv, BITS[40 + i]);
  const twice = SoundBus.drain().length;

  check("the same frames emit the same sounds both times", once === twice,
        `${once} then ${twice}`);
  console.log(`       ${once} sound event(s) over 40 frames -- every one of ` +
              `them would play a second time without the watermark`);
}

// ---- restoring is a restore, not a lucky replay --------------------------

console.log("\nrestore puts the world back, whatever happens next");
{
  // The round trip above re-runs the SAME input after restoring, which a
  // restore could pass by accident: anything that merely rewound far enough to
  // be re-derived would look identical. Running DIFFERENT input in between
  // removes that -- the second run of A can only match the first if the state
  // it started from was genuinely the state A started from before.
  const { lv, host } = build("adventure", 9);
  for (let i = 0; i < 90; i++) step(lv, BITS[i % BITS.length]);

  const snap = new Snapshot().capture(roots(host));
  const clock = getClock();
  const run = (bits: (i: number) => number, n: number): string => {
    for (let i = 0; i < n; i++) step(lv, bits(i));
    return hashLevel(lv);
  };
  const back = () => { snap.restore(); setClock(clock); };

  const a1 = run((i) => BITS[(90 + i) % BITS.length], 40);
  back();
  const b1 = run(() => 0b010010, 40);           // both walking right
  back();
  const a2 = run((i) => BITS[(90 + i) % BITS.length], 40);
  back();
  const b2 = run(() => 0b010010, 40);

  check("the same input twice gives the same result", a1 === a2, `${a1} ${a2}`);
  check("and so does other input, from the same restored state", b1 === b2,
        `${b1} ${b2}`);
  check("the two inputs really did diverge", a1 !== b1);
}

// ---- the whole Game, not just a level ------------------------------------

console.log("\nthe shell is state too, and none of it is a host object");
{
  // A level is the easy case. The snapshot the browser actually takes covers
  // the entire Game -- menus, pause tray, results board, the save -- and that
  // is where a host object could be hiding.
  const game: Ported = new (Game as Ported)();
  // With a level running, because that is when a snapshot is ever taken and
  // because a Game sitting on its menus is a hundred objects, not a graph.
  new GameHost(game).start("adventure", 1);
  for (let i = 0; i < 60; i++) new GameHost(game).step(0, i, false);
  SoundBus.drain();
  const snap = new Snapshot().capture([game]);
  const st = snap.stats;
  console.log(`  ${st.objects} objects, ${st.slots} fields across the shell`);
  check("nothing the walk reaches is a host object", st.foreign === 0,
        `${st.foreign}`);
  check("and the level is inside it", st.objects > 20000, `${st.objects}`);
}

// ---- the save store ------------------------------------------------------

console.log("\na save store's machinery must not roll back with it");
{
  // A regression test for a bug that cost an hour and produced no error. The
  // store hangs off the Game, so EVERYTHING on it was inside the snapshot. Its
  // progress arrays should be -- a medal awarded on a frame that gets taken
  // back must be taken back too -- but the bookkeeping beside them should not,
  // and a pending timer handle restored to a stale value is a timer that never
  // fires and progress that silently stops being saved.
  let machinery = 0;
  const data = { stats: [1, 2, 3] };
  const store = { data, flush(): void { machinery++; } };
  setSaveStore(() => store);
  const game: Ported = new (Game as Ported)();
  setSaveStore(null);

  const snap = new Snapshot().capture([game]);
  data.stats[0] = 99;
  machinery = 7;
  snap.restore();

  check("the progress arrays are restored", data.stats[0] === 1,
        `${data.stats[0]}`);
  check("the machinery beside them is not", machinery === 7, `${machinery}`);
}

console.log("\n" + (failures === 0
  ? "SNAPSHOT PASSED"
  : `SNAPSHOT FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
