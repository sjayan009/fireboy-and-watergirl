/**
 * The env against the whole game, as the website runs it.
 *
 * envfacts.ts checks the env's fields against the engine; this checks that the
 * env's level is the website's level at all, using the code the server runs
 * (envstate.ts buildLevel and frame) on one side and the whole Game, stepped by
 * GameHost (the website's solo step order), on the other:
 *
 *   - every level: the Game's level after its first frame, with no input (the
 *     frame the bot skips on the website), then 800 frames of random input
 *     given to both. hashLevel, every STATE float and the dyn grid agree on
 *     every frame. Then the env's snapshot is restored and a new Game replays
 *     the same input: the restored env agrees with it too.
 *   - grading, by the Game's own Recuent: the medal timer equals
 *     floor((timecount at won - 1) / 26) seconds (fbwg_env.graded_seconds),
 *     whatever the clock when the level started, and the grade it stores is
 *     the one that rule gives, either side of the time limit, with and without
 *     every diamond, and on a puzzle level with and without the green one.
 *
 * Run by bot/check_env.py; on its own: node engine/dist/bot/envlive.js
 */
import { Game, setClock } from "../game/game.js";
import { SoundBus } from "../flash/flash.js";
import { hashLevel } from "../net/hash.js";
import { GameHost } from "../net/gamehost.js";
import { b2Vec2 } from "../box2d/box2d.js";
import type { Ported } from "../ported.js";
import { STATE_NAMES, buildLevel, doorClips, frame, readDyn, readState } from "./envstate.js";

SoundBus.replaying = true;

const LEVELS: [string, number][] = [
  ...Array.from({ length: 17 }, (_, i) => ["adventure", i + 1] as [string, number]),
  ...Array.from({ length: 9 }, (_, i) => ["puzzle", i + 1] as [string, number]),
  ...Array.from({ length: 6 }, (_, i) => ["speed", i + 1] as [string, number]),
];
const FRAMES = 800;
const REPLAY = 200;
/** Neither side's ending counters: the Game keeps its own, not a host's. */
const NO_HOST = { recuents: 0, gameOvers: 0 };

let failures = 0;
let checked = 0;
function expect(ok: boolean, what: string): void {
  checked++;
  if (!ok) {
    failures++;
    console.log("FAIL", what);
  }
}

let seed = 7;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

/** A Game on this level, after the frame the bot skips. */
function liveGame(mode: string, num: number, clock = 0): { game: Ported; gh: GameHost } {
  const game: Ported = new (Game as Ported)();
  const gh = new GameHost(game);
  setClock(clock);
  gh.start(mode, num);
  gh.step(0);
  return { game, gh };
}

/** The first frame where the two levels differ, and what differs, or "". */
function differ(a: Ported, b: Ported): string {
  if (hashLevel(a) !== hashLevel(b)) return "hash";
  const sa = readState(a, NO_HOST, doorClips(a));
  const sb = readState(b, NO_HOST, doorClips(b));
  const k = sa.findIndex((x, i) => !Object.is(x, sb[i]));
  if (k >= 0) return `${STATE_NAMES[k]} ${sa[k]} vs ${sb[k]}`;
  const da = readDyn(a);
  const db = readDyn(b);
  const c = da.findIndex((x, i) => x !== db[i]);
  return c >= 0 ? `dyn cell ${c}` : "";
}

/** Run both on the same input; the frame and field of the first difference. */
function race(glv: Ported, gh: GameHost, lv: Ported, bits: number[]): string {
  let what = differ(glv, lv);
  if (what) return `at reset: ${what}`;
  for (let f = 0; f < bits.length && !glv.pause; f++) {
    gh.step(bits[f]);
    frame(lv, bits[f]);
    what = differ(glv, lv);
    if (what) return `frame ${f + 1}: ${what}`;
  }
  return "";
}

for (const [mode, num] of LEVELS) {
  const name = `${mode} ${num}`;
  const bits: number[] = [];
  for (let held = 0, left = 0; bits.length < FRAMES; left--) {
    if (!left) {
      held = Math.floor(rnd() * 64);
      left = 4 + Math.floor(rnd() * 12);
    }
    bits.push(held);
  }
  const built = buildLevel(mode, num);
  let { game, gh } = liveGame(mode, num);
  let what = race(game.m_level, gh, built.lv, bits);
  expect(!what, `${name}: the env and the whole game differ ${what}`);
  built.snap.restore();
  ({ game, gh } = liveGame(mode, num));
  what = race(game.m_level, gh, built.lv, bits.slice(0, REPLAY));
  expect(!what, `${name}: after a restore, the env and the whole game differ ${what}`);
}

