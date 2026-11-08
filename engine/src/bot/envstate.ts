/**
 * One env's STATE floats, dyn grid and OP_INFO obstacle mask, read from a live
 * level, and the constants bot/fbwg_env.py must agree with.
 *
 * envserver.ts sends these over the wire and envfacts.ts checks them against
 * the engine, so the facts test the very numbers the bot sees, field by field.
 * A module of its own because envserver.ts starts reading stdin on import.
 * The field meanings are documented in envserver.ts's header.
 */
import { b2AABB, b2Vec2 } from "../box2d/box2d.js";
import type { Ported } from "../ported.js";

export const ROWS = 29;
export const COLS = 39;
export const LEVER_SLOTS = 12;
export const PUSHER_SLOTS = 12;
/** Puzzle 4 has the most moving bodies, 22. */
export const MOVER_SLOTS = 24;
export const MOVER_FIELDS: readonly string[] = ["x", "y", "angle", "vx", "vy", "spin"];

export const DYN_MOVING = 1;
export const DYN_RED = 2;
export const DYN_BLUE = 4;
export const DYN_GREEN = 8;
export const DYN_WIND_UP = 16;
export const DYN_WIND_RIGHT = 32;
export const DYN_WIND_DOWN = 64;
export const DYN_WIND_LEFT = 128;
/** The dyn bit for a fan's `vertical`, 1 up, 2 right, 3 down, 4 left (game.ts). */
export const DYN_WIND = [0, DYN_WIND_UP, DYN_WIND_RIGHT, DYN_WIND_DOWN, DYN_WIND_LEFT];
/** The unit push each wind bit stands for, in world units (y grows down). */
export const WIND_PUSH: Readonly<Record<number, [number, number]>> = {
  [DYN_WIND_UP]: [0, -1], [DYN_WIND_RIGHT]: [1, 0], [DYN_WIND_DOWN]: [0, 1], [DYN_WIND_LEFT]: [-1, 0],
};

/** Pool tile codes in LevelArray, by kind: edges and middles. */
export const POOLS: Readonly<Record<string, readonly number[]>> = {
  water: [5, 51, 52], lava: [6, 61, 62], goo: [7, 71, 72],
};
/** The tile codes that kill each character; fbwg_env.py's sets must equal these. */
export const FIRE_HAZARDS: readonly number[] = [...POOLS.water, ...POOLS.goo];
export const WATER_HAZARDS: readonly number[] = [...POOLS.lava, ...POOLS.goo];

/**
 * The STATE floats, in wire order: the one place the order is written down.
 * bot/fbwg_env.py's STATE_FIELDS must equal it; bot/check_env.py checks.
 */
export const STATE_NAMES: readonly string[] = [
  "fire_x", "fire_y", "fire_vx", "fire_vy",
  "water_x", "water_y", "water_vx", "water_vy",
  "fire_grounded", "water_grounded", "fire_jump_latched", "water_jump_latched",
  "dead_fire", "dead_water", "finish1", "finish2",
  "fire_door_open", "water_door_open",
  "red_count", "blue_count", "green_count",
  "timecount", "complete", "game_over", "won",
  ...Array.from({ length: LEVER_SLOTS }, (_, i) => `lever${i}`),
  ...Array.from({ length: PUSHER_SLOTS }, (_, i) => `pusher${i}`),
  ...Array.from({ length: MOVER_SLOTS }, (_, i) => MOVER_FIELDS.map((f) => `mover${i}_${f}`)).flat(),
];
export const STATE_FLOATS = STATE_NAMES.length;

/** How far a button sinks before the game counts it as pressed. */
const PRESSED = 0.25;
/** The door clips' last frame: fully open. */
const DOOR_OPEN = 22;

/** The fire and water door clips. Restores keep the same objects. */
export function doorClips(lv: Ported): Ported[] {
  return ["finish1", "finish2"].map((n) => lv.SlidersAndRots.getChildByName(n));
}

