/**
 * The engine facts the training env assumes, checked on every level.
 *
 * bot/fbwg_env.py hard-codes which pools kill which character (the BFS walls),
 * and envserver.ts hard-codes which way each fan blows and what "level
 * complete" means. Those come from reading game.ts; this runs the real engine
 * to prove them, by dropping characters where it matters:
 *
 *   - each character onto one cell of every pool tile code in the level: it
 *     dies exactly when the env's hazard sets say it should
 *   - each character into the OTHER one's door: neither door counts
 *   - both into their own doors: the game's own Recuent fires
 *   - a character into each fan, on versus off: it is pushed the way
 *     DYN_WIND says the fan blows
 *
 * Run by bot/check_env.py; on its own: node engine/dist/bot/envfacts.js
 */
import { level, tickClock } from "../game/game.js";
import { hostLevel } from "../game/headless.js";
import { Event, SoundBus, advanceTree, enterFrameTree } from "../flash/flash.js";
import { applyInput } from "../net/hash.js";
import { b2Vec2 } from "../box2d/box2d.js";
import type { Ported } from "../ported.js";

SoundBus.replaying = true;

const LEVELS: [string, number][] = [
  ...Array.from({ length: 17 }, (_, i) => ["adventure", i + 1] as [string, number]),
  ...Array.from({ length: 9 }, (_, i) => ["puzzle", i + 1] as [string, number]),
  ...Array.from({ length: 6 }, (_, i) => ["speed", i + 1] as [string, number]),
];

/** Mirrors FIRE_HAZARDS / WATER_HAZARDS in bot/fbwg_env.py. */
const POOL: Record<number, string> = {
  5: "water", 51: "water", 52: "water",
  6: "lava", 61: "lava", 62: "lava",
  7: "goo", 71: "goo", 72: "goo",
};
const KILLS: Record<string, string[]> = { fire: ["water", "goo"], water: ["lava", "goo"] };
/** Unit push per fan `vertical`, matching DYN_WIND in envserver.ts. */
const BLOWS: Record<number, [number, number]> = { 1: [0, -1], 2: [1, 0], 3: [0, 1], 4: [-1, 0] };

function step(lv: Ported): void {
  tickClock();
  applyInput(lv, 0);
  advanceTree(lv);
  enterFrameTree(lv);
  lv.Update(new Event(Event.ENTER_FRAME));
}

function fresh(mode: string, num: number): { lv: Ported; host: Ported } {
  const lv: Ported = new (level as Ported)(mode, num);
  const host = hostLevel(lv);
  for (let i = 0; i < 5; i++) step(lv);
  return { lv, host };
}

function put(body: Ported, x: number, y: number): void {
  body.SetXForm(new b2Vec2(x, y), 0);
  body.SetLinearVelocity(new b2Vec2(0, 0));
}

function doors(lv: Ported): { fire: Ported; water: Ported } {
  const out: Record<string, Ported> = {};
  for (let b = lv.m_world.GetBodyList(); b; b = b.GetNext()) {
    const name: string | undefined = b.GetUserData()?.name;
    if (name === "finish1" || name === "finish2") out[name] = b.GetPosition();
  }
  return { fire: out.finish1, water: out.finish2 };
}

let failures = 0;
let checked = 0;
function expect(ok: boolean, what: string): void {
  checked++;
  if (!ok) {
    failures++;
    console.log("FAIL", what);
  }
}

for (const [mode, num] of LEVELS) {
  const name = `${mode} ${num}`;
  const grid: unknown[][] = fresh(mode, num).lv.LevelArray;

  // One cell per tile code, not per kind, so the pool edges (51/52, ...) and
  // middles (5, ...) are each placed on directly.
  const pools = new Map<number, [number, number]>();
  grid.forEach((row, r) => row.forEach((v, c) => {
    if (typeof v === "number" && POOL[v] && !pools.has(v)) pools.set(v, [r, c]);
  }));
  for (const [code, [r, c]] of pools) {
    const kind = POOL[code];
    for (const who of ["fire", "water"]) {
      const { lv } = fresh(mode, num);
      put(who === "fire" ? lv.pers1 : lv.pers2, c, r - 0.6);
      for (let i = 0; i < 25; i++) step(lv);
      const died = who === "fire" ? lv.myContactListener.deadFire : lv.myContactListener.deadWater;
      expect(died === KILLS[who].includes(kind),
             `${name}: ${who} on ${kind} (${code}) died=${died}`);
    }
  }

  {
    const { lv } = fresh(mode, num);
    const d = doors(lv);
    put(lv.pers1, d.water.x, d.water.y - 0.8);
    put(lv.pers2, d.fire.x, d.fire.y - 0.8);
    for (let i = 0; i < 30; i++) step(lv);
    const cl = lv.myContactListener;
    expect(!(cl.finish1 > 0) && !(cl.finish2 > 0), `${name}: the wrong door counted`);
  }

  {
    const { lv, host } = fresh(mode, num);
    const d = doors(lv);
    put(lv.pers1, d.fire.x, d.fire.y - 0.8);
    put(lv.pers2, d.water.x, d.water.y - 0.8);
    for (let i = 0; i < 120 && host.recuents === 0; i++) step(lv);
    expect(host.recuents > 0, `${name}: both in their doors, but no level complete`);
  }

  const fans = (fresh(mode, num).lv.myWinds as Ported[]).length;
  for (let i = 0; i < fans; i++) {
    const { lv } = fresh(mode, num);
    // Every fan, including lever-driven ones. drift() forces `on`, but the wind
    // loop runs before the lever loop in Update, so for those it only holds for
    // the first frame; one frame of push still clears the 0.01 bar.
    const w = lv.myWinds[i];
    const [dx, dy] = BLOWS[w.vertical];
    const x = (w.lower.x + w.upper.x) / 2;
    const y = (w.lower.y + w.upper.y) / 2;
    // Drop Watergirl mid-fan and see which way she drifts, against the same
    // spot with the fan off, since gravity acts on both. Three frames, because
    // a weak fan over a short drop (puzzle 7) lands her on the floor either way
    // by frame six.
    const drift = (on: boolean): [number, number] => {
      const { lv: l } = fresh(mode, num);
      l.myWinds[i].on = on;
      put(l.pers2, x, y);
      for (let k = 0; k < 3; k++) step(l);
      const p = l.pers2.GetPosition();
      return [p.x - x, p.y - y];
    };
    const [onX, onY] = drift(true);
    const [offX, offY] = drift(false);
    const push = (onX - offX) * dx + (onY - offY) * dy;
    expect(push > 0.01, `${name}: fan ${i} (vertical ${w.vertical}) did not push its way (${push.toFixed(3)})`);
  }
}

console.log(`${checked} engine facts checked, ${failures} failed`);
process.exit(failures ? 1 : 0);
