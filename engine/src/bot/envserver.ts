/**
 * The training env server: many copies of the real game, driven over a pipe.
 *
 * Python starts `node engine/dist/bot/envserver.js <N> [cache]` and owns its
 * stdin and stdout; `cache` is how many levels each env keeps built (see
 * Reset). The physics stays here, in the Box2D port that is certified for
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
 *   OP_RESET  u8 op, u16 env, u8 modeLen, modeLen ASCII bytes, u8 num,
 *             u8 delay, u8 side
 *             -> one STATE record for that env. `side` is the character
 *                the bot plays, 0 Fireboy, 1 Watergirl. `delay` is the bot's
 *                input delay in frames for this episode, and only its side's
 *                three bits wait; the partner's apply in the frame they are
 *                sent, as a human's keys do in Local Play. Delay 0 is the
 *                bot on the main thread.
 *   OP_STEP   u8 op, u8 repeat, N x u8 input bits (one byte per env)
 *             -> N STATE records, in env order
 *   OP_HELLO  nothing after the op byte
 *             -> UTF-8 JSON {schema, engine, state}: SCHEMA_VERSION,
 *                ENGINE_VERSION and STATE_NAMES. The client checks them
 *                before anything else, so a server built from other fields
 *                is refused even when its records are the same size.
 *   OP_INFO   u16 env after the op byte
 *             -> ROWS*COLS int8 grid (row-major), then u8 fireDoorRow,
 *                u8 fireDoorCol, u8 waterDoorRow, u8 waterDoorCol, then
 *                ROWS*COLS u8 obstacles (row-major): 1 where a cell's centre
 *                is inside a static solid the grid leaves out, the seesaw
 *                bases (envstate.ts obstacleMask). They never move.
 *
 * ---- STATE record (STATE_BYTES long) ---------------------------------------
 *
 *   STATE_FLOATS x f32, in the order of STATE_NAMES in envstate.ts, which
 *   reads them (bot/fbwg_env.py's STATE_FIELDS must match it):
 *     fireX, fireY, fireVX, fireVY, waterX, waterY, waterVX, waterVY,
 *     fireGrounded, waterGrounded   1 if the next frame's jump check finds
 *                ground: Up pressed in that frame jumps unless latched
 *     fireJumpLatched, waterJumpLatched   lv.prohibjump1/2: set by a jump,
 *                cleared when Up is released. Up jumps only when grounded
 *                and not latched, so holding Up never jumps twice
 *     deadFire, deadWater, finish1, finish2,
 *     fireDoorOpen, waterDoorOpen   the door clips' playheads, 0 shut ..
 *                1 open; the level ends only once both are fully open
 *     redCount, blueCount, greenCount   diamonds collected, raw
 *     timecount  lv.timecount, frames since the level started; stops when
 *                the level pauses (a death or the exit). The game adds 1
 *                before the next frame's fans push, so that push follows
 *                detSin((timecount + 1) / 10). The graded time on a win is
 *                floor((timecount - 1) / 26) seconds
 *     complete   1 once the game's own level-complete (Recuent) has fired,
 *                34 frames after won; nothing happens in between
 *     gameOver   1 once the game's own GameOver has fired, after a death
 *     won        1 from the frame the level ends with both doors open: the
 *                game's own end of a win (the "ender" clip), the exact signal
 *     fireLeft, fireRight, fireUp, waterLeft, waterRight, waterUp   1 for
 *                each key the last frame ran with (lv.l/r/u_pressed and the
 *                2 variants), after the delay: what both characters did
 *     LEVER_SLOTS levers, -1 fully off .. +1 fully on, in creation order,
 *                0 for slots this level does not have
 *     PUSHER_SLOTS buttons, 0 up .. 1 at the depth the game counts as
 *                pressed (sinking more than 0.25 below where it started)
 *     MOVER_SLOTS x (x, y, angle, vx, vy, spin) for the moving bodies
 *                (envstate.ts movers), all 0 for slots this level does not
 *                have. Radians, and world units per second
 *     FAN_SLOTS x (x0, y0, x1, y1, dx, dy, on) for every fan, on or off,
 *                in creation order: its area, the unit push it gives, and
 *                whether it blows now; all 0 for slots this level does not
 *                have
 *   u32 hashLevel(lv), parsed from its hex string
 *   ROWS*COLS x u8 "dyn" grid, row-major, bit flags per cell (envstate.ts
 *   readDyn):
 *     DYN_MOVING  a moving body's shape's bounding box overlaps the cell
 *     DYN_RED / DYN_BLUE / DYN_GREEN  an uncollected "rd" / "bd" / "gr" body
 *     DYN_WIND_UP / _RIGHT / _DOWN / _LEFT  a fan that is on blows here.
 *       Fans are not bodies, so without these the bot could not see them.
 *
 * ---- Engine facts this relies on -------------------------------------------
 *
 * - Build:   `new (level as Ported)(mode, num)`, then `hostLevel(lv)` from
 *            game/headless.ts, which a death needs.
 * - Frame:   tickClock(); applyInput(lv, bits); advanceTree(lv);
 *            enterFrameTree(lv) -- the website's own loop (embed.ts step,
 *            GameHost.step). The level registers Update as its ENTER_FRAME
 *            listener, so enterFrameTree already runs it once. snapbench.ts
 *            and LevelHost also call lv.Update() by hand, which runs it
 *            twice: two physics steps and two timecount ticks per frame.
 * - Reset:   build, run one frame with no input so the level settles, then
 *            capture `new Snapshot().capture([host])` once per (env, level),
 *            restore it on later resets (envstate.ts buildLevel). On the
 *            website the bot skips the level's first frame the same way. Each env keeps the `cache` levels it
 *            reset to most recently; one evicted is built again the same way.
 * - Clock:   ONE module-global (getClock/setClock) shared by every env in this
 *            process, and the snapshot does not save it. Save it beside the
 *            snapshot, and setClock(env.clock) before stepping an env,
 *            env.clock = getClock() after. Only the medal timer reads it; it
 *            is not observed, because on the live site it counts frames since
 *            page load. lv.timecount is the level's own frame count, and the
 *            fans' strength follows detSin(timecount / 10).
 * - Delay:   the bot's press must take effect exactly `delay` frames after
 *            it was sent, the partner's at once. A queue of `delay` inputs
 *            of the bot's bits per env, starting all zero, rebuilt on every
 *            reset. A press applied in frame f already moves the character
 *            in frame f.
 * - Units:   one world unit is one tile, tiles centred on integers, so a
 *            body's cell is (Math.round(y), Math.round(x)).
 * - Bodies:  lv.m_world.GetBodyList() / .GetNext(); GetUserData().name is
 *            pers1, pers2, finish1, finish2, rd, bd, gr, slide, box, ...
 *            Per shape (b.GetShapeList() / .GetNext()):
 *            shape.ComputeAABB(aabb, b.GetXForm()) with a `new b2AABB()`.
 * - Flags:   lv.myContactListener.{deadFire, deadWater, finish1, finish2,
 *            RedCount, BlueCount, GreenCount}; host.recuents /
 *            host.gameOvers count the game's own endings. lv.ended is also
 *            set by a death; lv.getChildByName("ender") only by a win.
 * - Jump:    Update sets allowjump1/2 at its top from
 *            lv.myContactListener.contactStack1/2, the contact normals the
 *            previous frame's world Step left, so lv.allowjump1/2 read after a
 *            frame describe its start. Grounded applies the game's rule to the
 *            stacks instead: only a Step (or a teleport) changes them, and
 *            applyInput and advanceTree, which run before the next check, do
 *            not.
 * - Doors:   lv.SlidersAndRots.getChildByName("finish1" / "finish2"), the
 *            same objects as the door bodies' user data. Frames 1..22: one up
 *            per frame while the character stands in it, one down after.
 * - Fans:    lv.myWinds[i].{lower, upper, vertical 1 up 2 right 3 down
 *            4 left, on}. Levers and buttons are joints in lv.myLevers and
 *            lv.myPushers; joint.GetUserData() is the lever or button body.
 * - Grid:    lv.LevelArray[row][col]; numbers go out as int8, anything else
 *            (the diamond strings) as 0, because diamonds travel in dyn.
 *            Static bodies other than "ground" are not in it, and dyn skips
 *            static bodies, so the obstacles mask carries them.
 */
