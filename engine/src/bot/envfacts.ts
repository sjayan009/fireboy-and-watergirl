/**
 * The engine facts the training env assumes, checked on every level.
 *
 * bot/fbwg_env.py hard-codes which pools kill which character (the BFS walls),
 * and envserver.ts hard-codes which way each fan blows, what "level complete"
 * means, and what the grounded, jump-latch, door and diamond fields read.
 * Those come from reading game.ts; this runs the real engine to prove them,
 * by dropping characters where it matters. The field facts read the STATE
 * floats through envstate.ts's readState, the code that fills the wire, by
 * name, so a field computed wrong or wired to the wrong slot fails here:
 *
 *   - each character onto one cell of every pool tile code in the level: it
 *     dies exactly when the env's hazard sets say it should
 *   - settled at the spawn, both read grounded; dropped into open air, that
 *     character reads not grounded one frame later and the other still does
 *   - one character's Up held from the floor latches that character only, it
 *     stays latched through landing again while Up is still held, and
 *     releasing Up clears it
 *   - each character into the OTHER one's door: neither door counts, and
 *     neither door_open moves off 0
 *   - each character alone into its own door: its door_open climbs in steps
 *     of 1/21 to exactly 1, the other stays 0, and the level does not end
 *   - both into their own doors: both door_open reach 1, then complete
 *   - Fireboy onto a red diamond and Watergirl onto a blue one (adventure,
 *     speed), or either onto a green one (puzzle): that count, and only
 *     that one, reads 1
 *   - a character into each fan, on versus off: it is pushed the way
 *     DYN_WIND says the fan blows
 *   - Fireboy dropped onto each column of the obstacle mask from just above
 *     its top cell, movers in the way removed: for 40 frames his shapes never
 *     cover an obstacle cell's centre, and with the obstacle bodies destroyed
 *     too the same drop covers every one, so the mask's cells are solid and
 *     the obstacle body is what holds him
 *
 * Run by bot/check_env.py; on its own: node engine/dist/bot/envfacts.js
 */
import { level, tickClock } from "../game/game.js";
import { hostLevel } from "../game/headless.js";
import { SoundBus, advanceTree, enterFrameTree } from "../flash/flash.js";
import { applyInput } from "../net/hash.js";
import { b2AABB, b2Vec2 } from "../box2d/box2d.js";
import type { Ported } from "../ported.js";
import { STATE_NAMES, doorClips, obstacleBodies, obstacleMask, readState } from "./envstate.js";

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
/** Each character's Up, in applyInput's bits. */
const UP: Record<string, number> = { fire: 4, water: 32 };
const OTHER: Record<string, string> = { fire: "water", water: "fire" };
/** door_open moves by one door-clip frame in 21 per frame. */
const DOOR_STEPS = 21;
/** A character's shapes reach this far above and below its position (game.ts). */
const HALF_HEIGHT = 0.8;

