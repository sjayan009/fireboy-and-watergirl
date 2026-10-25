/**
 * The training env server: many copies of the real game, driven over a pipe.
 *
 * Python starts `node engine/dist/bot/envserver.js <N>` and owns its stdin and
 * stdout. The physics stays here, in the Box2D port that is certified for
 * determinism, and only numbers cross the pipe. This file lives in `bot/`, not
 * `game/`, `flash/` or `box2d/`, because those three are hashed into
 * ENGINE_VERSION.
 *
 * ---- Framing (at the bottom of the file) ----------------------------------
 *
 * Every request and every reply is `u32 length` + `length` bytes. All numbers
 * are little-endian.
 *
 * ---- Requests (the first payload byte is the op) ---------------------------
 *
 *   OP_RESET  u8 op, u16 env, u8 modeLen, modeLen ASCII bytes, u8 num
 *             -> one STATE record for that env
 *   OP_STEP   u8 op, u8 repeat, N x u8 input bits (one byte per env)
 *             -> N STATE records, in env order
 *   OP_INFO   u16 env after the op byte
 *             -> ROWS*COLS int8 grid (row-major), then u8 fireDoorRow,
 *                u8 fireDoorCol, u8 waterDoorRow, u8 waterDoorCol
 *
 * ---- STATE record (STATE_BYTES long) ---------------------------------------
 *
 *   STATE_FLOATS x f32, in this order:
 *     fireX, fireY, fireVX, fireVY, waterX, waterY, waterVX, waterVY,
 *     deadFire, deadWater, finish1, finish2, clock,
 *     complete   1 once the game's own level-complete (Recuent) has fired,
 *                about 46 frames after both characters stand in their doors
 *     gameOver   1 once the game's own GameOver has fired, after a death
 *     LEVER_SLOTS levers, -1 fully off .. +1 fully on, in creation order,
 *                0 for slots this level does not have
 *     PUSHER_SLOTS buttons, 0 up .. 1 at the depth the game counts as
 *                pressed (sinking more than 0.25 below where it started)
 *   u32 hashLevel(lv), parsed from its hex string
 *   ROWS*COLS x u8 "dyn" grid, row-major, bit flags per cell:
 *     DYN_MOVING  a non-static body other than pers1/pers2 covers the cell
 *     DYN_RED / DYN_BLUE / DYN_GREEN  an uncollected "rd" / "bd" / "gr" body
 *     DYN_WIND_UP / _RIGHT / _DOWN / _LEFT  a fan that is on blows here.
 *       Fans are not bodies, so without these the bot could not see them.
 *
 * ---- Engine facts this relies on -------------------------------------------
 *
 * - Build:   `new (level as Ported)(mode, num)`, then `hostLevel(lv)` from
 *            game/headless.ts, which a death needs.
 * - Frame:   tickClock(); applyInput(lv, bits); advanceTree(lv);
 *            enterFrameTree(lv); lv.Update(new Event(Event.ENTER_FRAME))
 *            -- the order in snapbench.ts.
 * - Reset:   build, run one frame with no input so the level settles, then
 *            capture `new Snapshot().capture([host])` once per (env, level),
 *            restore it on later resets. Never rebuild the level.
 * - Clock:   ONE module-global (getClock/setClock) shared by every env in this
 *            process, and the snapshot does not save it. Save it beside the
 *            snapshot, and setClock(env.clock) before stepping an env,
 *            env.clock = getClock() after.
 * - Delay:   a press must take effect exactly DELAY frames after it was sent.
 *            A queue of DELAY inputs per env, starting all zero, emptied on
 *            reset. A press applied in frame f already moves the character
 *            in frame f.
 * - Units:   one world unit is one tile, tiles centred on integers, so a
 *            body's cell is (Math.round(y), Math.round(x)).
 * - Bodies:  lv.m_world.GetBodyList() / .GetNext(); GetUserData().name is
 *            pers1, pers2, finish1, finish2, rd, bd, gr, slide, box, ...
 *            Per shape (b.GetShapeList() / .GetNext()):
 *            shape.ComputeAABB(aabb, b.GetXForm()) with a `new b2AABB()`.
 * - Flags:   lv.myContactListener.{deadFire, deadWater, finish1, finish2};
 *            host.recuents / host.gameOvers count the game's own endings.
 * - Fans:    lv.myWinds[i].{lower, upper, vertical 1 up 2 right 3 down
 *            4 left, on}. Levers and buttons are joints in lv.myLevers and
 *            lv.myPushers; joint.GetUserData() is the lever or button body.
 * - Grid:    lv.LevelArray[row][col]; numbers go out as int8, anything else
 *            (the diamond strings) as 0, because diamonds travel in dyn.
 */
import { level, tickClock, getClock, setClock } from "../game/game.js";
import { hostLevel } from "../game/headless.js";
import { Event, SoundBus, advanceTree, enterFrameTree } from "../flash/flash.js";
import { applyInput, hashLevel } from "../net/hash.js";
import { Snapshot } from "../net/snapshot.js";
import { b2AABB } from "../box2d/box2d.js";
import type { Ported } from "../ported.js";