import { getClock, setClock } from "../game/game.js";
import { SoundBus } from "../flash/flash.js";
import { hashLevel } from "../net/hash.js";
import { ENGINE_VERSION } from "../version.js";
import type { Ported } from "../ported.js";
import {
  COLS, ROWS, SCHEMA_VERSION, STATE_FLOATS, STATE_NAMES, type Built,
  buildLevel, frame, obstacleMask, readDyn, readState,
} from "./envstate.js";

export const STATE_BYTES = STATE_FLOATS * 4 + 4 + ROWS * COLS;

export const OP_RESET = 1;
export const OP_STEP = 2;
export const OP_INFO = 3;
export const OP_HELLO = 4;

/**
 * Levels each env keeps built, least recently reset to evicted first.
 * Measured: one env holding all 32 levels takes about 242 MB of heap, and
 * Node's heap limit here is about 4.5 GB, so 18 envs rotating through every
 * level in one process would run out. With the default 4, 32 envs each
 * rotating through all 32 levels peak at about 1.9 GB RSS, the same on the
 * second lap as the first.
 */
const CACHE = Number(process.argv[3] ?? 4);
if (!(CACHE >= 1)) throw new Error(`cache must be at least 1, got ${process.argv[3]}`);

class Env {
  /**
   * "mode-num" -> its built level, in least-recently-reset-first order (a
   * Map keeps insertion order; a hit is deleted and set again). The entry is
   * the only reference to a level apart from `cur`, which is always the newest
   * entry, so deleting the oldest lets the collector have it.
   */
  private cache = new Map<string, Built>();
  private cur: Built | null = null;
  private clock = 0;
  private queue: number[] = [];
  /** The bot's three bits: 7 Fireboy, 56 Watergirl. */
  private mine = 7;