/**
 * 1 if the next frame's jump check will find ground under this character.
 *
 * The game's own rule (game.ts Update, allowjump1/2): the most negative
 * contact normal y in the character's stack, under -0.2. Not lv.allowjump1/2:
 * Update computes those at its top, from the stack the previous Step left, so
 * after a frame they describe its start. Only the world Step (or a teleport)
 * changes the stacks, and nothing runs one between the end of this frame and
 * the next frame's check.
 */
function grounded(stack: Ported[]): number {
  let y = 0;
  for (const n of stack) if (n.y < y) y = n.y;
  return y < -0.2 ? 1 : 0;
}

/**
 * The static bodies the characters collide with that the tile grid leaves out:
 * today only the seesaw's triangular base (game.ts CreatRoman), twice in
 * adventure 10 and once in speed 5. Matched by what they are, not by the
 * RomanBase class, so any other static prop a level builds shows up too. Left
 * out: the world's ground body (no shapes), "ground", which holds the tiles
 * LevelArray already has, and the doors, whose plates sit in the floor tile
 * under the door cell that OP_INFO already sends. Diamonds are static too, but
 * their only shape is a sensor, whatever the name ("FUCK" once collected), so
 * obstacleMask's sensor rule drops them.
 */
export function obstacleBodies(lv: Ported): Ported[] {
  const out: Ported[] = [];
  const world = lv.m_world.GetGroundBody();
  for (let b = lv.m_world.GetBodyList(); b; b = b.GetNext()) {
    const name: string | undefined = b.GetUserData()?.name;
    if (!b.IsStatic() || b === world || name === "ground" || name === "finish1" || name === "finish2") continue;
    out.push(b);
  }
  return out;
}

/**
 * Row-major, 1 for every cell whose centre lies inside a non-sensor shape of
 * an obstacleBodies body. The shape's own point test, not its bounding box:
 * the seesaw base is a triangle 2 wide and 2 tall, whose box would mark six
 * cells where the solid covers the centres of two.
 */
