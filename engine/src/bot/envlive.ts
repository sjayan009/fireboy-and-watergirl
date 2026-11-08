/**
 * The env against the whole game, as the website runs it.
 *
 * envfacts.ts checks the env's fields against the engine; this checks that the
 * env's level is the website's level at all, using the code the server runs
 * (envstate.ts buildLevel, firstFrame and frame) on one side and the whole
 * Game, stepped by GameHost (the website's solo step order), on the other.
 * complete and game_over come from each side's own ending calls: the env's
 * HeadlessHost counters, and the Game's real Recuent and GameOver, counted.
 *
 *   - every level: the first frame run with random human keys (the bot sends
 *     nothing in it on the website), then up to 800 frames of random input
 *     given to both, through any death or win to the frame its ending call
 *     fires. hashLevel, every STATE float and the dyn grid agree on every
 *     frame. Between frames a real key event goes to the Game's stage, as the
 *     browser's would: the level's flags change, and the state must not, since
 *     the key fields are the bits the frame ran with. Then the env's snapshot
 *     is restored and a new Game replays the same input: they agree too.
 *   - endings, every level: both characters put in their doors, and Fireboy
 *     put in a pool that kills him (Watergirl in lava where there is none),
 *     stepped through the stairs or death animation: both sides agree every
 *     frame up to and including the one where Recuent or GameOver fires.
 *   - grading, by the Game's own Recuent: the medal timer equals
 *     floor((timecount at won - 1) / 26) seconds (fbwg_env.graded_seconds),
 *     whatever the clock when the level started, and the grade it stores is
 *     the one that rule gives, either side of the time limit, with and without
 *     every diamond, and on a puzzle level with and without the green one.
 *
 * Run by bot/check_env.py; on its own: node engine/dist/bot/envlive.js
 */
import { Game, setClock } from "../game/game.js";
import { Keyboard, KeyboardEvent, SoundBus } from "../flash/flash.js";
import { hashLevel } from "../net/hash.js";
import { GameHost } from "../net/gamehost.js";
import { b2Vec2 } from "../box2d/box2d.js";
import type { Ported } from "../ported.js";
import {
  FIRE_HAZARDS, POOLS, STATE_NAMES, type Built, buildLevel, doorClips, firstFrame, frame, readDyn, readState,
} from "./envstate.js";

SoundBus.replaying = true;

const LEVELS: [string, number][] = [
  ...Array.from({ length: 17 }, (_, i) => ["adventure", i + 1] as [string, number]),
  ...Array.from({ length: 9 }, (_, i) => ["puzzle", i + 1] as [string, number]),
  ...Array.from({ length: 6 }, (_, i) => ["speed", i + 1] as [string, number]),
];
const FRAMES = 800;
const REPLAY = 200;
/** Frames an ending may take from the setup to its Recuent or GameOver. */
const ENDING_FRAMES = 200;
/** The movement keys Game.keyPressed knows, as the browser sends them. */
const KEY_CODES = [Keyboard.LEFT, Keyboard.RIGHT, Keyboard.UP, 65, 68, 87];

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

interface Ends { recuents: number; gameOvers: number }

/** A Game on this level after its first frame, run with `first`, its ending calls counted. */
function liveGame(mode: string, num: number, clock = 0, first = 0): { game: Ported; gh: GameHost; ends: Ends } {
  const game: Ported = new (Game as Ported)();
  const gh = new GameHost(game);
  const ends: Ends = { recuents: 0, gameOvers: 0 };
  const recuent = game.Recuent.bind(game);
  const gameOver = game.GameOver.bind(game);
  game.Recuent = (...a: unknown[]) => { ends.recuents++; return recuent(...a); };
  game.GameOver = (...a: unknown[]) => { ends.gameOvers++; return gameOver(...a); };
  setClock(clock);
  gh.start(mode, num);
  gh.step(first);
  return { game, gh, ends };
}

/** The env's level, built or restored, after its first frame, run with `first`. */
function envLevel(built: Built, first: number): Built {
  firstFrame(built, first);
  return built;
}

const ended = (e: Ends): boolean => e.recuents + e.gameOvers > 0;

/** What differs between the two levels after a frame run with `keys`, or "". */
function differ(a: Ported, aEnds: Ends, b: Ported, bEnds: Ends, keys: number): string {
  if (hashLevel(a) !== hashLevel(b)) return "hash";
  const sa = readState(a, aEnds, doorClips(a), keys);
  const sb = readState(b, bEnds, doorClips(b), keys);
  const k = sa.findIndex((x, i) => !Object.is(x, sb[i]));
  if (k >= 0) return `${STATE_NAMES[k]} ${sa[k]} vs ${sb[k]}`;
  const da = readDyn(a);
  const db = readDyn(b);
  const c = da.findIndex((x, i) => x !== db[i]);
  return c >= 0 ? `dyn cell ${c}` : "";
}