/** Every body called `name` (collected diamonds are renamed). */
function bodies(lv: Ported, name: string): Ported[] {
  const out: Ported[] = [];
  for (let b = lv.m_world.GetBodyList(); b; b = b.GetNext()) if (b.GetUserData()?.name === name) out.push(b);
  return out;
}

function put(body: Ported, at: Ported, dy = 0): void {
  body.SetXForm(new b2Vec2(at.x, at.y + dy), 0);
  body.SetLinearVelocity(new b2Vec2(0, 0));
}

interface Ending {
  t: number;
  seconds: number;
  stored: number;
  allDiamonds: boolean;
  green: boolean;
}

/**
 * Collect the diamonds if asked, idle until timecount reaches `start`, put both
 * characters in their doors, and let the Game finish and grade. `stored` is
 * the grade Recuent writes for the level's map node (3 A, 2 B, 1 C; a puzzle
 * without its green diamond writes nothing, so it stays 0).
 */
function finish(mode: string, num: number, diamonds: boolean, start: number, clock: number): Ending {
  const { game, gh } = liveGame(mode, num, clock);
  const lv = game.m_level;
  game.The_cookie.data.stats[game.cur_node - 1] = 0;
  if (diamonds) {
    for (const [kind, who] of [["rd", lv.pers1], ["bd", lv.pers2], ["gr", lv.pers1]] as const) {
      for (const d of bodies(lv, kind)) {
        put(who, d.GetPosition());
        gh.step(0);
        gh.step(0);
      }
    }
  }
  while (lv.timecount < start) gh.step(0);
  const [fire] = bodies(lv, "finish1");
  const [water] = bodies(lv, "finish2");
  put(lv.pers1, fire.GetPosition(), -0.8);
  put(lv.pers2, water.GetPosition(), -0.8);
  let t = -1;
  for (let i = 0; i < 400 && (t < 0 || i < t + 60); i++) {
    gh.step(0);
    if (t < 0 && lv.getChildByName("ender")) t = lv.timecount;
  }
  const cl = lv.myContactListener;
  return {
    t,
    seconds: parseInt(game.m_timer.mins.text) * 60 + parseInt(game.m_timer.secs.text),
    stored: game.The_cookie.data.stats[game.cur_node - 1],
    allDiamonds: cl.RedCount === lv.RDcount && cl.BlueCount === lv.BDcount,
    green: cl.GreenCount === 1,
  };
}

/** Frames from putting both in their doors to won, for this level. */
function doorDelay(mode: string, num: number): number {
  // liveGame leaves timecount at 1, so this puts them in at 1.
  const e = finish(mode, num, false, 1, 0);
  return e.t - 1;
}

const GRADED = (t: number): number => Math.floor((t - 1) / 26);

for (const [mode, num] of [["adventure", 1], ["speed", 1]] as [string, number][]) {
  const game: Ported = new (Game as Ported)();
  const limit: number = game.TimeTable[game.Translation.indexOf(`${mode === "speed" ? 3 : 1}_${num}`)];
  const delay = doorDelay(mode, num);
  // The last timecount graded within the limit, and the first one past it.
  const last = 26 * limit + 26;
  for (const [diamonds, t, clock] of [
    [true, last, 0], [true, last + 1, 12345], [false, last, 0], [false, last + 1, 7], [true, 300, 0],
  ] as [boolean, number, number][]) {
    const e = finish(mode, num, diamonds, t - delay, clock);
    const want = 1 + (GRADED(e.t) <= limit ? 1 : 0) + (e.allDiamonds ? 1 : 0);
    expect(e.t === t && e.allDiamonds === diamonds,
           `${mode} ${num}: set up won at ${e.t} (wanted ${t}), all diamonds ${e.allDiamonds}`);
    expect(e.seconds === GRADED(e.t),
           `${mode} ${num}: won at timecount ${e.t}, start clock ${clock}: medal timer ${e.seconds} s, ` +
           `floor((t - 1) / 26) = ${GRADED(e.t)}`);
    expect(e.stored === want, `${mode} ${num}: won at ${e.t}, diamonds ${diamonds}: grade ${e.stored}, want ${want}`);
  }
}
for (const green of [true, false]) {
  const e = finish("puzzle", 1, green, 0, 0);
  expect(e.green === green && e.stored === (green ? 3 : 0),
         `puzzle 1: green diamond ${e.green}: grade ${e.stored}, want ${green ? 3 : 0}`);
}

console.log(`${checked} live checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