/** One frame, as envserver.ts and the website run it: Update once, via ENTER_FRAME. */
function step(lv: Ported, bits = 0): void {
  tickClock();
  applyInput(lv, bits);
  advanceTree(lv);
  enterFrameTree(lv);
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

/** The position of the first body called `name`, or undefined. */
function bodyAt(lv: Ported, name: string): Ported | undefined {
  for (let b = lv.m_world.GetBodyList(); b; b = b.GetNext()) {
    if (b.GetUserData()?.name === name) return b.GetPosition();
  }
  return undefined;
}

/** The STATE floats the env would send for this level, by field name. */
function state(lv: Ported, host: Ported): Record<string, number> {
  const f = readState(lv, host, doorClips(lv));
  return Object.fromEntries(STATE_NAMES.map((n, i) => [n, f[i]]));
}

/**
 * A cell with open air on both sides, one row above and two below, so a
 * character placed there has nothing to stand on for at least a frame (speed
 * 6, all slopes and shafts, has no taller gap three cells wide). Tile code 0
 * only: diamond cells hold strings.
 */
function openAir(grid: unknown[][]): [number, number] | undefined {
  for (let r = 1; r + 2 < grid.length; r++) {
    for (let c = 1; c + 1 < grid[0].length; c++) {
      let clear = true;
      for (let rr = r - 1; rr <= r + 2 && clear; rr++) {
        for (let cc = c - 1; cc <= c + 1 && clear; cc++) clear = grid[rr][cc] === 0;
      }
      if (clear) return [r, c];
    }
  }
  return undefined;
}

/** The non-static bodies, characters aside, with a shape overlapping the box. */
function moversIn(lv: Ported, x0: number, y0: number, x1: number, y1: number): Ported[] {
  const out: Ported[] = [];
  const box = new b2AABB();
  for (let b = lv.m_world.GetBodyList(); b; b = b.GetNext()) {
    const name: string | undefined = b.GetUserData()?.name;
    if (b.IsStatic() || name === "pers1" || name === "pers2") continue;
    for (let s = b.GetShapeList(); s; s = s.GetNext()) {
      s.ComputeAABB(box, b.GetXForm());
      const { lowerBound: lo, upperBound: hi } = box;
      if (lo.x < x1 && hi.x > x0 && lo.y < y1 && hi.y > y0) {
        out.push(b);
        break;
      }
    }
  }
  return out;
}

/** True if any of the body's shapes contains the centre of cell (r, c). */
function covers(body: Ported, r: number, c: number): boolean {
  const p = new b2Vec2(c, r);
  for (let s = body.GetShapeList(); s; s = s.GetNext()) {
    if (s.TestPoint(body.GetXForm(), p)) return true;
  }
  return false;
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

  for (const who of ["fire", "water"]) {
    const other = OTHER[who];
    const { lv, host } = fresh(mode, num);
    for (let i = 0; i < 30; i++) step(lv);
    let s = state(lv, host);
    expect(s.fire_grounded === 1 && s.water_grounded === 1, `${name}: settled at the spawn, but not grounded`);
    const air = openAir(grid);
    if (!air) {
      expect(false, `${name}: no open air to drop ${who} into`);
      continue;
    }
    put(who === "fire" ? lv.pers1 : lv.pers2, air[1], air[0]);
    step(lv);
    s = state(lv, host);
    expect(s[`${who}_grounded`] === 0 && s[`${other}_grounded`] === 1,
           `${name}: ${who} dropped into open air at ${air}: ` +
           `${who}_grounded ${s[`${who}_grounded`]}, ${other}_grounded ${s[`${other}_grounded`]}`);
  }

  for (const who of ["fire", "water"]) {
    // One character's Up, held through the jump and the landing: the latch
    // must stay set while grounded again, which is what stops a second jump,
    // and must not show up on the other character.
    const other = OTHER[who];
    const { lv, host } = fresh(mode, num);
    for (let i = 0; i < 30; i++) step(lv);
    step(lv, UP[who]);
    let s = state(lv, host);
    expect(s[`${who}_jump_latched`] === 1 && s[`${other}_jump_latched`] === 0,
           `${name}: ${who}'s Up from the floor: latched ${s.fire_jump_latched}/${s.water_jump_latched}`);
    let held = true;
    let air = false;
    let landed = false;
    for (let i = 0; i < 60; i++) {
      step(lv, UP[who]);
      s = state(lv, host);
      held &&= s[`${who}_jump_latched`] === 1 && s[`${other}_jump_latched`] === 0;
      air ||= s[`${who}_grounded`] === 0;
      landed ||= air && s[`${who}_grounded`] === 1;
    }
    expect(held && landed, `${name}: ${who}'s Up held: latched throughout=${held}, landed again=${landed}`);
    step(lv);
    s = state(lv, host);
    expect(s[`${who}_jump_latched`] === 0, `${name}: releasing ${who}'s Up did not clear the latch`);
  }

  {
    const { lv, host } = fresh(mode, num);
    const d = doors(lv);
    put(lv.pers1, d.water.x, d.water.y - 0.8);
    put(lv.pers2, d.fire.x, d.fire.y - 0.8);
    let moved = false;
    let s = state(lv, host);
    for (let i = 0; i < 30; i++) {
      step(lv);
      s = state(lv, host);
      moved ||= s.fire_door_open !== 0 || s.water_door_open !== 0;
    }
    expect(!(s.finish1 > 0) && !(s.finish2 > 0), `${name}: the wrong door counted`);
    expect(!moved, `${name}: a door_open moved with each character in the wrong door`);
  }

  for (const who of ["fire", "water"]) {
    const other = OTHER[who];
    const { lv, host } = fresh(mode, num);
    const d = doors(lv);
    const door = who === "fire" ? d.fire : d.water;
    put(who === "fire" ? lv.pers1 : lv.pers2, door.x, door.y - 0.8);
    let s = state(lv, host);
    let steps = true;
    let last = 0;
    let otherMoved = false;
    for (let i = 0; i < 60; i++) {
      step(lv);
      s = state(lv, host);
      const k = s[`${who}_door_open`] * DOOR_STEPS;
      steps &&= Math.abs(k - Math.round(k)) < 1e-9 && [0, 1].includes(Math.round(k) - last);
      last = Math.round(k);
      otherMoved ||= s[`${other}_door_open`] !== 0;
    }
    expect(s[`${who}_door_open`] === 1 && steps && !otherMoved && s.complete === 0,
           `${name}: ${who} alone in its door: ${who}_door_open ${s[`${who}_door_open`]}, ` +
           `steps of 1/${DOOR_STEPS}=${steps}, other moved=${otherMoved}, complete=${s.complete}`);
  }

  {
    const { lv, host } = fresh(mode, num);
    const d = doors(lv);
    put(lv.pers1, d.fire.x, d.fire.y - 0.8);
    put(lv.pers2, d.water.x, d.water.y - 0.8);
    let s = state(lv, host);
    let open = false;
    for (let i = 0; i < 120 && s.complete === 0; i++) {
      step(lv);
      s = state(lv, host);
      open ||= s.complete === 0 && s.fire_door_open === 1 && s.water_door_open === 1;
    }
    expect(s.complete === 1 && host.recuents > 0, `${name}: both in their doors, but no level complete`);
    expect(open, `${name}: the level completed before both door_open reached 1`);
  }

  {
    // One diamond of each kind the mode has pins which field it feeds; three
    // frames is too few to fall onto a second one.
    const cases: [string, string, string][] = mode === "puzzle"
      ? [["gr", "fire", "green_count"], ["gr", "water", "green_count"]]
      : [["rd", "fire", "red_count"], ["bd", "water", "blue_count"]];
    for (const [kind, who, field] of cases) {
      const { lv, host } = fresh(mode, num);
      const at = bodyAt(lv, kind);
      if (!at) {
        expect(false, `${name}: no ${kind} diamond`);
        continue;
      }
      put(who === "fire" ? lv.pers1 : lv.pers2, at.x, at.y);
      for (let i = 0; i < 3; i++) step(lv);
      const s = state(lv, host);
      const counts = ["red_count", "blue_count", "green_count"];
      expect(counts.every((c) => s[c] === (c === field ? 1 : 0)),
             `${name}: ${who} on a ${kind} diamond: red ${s.red_count}, blue ${s.blue_count}, green ${s.green_count}`);
    }
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

  {
    // Not "stand him on each cell's centre": a centre can sit a fifth of a
    // tile inside a slope, so placing him there starts him overlapping the
    // solid. Instead drop him onto the column from just above its top
    // obstacle cell and watch the centres below. The seesaw's plank pivots
    // on the base's apex, right where he would land, so movers in the drop's
    // path are destroyed first, in both runs. Destroying the obstacle bodies
    // too and dropping again is the control: the same drop then covers every
    // centre, so 40 frames is long enough and the obstacle body, not some
    // tile under it, is what stops him.
    const mask = obstacleMask(fresh(mode, num).lv);
    const columns = new Map<number, number[]>();
    mask.forEach((v, i) => {
      if (!v) return;
      const c = i % grid[0].length;
      columns.set(c, [...(columns.get(c) ?? []), Math.floor(i / grid[0].length)]);
    });
    for (const [c, rows] of columns) {
      const top = Math.min(...rows);
      const hits = (destroy: boolean): number => {
        const { lv } = fresh(mode, num);
        const y = top - 0.5 - HALF_HEIGHT - 0.05;
        for (const b of moversIn(lv, c - 0.5, y - HALF_HEIGHT, c + 0.5, top - 0.5)) lv.m_world.DestroyBody(b);
        if (destroy) for (const b of obstacleBodies(lv)) lv.m_world.DestroyBody(b);
        put(lv.pers1, c, y);
        const hit = new Set<number>();
        for (let i = 0; i < 40; i++) {
          step(lv);
          for (const r of rows) if (covers(lv.pers1, r, c)) hit.add(r);
        }
        return hit.size;
      };
      const open = top >= 2 && grid[top - 1][c] === 0 && grid[top - 2][c] === 0;
      expect(open, `${name}: no open air above obstacle column ${c} to drop from`);
      if (!open) continue;
      const held = hits(false);
      const fell = hits(true);
      expect(held === 0 && fell === rows.length,
             `${name}: obstacle column ${c} rows ${rows}: covered ${held} centres, ` +
             `${fell} with the obstacles destroyed`);
    }
  }
}

console.log(`${checked} engine facts checked, ${failures} failed`);
process.exit(failures ? 1 : 0);
