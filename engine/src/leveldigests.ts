/**
 * What every level does, pinned.
 *
 * `determinism.ts` pins ONE level against one recorded log, which catches a
 * change to the physics core but says nothing about the mechanisms only some
 * levels have: the pulleys in adventure 8, the gear joints, the wind, the
 * sliding platforms, the buttons and levers. A change to any of those is
 * invisible until somebody plays that level.
 *
 * So: all 32 levels, each driven by the same deterministic input for 3,000
 * frames -- about two minutes of play each -- with the digest checked against a
 * value in version control. Any change to Box2D, the Flash shim, the generated
 * game or the trig kernels moves one of these, and the diff says which levels
 * and therefore which mechanism.
 *
 * The input is generated rather than recorded because a recorded log is a log
 * of somebody playing ONE level. This is not trying to be realistic; it is
 * trying to touch every mechanism the level has and be identical every time.
 *
 * Wandering blindly into lava is also part of playing, so the level is REBUILT
 * whenever it ends. Without that, most levels died inside the first minute and
 * the remaining two thousand frames pinned the digest of a frozen world -- the
 * test still passed, and had stopped testing anything. Rebuilding keeps all
 * 3,000 frames live, and exercises the retry path 32 more times while it is
 * there.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { level, resetClock, tickClock } from "./game/game.js";
import { hostLevel } from "./game/headless.js";
import { Event, advanceTree, enterFrameTree, SoundBus } from "./flash/flash.js";
import { hashLevel, applyInput } from "./net/hash.js";
import type { Ported } from "./ported.js";

const GOLDEN = fileURLToPath(new URL("../test/leveldigests.json", import.meta.url));

const LEVELS: [string, number][] = [
  ...Array.from({ length: 17 }, (_, i) => ["adventure", i + 1] as [string, number]),
  ...Array.from({ length: 9 }, (_, i) => ["puzzle", i + 1] as [string, number]),
  ...Array.from({ length: 6 }, (_, i) => ["speed", i + 1] as [string, number]),
];

const FRAMES = 3000;

/**
 * Both characters wandering, on different cycles, with jumps.
 *
 * Deliberately not random: an LCG in JavaScript loses precision past 2^53 and
 * would produce a different log on a different host, which looks exactly like a
 * physics divergence and is not one.
 */
function input(f: number): number {
  const a = ((f >> 4) & 1 ? 2 : 0) | ((f >> 6) & 1 ? 1 : 0) |
            (f % 53 === 0 ? 4 : 0);
  const b = ((f >> 5) & 1 ? 1 : 0) | ((f >> 3) & 1 ? 2 : 0) |
            (f % 37 === 0 ? 4 : 0);
  return a | (b << 3);
}

let failures = 0;
const fresh: Record<string, string> = {};
const golden: Record<string, string> | null = existsSync(GOLDEN)
  ? JSON.parse(readFileSync(GOLDEN, "utf8"))
  : null;

console.log(`all 32 levels, ${FRAMES} frames each`);

for (const [mode, num] of LEVELS) {
  resetClock();
  const lv: Ported = new (level as Ported)(mode, num);
  const host = hostLevel(lv);
  // The bus is a module-level queue; left to fill it would grow for the whole
  // run and tell us nothing.
  SoundBus.drain();

  let checkpoint = "";
  let lives = 1;
  let live = lv;
  let shell = host;
  for (let f = 0; f < FRAMES; f++) {
    tickClock();
    applyInput(live, input(f));
    advanceTree(live);
    enterFrameTree(live);
    live.Update(new Event(Event.ENTER_FRAME));
    if (f === 999) checkpoint = hashLevel(live);
    SoundBus.drain();

    // `ended` covers both dying and finishing. Either way the world stops
    // moving, so carry on in a fresh one.
    if (live.ended && f < FRAMES - 1) {
      live = new (level as Ported)(mode, num);
      shell = hostLevel(live);
      lives++;
    }
  }

  const name = `${mode}-${num}`;
  // Two points, not one: a run pinned only at the end would still pass if the
  // first two thirds of it had gone quietly wrong and been rebuilt away.
  const sig = `${checkpoint}/${hashLevel(live)}`;
  fresh[name] = sig;

  const ended = lives > 1 ? ` ${lives} lives` : "";
  const over = shell.gameOvers ? ` ${shell.gameOvers} game over(s)` : "";
  if (!golden) {
    console.log(`  ${name.padEnd(13)} ${sig}${ended}${over}`);
    continue;
  }
  const want = golden[name];
  const ok = want === sig;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(13)} ${sig}` +
              (ok ? `${ended}${over}` : ` (expected ${want})`));
}

if (!golden) {
  writeFileSync(GOLDEN, JSON.stringify(fresh, null, 1) + "\n");
  console.log(`\nrecorded ${Object.keys(fresh).length} digests to ` +
              `engine/test/leveldigests.json`);
  process.exit(0);
}

console.log("\n" + (failures === 0
  ? "LEVEL DIGESTS PASSED"
  : `LEVEL DIGESTS FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
