/**
 * One env's STATE floats, read from a live level.
 *
 * envserver.ts sends these over the wire and envfacts.ts checks them against
 * the engine, so the facts test the very numbers the bot sees, field by field.
 * A module of its own because envserver.ts starts reading stdin on import.
 * The field meanings are documented in envserver.ts's header.
 */
import type { Ported } from "../ported.js";

export const LEVER_SLOTS = 12;
export const PUSHER_SLOTS = 12;

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
  "timecount", "complete", "game_over",
  ...Array.from({ length: LEVER_SLOTS }, (_, i) => `lever${i}`),
  ...Array.from({ length: PUSHER_SLOTS }, (_, i) => `pusher${i}`),
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
  return floats;
}