/** A key down or up on the Game's stage, between frames, as the browser sends one. */
function press(game: Ported): void {
  const type = rnd() < 0.5 ? KeyboardEvent.KEY_DOWN : KeyboardEvent.KEY_UP;
  game.stage.dispatchEvent(new KeyboardEvent(type, KEY_CODES[Math.floor(rnd() * KEY_CODES.length)]));
}

/** The level's input flags, packed like applyInput's bits. */
const flags = (lv: Ported): number =>
  (lv.l_pressed ? 1 : 0) | (lv.r_pressed ? 2 : 0) | (lv.u_pressed ? 4 : 0) |
  (lv.l_pressed2 ? 8 : 0) | (lv.r_pressed2 ? 16 : 0) | (lv.u_pressed2 ? 32 : 0);

/** Frames where a key event left the live flags unlike the bits the frame ran with. */
let poked = 0;

/**
 * Run both on `bits` until the input runs out or an ending call fires, which
 * differ compares through complete and game_over. The first difference, or "".
 */
function race(live: { game: Ported; gh: GameHost; ends: Ends }, env: Built, first: number, bits: number[]): string {
  const glv = live.game.m_level;
  let what = differ(glv, live.ends, env.lv, env.host, first);
  if (what) return `at reset: ${what}`;
  for (let f = 0; f < bits.length && !ended(live.ends) && !ended(env.host); f++) {
    live.gh.step(bits[f]);
    frame(env.lv, bits[f]);
    press(live.game);
    if (flags(glv) !== bits[f]) poked++;
    what = differ(glv, live.ends, env.lv, env.host, bits[f]);
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
  const first = Math.floor(rnd() * 64);
  const built = buildLevel(mode, num);
  let what = race(liveGame(mode, num, 0, first), envLevel(built, first), first, bits);
  expect(!what, `${name}: first keys ${first}: the env and the whole game differ ${what}`);
  built.snap.restore();
  what = race(liveGame(mode, num, 0, first), envLevel(built, first), first, bits.slice(0, REPLAY));
  expect(!what, `${name}: after a restore, the env and the whole game differ ${what}`);
}
expect(poked > 0, "no key event between frames ever reached the live level's flags");

/** Every body called `name` (collected diamonds are renamed). */
function bodies(lv: Ported, name: string): Ported[] {
  const out: Ported[] = [];
  for (let b = lv.m_world.GetBodyList(); b; b = b.GetNext()) if (b.GetUserData()?.name === name) out.push(b);
  return out;
}

/** The first cell holding one of `codes`, or undefined. */
function poolCell(lv: Ported, codes: readonly number[]): { x: number; y: number } | undefined {
  const grid: unknown[][] = lv.LevelArray;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (codes.includes(grid[r][c] as number)) return { x: c, y: r };
    }
  }
  return undefined;
}

for (const [mode, num] of LEVELS) {
  const name = `${mode} ${num}`;
  // A level with no pool at all has no death to set up.
  const pools = poolCell(buildLevel(mode, num).lv, [...FIRE_HAZARDS, ...POOLS.lava]);
  for (const ending of pools ? ["win", "death"] : ["win"]) {
    const live = liveGame(mode, num);
    const env = envLevel(buildLevel(mode, num), 0);
    const glv = live.game.m_level;
    for (const lv of [glv, env.lv]) {
      if (ending === "win") {
        put(lv.pers1, bodies(lv, "finish1")[0].GetPosition(), -0.8);
        put(lv.pers2, bodies(lv, "finish2")[0].GetPosition(), -0.8);
      } else {
        const fire = poolCell(lv, FIRE_HAZARDS);
        if (fire) put(lv.pers1, fire, -0.6);
        else put(lv.pers2, poolCell(lv, POOLS.lava)!, -0.6);
      }
    }
    let what = differ(glv, live.ends, env.lv, env.host, 0);
    let f = 0;
    for (; !what && f < ENDING_FRAMES && !(ended(live.ends) && ended(env.host)); f++) {
      live.gh.step(0);
      frame(env.lv, 0);
      what = differ(glv, live.ends, env.lv, env.host, 0);
    }
    const want = ending === "win" ? "recuents" : "gameOvers";
    expect(!what && live.ends[want] === 1 && env.host[want] === 1,
           `${name}: ${ending}: ${what ? `frame ${f}: ${what}` : `no ${want} within ${ENDING_FRAMES} frames`}`);
  }
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
  // Bounded: a level that ends early (a death) stops timecount for good.
  for (let i = 0; lv.timecount < start; i++) {
    if (i > start + 100) throw new Error(`${mode} ${num}: timecount stuck at ${lv.timecount}, wanted ${start}`);
    gh.step(0);
  }
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