export function obstacleMask(lv: Ported): Uint8Array {
  const rows = lv.LevelArray.length;
  const cols = lv.LevelArray[0].length;
  const out = new Uint8Array(rows * cols);
  const p = new b2Vec2(0, 0);
  for (const b of obstacleBodies(lv)) {
    for (let s = b.GetShapeList(); s; s = s.GetNext()) {
      if (s.IsSensor()) continue;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          p.Set(c, r);
          if (s.TestPoint(b.GetXForm(), p)) out[r * cols + c] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * The bodies that move, characters aside: every non-static body, in the world's
 * body list order (newest first; play creates and destroys none, and a restore
 * keeps the same objects, so a slot is the same body all episode). Slides,
 * platforms, rotators, pulleys, boxes, balls, the seesaw plank, and the lever
 * and button bodies. The same set the dyn grid paints as DYN_MOVING.
 */
export function movers(lv: Ported): Ported[] {
  const out: Ported[] = [];
  for (let b = lv.m_world.GetBodyList(); b; b = b.GetNext()) {
    const name: string | undefined = b.GetUserData()?.name;
    if (!b.IsStatic() && name !== "pers1" && name !== "pers2") out.push(b);
  }
  return out;
}

const EDGE = 1e-6;

/** OR `bit` into every cell the box overlaps, edges touching aside. */
function paint(out: Uint8Array, bit: number, x0: number, y0: number, x1: number, y1: number): void {
  // Bounds often sit on half-cells (a tile is c-0.5..c+0.5), and Math.round
  // takes c+0.5 up into the next cell; nudge both ends inward.
  const r0 = Math.max(0, Math.round(y0 + EDGE));
  const r1 = Math.min(ROWS - 1, Math.round(y1 - EDGE));
  const c0 = Math.max(0, Math.round(x0 + EDGE));
  const c1 = Math.min(COLS - 1, Math.round(x1 - EDGE));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) out[r * COLS + c] |= bit;
  }
}

const DIAMONDS: Record<string, number> = { rd: DYN_RED, bd: DYN_BLUE, gr: DYN_GREEN };
const aabb = new b2AABB();

/**
 * The ROWS*COLS dyn grid, row-major: DYN_MOVING over each movers() shape's
 * bounding box (so a tilted bar marks every cell its box overlaps), a diamond
 * bit over each uncollected diamond, and a fan's wind bit over its area while
 * it is on.
 */
export function readDyn(lv: Ported): Uint8Array {
  const out = new Uint8Array(ROWS * COLS);
  for (let b = lv.m_world.GetBodyList(); b; b = b.GetNext()) {
    const name: string | undefined = b.GetUserData()?.name;
    const bit = DIAMONDS[name ?? ""] ??
      (b.IsStatic() || name === "pers1" || name === "pers2" ? 0 : DYN_MOVING);
    if (!bit) continue;
    for (let s = b.GetShapeList(); s; s = s.GetNext()) {
      s.ComputeAABB(aabb, b.GetXForm());
      paint(out, bit, aabb.lowerBound.x, aabb.lowerBound.y, aabb.upperBound.x, aabb.upperBound.y);
    }
  }
  for (const w of lv.myWinds as Ported[]) {
    if (w.on) paint(out, DYN_WIND[w.vertical], w.lower.x, w.lower.y, w.upper.x, w.upper.y);
  }
  return out;
}

/** The STATE_FLOATS numbers for one level, in STATE_NAMES order. */
export function readState(lv: Ported, host: Ported, doors: Ported[]): number[] {
  const cl = lv.myContactListener;
  const p1 = lv.pers1.GetPosition();
  const v1 = lv.pers1.GetLinearVelocity();
  const p2 = lv.pers2.GetPosition();
  const v2 = lv.pers2.GetLinearVelocity();
  const floats = [
    p1.x, p1.y, v1.x, v1.y, p2.x, p2.y, v2.x, v2.y,
    grounded(cl.contactStack1), grounded(cl.contactStack2),
    // Set by a jump and cleared once Up is up, both within the frame, so this
    // is already the value the next frame's check reads.
    lv.prohibjump1 ? 1 : 0, lv.prohibjump2 ? 1 : 0,
    cl.deadFire ? 1 : 0, cl.deadWater ? 1 : 0, cl.finish1, cl.finish2,
    (doors[0].currentFrame - 1) / (DOOR_OPEN - 1), (doors[1].currentFrame - 1) / (DOOR_OPEN - 1),
    cl.RedCount, cl.BlueCount, cl.GreenCount,
    lv.timecount, host.recuents > 0 ? 1 : 0, host.gameOvers > 0 ? 1 : 0,
    // The game adds the "ender" stairs clip in the frame both doors are open,
    // in the same branch that pauses and ends the level, and only on a win
    // (game.ts Update); Recuent fires when that clip finishes, 34 frames on.
    lv.getChildByName("ender") ? 1 : 0,
  ];
  const levers: Ported[] = lv.myLevers;
  for (let i = 0; i < LEVER_SLOTS; i++) {
    const j = levers[i];
    if (!j) {
      floats.push(0);
      continue;
    }
    // The game calls a lever on when its angle is on its `onis` side (game.ts
    // Update), so flip the sign to make +1 always mean on. Clamped: a lever
    // resting on its limit reads about 6% past it.
    const side = j.GetUserData().GetUserData().onis === "l" ? 1 : -1;
    floats.push(Math.max(-1, Math.min(1, side * j.GetJointAngle() / j.m_upperAngle)));
  }
  const pushers: Ported[] = lv.myPushers;
  for (let i = 0; i < PUSHER_SLOTS; i++) {
    // The game's own rule (game.ts Update): pressed once the button body has
    // sunk more than PRESSED below its origin. The joint translation is not
    // used because it overshoots while the depth stays under the threshold.
    const body: Ported = pushers[i]?.GetUserData();
    const sunk = body ? body.GetPosition().y - body.GetUserData().originy : 0;
    floats.push(Math.min(1, Math.max(0, sunk / PRESSED)));
  }
  const ms = movers(lv);
  for (let i = 0; i < MOVER_SLOTS; i++) {
    const b = ms[i];
    if (!b) {
      floats.push(0, 0, 0, 0, 0, 0);
      continue;
    }
    const p = b.GetPosition();
    const v = b.GetLinearVelocity();
    floats.push(p.x, p.y, b.GetAngle(), v.x, v.y, b.GetAngularVelocity());
  }
  return floats;
}