export const ROWS = 29;
export const COLS = 39;
export const DELAY = 4;
export const LEVER_SLOTS = 12;
export const PUSHER_SLOTS = 12;
export const STATE_FLOATS = 15 + LEVER_SLOTS + PUSHER_SLOTS;
export const STATE_BYTES = STATE_FLOATS * 4 + 4 + ROWS * COLS;

export const OP_RESET = 1;
export const OP_STEP = 2;
export const OP_INFO = 3;

export const DYN_MOVING = 1;
export const DYN_RED = 2;
export const DYN_BLUE = 4;
export const DYN_GREEN = 8;
/** Indexed by a fan's `vertical`, 1..4. */
const DYN_WIND = [0, 16, 32, 64, 128];

const EDGE = 1e-6;
/** How far a button sinks before the game counts it as pressed. */
const PRESSED = 0.25;

/** A built level, its snapshot at frame zero, and the clock that goes with it. */
interface Cached {
  lv: Ported;
  host: Ported;
  snap: Snapshot;
  clock: number;
  /** In creation order. Restores keep the same objects. */
  levers: Ported[];
  pushers: Ported[];
}

/** One simulation frame, in the order snapbench.ts and both SessionHosts use. */
function frame(lv: Ported, bits: number): void {
  tickClock();
  applyInput(lv, bits);
  advanceTree(lv);
  enterFrameTree(lv);
  lv.Update(new Event(Event.ENTER_FRAME));
}

/** OR `bit` into every cell whose centre lies inside the box. */
function paint(out: DataView, grid: number, bit: number,
               x0: number, y0: number, x1: number, y1: number): void {
  // Bounds often sit on half-cells (a tile is c-0.5..c+0.5), and Math.round
  // takes c+0.5 up into the next cell; nudge both ends inward.
  const r0 = Math.max(0, Math.round(y0 + EDGE));
  const r1 = Math.min(ROWS - 1, Math.round(y1 - EDGE));
  const c0 = Math.max(0, Math.round(x0 + EDGE));
  const c1 = Math.min(COLS - 1, Math.round(x1 - EDGE));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const at = grid + r * COLS + c;
      out.setUint8(at, out.getUint8(at) | bit);
    }
  }
}

/** Which dyn bit a body sets, or 0 for none. */
function dynBit(body: Ported): number {
  const name: string | undefined = body.GetUserData()?.name;
  if (name === "rd") return DYN_RED;
  if (name === "bd") return DYN_BLUE;
  if (name === "gr") return DYN_GREEN;
  if (body.IsStatic() || name === "pers1" || name === "pers2") return 0;
  return DYN_MOVING;
}

class Env {
  /** One per "mode-num" this env has played; a reset restores, never rebuilds. */
  private cache = new Map<string, Cached>();
  private cur: Cached | null = null;
  private clock = 0;
  private queue: number[] = [];
  private aabb = new b2AABB();

  /** Build or restore the level, empty the input queue. */
  reset(mode: string, num: number): void {
    const key = `${mode}-${num}`;
    let c = this.cache.get(key);
    if (c) {
      c.snap.restore();
    } else {
      const lv: Ported = new (level as Ported)(mode, num);
      const host = hostLevel(lv);
      if (lv.LevelArray.length !== ROWS || lv.LevelArray[0].length !== COLS) {
        throw new Error(`${key} is not ${ROWS}x${COLS}`);
      }
      const levers: Ported[] = lv.myLevers;
      const pushers: Ported[] = lv.myPushers;
      if (levers.length > LEVER_SLOTS || pushers.length > PUSHER_SLOTS) {
        throw new Error(`${key} has ${levers.length} levers and ${pushers.length} buttons`);
      }
      // One frame with no input before the snapshot: a just-built level is
      // not a state play ever shows -- levers sit at +-90 degrees and every
      // fan reads on until the first Update applies the levers (puzzle 7's
      // three fans start off). Clock from 0, not getClock(): the global
      // still holds whichever env ran last.
      setClock(0);
      frame(lv, 0);
      c = { lv, host, snap: new Snapshot().capture([host]), clock: getClock(), levers, pushers };
      this.cache.set(key, c);
    }
    this.cur = c;
    this.clock = c.clock;
    this.queue = new Array<number>(DELAY).fill(0);
  }

  private get level(): Cached {
    if (!this.cur) throw new Error("step or read before the first reset");
    return this.cur;
  }

  private get lv(): Ported {
    return this.level.lv;
  }

  /**
   * Run `repeat` frames. Each frame pushes `bits` into the delay queue and
   * runs with the oldest entry, so repeat=3 is the same as three repeat=1s.
   */
  step(bits: number, repeat: number): void {
    const lv = this.lv;
    // The clock is one global shared by every env in this process.
    setClock(this.clock);
    for (let i = 0; i < repeat; i++) {
      this.queue.push(bits);
      frame(lv, this.queue.shift());
    }
    this.clock = getClock();
  }