  /** Build or restore the level, and size the input queue for `delay`. */
  reset(mode: string, num: number, delay: number, side: number): void {
    if (side !== 0 && side !== 1) throw new Error(`side must be 0 or 1, got ${side}`);
    const key = `${mode}-${num}`;
    let c = this.cache.get(key);
    if (c) {
      this.cache.delete(key);
      c.snap.restore();
    } else {
      c = buildLevel(mode, num);
    }
    this.cache.set(key, c);
    if (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value!);
    this.cur = c;
    this.clock = c.clock;
    // Rebuilt, not emptied: presses from the last episode must not come out
    // in this one, whatever either episode's delay.
    this.queue = new Array<number>(delay).fill(0);
    this.mine = side ? 56 : 7;
  }

  private get level(): Built {
    if (!this.cur) throw new Error("step or read before the first reset");
    return this.cur;
  }

  private get lv(): Ported {
    return this.level.lv;
  }

  /**
   * Run `repeat` frames. Each frame pushes the bot's bits into the delay
   * queue and runs with the oldest entry plus the partner's bits as sent, so
   * repeat=3 is the same as three repeat=1s. With delay 0 the oldest entry is
   * the one just pushed.
   */
  step(bits: number, repeat: number): void {
    const lv = this.lv;
    // The clock is one global shared by every env in this process.
    setClock(this.clock);
    for (let i = 0; i < repeat; i++) {
      this.queue.push(bits & this.mine);
      frame(lv, this.queue.shift()! | (bits & ~this.mine));
    }
    this.clock = getClock();
  }

  /** Write one STATE record at `off` in `out`. */
  writeState(out: DataView, off: number): void {
    const { lv, host, doors } = this.level;
    const floats = readState(lv, host, doors);
    for (let i = 0; i < STATE_FLOATS; i++) out.setFloat32(off + 4 * i, floats[i], true);
    out.setUint32(off + STATE_FLOATS * 4, parseInt(hashLevel(lv), 16), true);

    new Uint8Array(out.buffer, out.byteOffset + off + STATE_FLOATS * 4 + 4, ROWS * COLS).set(readDyn(lv));
  }

  /** The OP_INFO reply for the current level. */
  info(): Uint8Array {
    const lv = this.lv;
    const out = new Uint8Array(ROWS * COLS + 4 + ROWS * COLS);
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
    out.set(obstacleMask(lv), k);
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
      env.reset(mode, req.getUint8(4 + len), req.getUint8(5 + len), req.getUint8(6 + len));
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
    case OP_HELLO:
      return Buffer.from(JSON.stringify({ schema: SCHEMA_VERSION, engine: ENGINE_VERSION, state: STATE_NAMES }));
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