  /** Write one STATE record at `off` in `out`. */
  writeState(out: DataView, off: number): void {
    const { lv, host, levers, pushers } = this.level;
    const cl = lv.myContactListener;
    const p1 = lv.pers1.GetPosition();
    const v1 = lv.pers1.GetLinearVelocity();
    const p2 = lv.pers2.GetPosition();
    const v2 = lv.pers2.GetLinearVelocity();
    const floats = [
      p1.x, p1.y, v1.x, v1.y, p2.x, p2.y, v2.x, v2.y,
      cl.deadFire ? 1 : 0, cl.deadWater ? 1 : 0, cl.finish1, cl.finish2, this.clock,
      host.recuents > 0 ? 1 : 0, host.gameOvers > 0 ? 1 : 0,
    ];
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
    for (let i = 0; i < PUSHER_SLOTS; i++) {
      // The game's own rule (game.ts Update): pressed once the button body has
      // sunk more than PRESSED below its origin. The joint translation is not
      // used because it overshoots while the depth stays under the threshold.
      const body: Ported = pushers[i]?.GetUserData();
      const sunk = body ? body.GetPosition().y - body.GetUserData().originy : 0;
      floats.push(Math.min(1, Math.max(0, sunk / PRESSED)));
    }
    for (let i = 0; i < STATE_FLOATS; i++) out.setFloat32(off + 4 * i, floats[i], true);
    out.setUint32(off + STATE_FLOATS * 4, parseInt(hashLevel(lv), 16), true);

    const grid = off + STATE_FLOATS * 4 + 4;
    for (let i = 0; i < ROWS * COLS; i++) out.setUint8(grid + i, 0);
    for (let b = lv.m_world.GetBodyList(); b; b = b.GetNext()) {
      const bit = dynBit(b);
      if (!bit) continue;
      for (let s = b.GetShapeList(); s; s = s.GetNext()) {
        s.ComputeAABB(this.aabb, b.GetXForm());
        const { lowerBound: lo, upperBound: hi } = this.aabb;
        paint(out, grid, bit, lo.x, lo.y, hi.x, hi.y);
      }
    }
    for (const w of lv.myWinds as Ported[]) {
      if (w.on) paint(out, grid, DYN_WIND[w.vertical], w.lower.x, w.lower.y, w.upper.x, w.upper.y);
    }
  }

  /** The OP_INFO reply for the current level. */
  info(): Uint8Array {
    const lv = this.lv;
    const out = new Uint8Array(ROWS * COLS + 4);
    const dv = new DataView(out.buffer);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v: unknown = lv.LevelArray[r][c];
        dv.setInt8(r * COLS + c, typeof v === "number" ? v : 0);
      }
    }
    let k = ROWS * COLS;
    for (const name of ["finish1", "finish2"]) {
      let found = false;
      for (let b = lv.m_world.GetBodyList(); b; b = b.GetNext()) {
        if (b.GetUserData()?.name !== name) continue;
        const p = b.GetPosition();
        out[k++] = Math.round(p.y);
        out[k++] = Math.round(p.x);
        found = true;
        break;
      }
      if (!found) throw new Error(`no ${name} body`);
    }
    return out;
  }
}

// Nothing here plays audio, and Sound.play would otherwise grow SoundBus.queue
// for the life of the process.
SoundBus.replaying = true;

const envs: Env[] = Array.from({ length: Number(process.argv[2] ?? 1) }, () => new Env());

function envAt(i: number): Env {
  const e = envs[i];
  if (!e) throw new Error(`env ${i} out of range (have ${envs.length})`);
  return e;
}

/** Decode one request payload and return the reply payload. */
function handle(req: DataView): Uint8Array {
  const op = req.getUint8(0);
  switch (op) {
    case OP_RESET: {
      const env = envAt(req.getUint16(1, true));
      const len = req.getUint8(3);
      const mode = Buffer.from(req.buffer, req.byteOffset + 4, len).toString("ascii");
      env.reset(mode, req.getUint8(4 + len));
      const out = new Uint8Array(STATE_BYTES);
      env.writeState(new DataView(out.buffer), 0);
      return out;
    }
    case OP_STEP: {
      const repeat = req.getUint8(1);
      if (req.byteLength !== 2 + envs.length) {
        throw new Error(`step carries ${req.byteLength - 2} inputs for ${envs.length} envs`);
      }
      const out = new Uint8Array(STATE_BYTES * envs.length);
      const dv = new DataView(out.buffer);
      envs.forEach((e, i) => {
        e.step(req.getUint8(2 + i), repeat);
        e.writeState(dv, i * STATE_BYTES);
      });
      return out;
    }
    case OP_INFO:
      return envAt(req.getUint16(1, true)).info();
    default:
      throw new Error(`unknown op ${op}`);
  }
}

// ---- framing: u32 length + payload, both directions ------------------------

let pending = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const len = pending.readUInt32LE(0);
    if (pending.length < 4 + len) break;
    const body = pending.subarray(4, 4 + len);
    pending = pending.subarray(4 + len);
    const reply = handle(new DataView(body.buffer, body.byteOffset, body.byteLength));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(reply.byteLength, 0);
    process.stdout.write(Buffer.concat([head, reply]));
  }
});
