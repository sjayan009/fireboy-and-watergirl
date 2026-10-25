/**
 * The training env server: many copies of the real game, driven over a pipe.
 *
 * Python starts `node engine/dist/bot/envserver.js <N>` and owns its stdin and
 * stdout. The physics stays here, in the Box2D port that is certified for
 * determinism, and only numbers cross the pipe. This file lives in `bot/`, not
 * `game/`, `flash/` or `box2d/`, because those three are hashed into
 * ENGINE_VERSION.
 *
 * ---- Framing (done for you, see the bottom of the file) --------------------
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
 *     deadFire, deadWater, finish1, finish2, clock
 *   u32 hashLevel(lv), parsed from its hex string
 *   ROWS*COLS x u8 "dyn" grid, row-major, bit flags per cell:
 *     DYN_MOVING  a non-static body other than pers1/pers2 covers the cell
 *     DYN_RED / DYN_BLUE / DYN_GREEN  an uncollected "rd" / "bd" / "gr" body
 *
 * ---- Engine facts you need -------------------------------------------------
 *
 * - Build:   `new (level as Ported)(mode, num)`, then `hostLevel(lv)` from
 *            game/headless.ts, which a death needs.
 * - Frame:   tickClock(); applyInput(lv, bits); advanceTree(lv);
 *            enterFrameTree(lv); lv.Update(new Event(Event.ENTER_FRAME))
 *            -- the order in snapbench.ts.
 * - Reset:   capture `new Snapshot().capture([host])` once per (env, level),
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
 * - Flags:   lv.myContactListener.{deadFire, deadWater, finish1, finish2}.
 * - Grid:    lv.LevelArray[row][col]; numbers go out as int8, anything else
 *            (the diamond strings) as 0, because diamonds travel in dyn.
 *
 * You will need roughly:
 *   import { level, tickClock, getClock, setClock } from "../game/game.js";
 *   import { hostLevel } from "../game/headless.js";
 *   import { Event, advanceTree, enterFrameTree } from "../flash/flash.js";
 *   import { applyInput, hashLevel } from "../net/hash.js";
 *   import { Snapshot } from "../net/snapshot.js";
 *   import { b2AABB } from "../box2d/box2d.js";
 *   import type { Ported } from "../ported.js";
 */

export const ROWS = 29;
export const COLS = 39;
export const DELAY = 4;
export const STATE_FLOATS = 13;
export const STATE_BYTES = STATE_FLOATS * 4 + 4 + ROWS * COLS;

export const OP_RESET = 1;
export const OP_STEP = 2;
export const OP_INFO = 3;

export const DYN_MOVING = 1;
export const DYN_RED = 2;
export const DYN_BLUE = 4;
export const DYN_GREEN = 8;

class Env {
  // TODO: the current level, its host, and the clock that goes with it.
  // TODO: a cache of snapshots, one per "mode-num" this env has played.
  // TODO: the DELAY-long input queue.

  /** Build or restore the level, empty the input queue. */
  reset(mode: string, num: number): void {
    throw new Error(`TODO reset(${mode}, ${num})`);
  }

  /**
   * Run `repeat` frames. Each frame pushes `bits` into the delay queue and
   * runs with the oldest entry, so repeat=3 is the same as three repeat=1s.
   */
  step(bits: number, repeat: number): void {
    throw new Error(`TODO step(${bits}, ${repeat})`);
  }

  /** Write one STATE record at `off` in `out`. */
  writeState(out: DataView, off: number): void {
    throw new Error(`TODO writeState at ${off} of ${out.byteLength}`);
  }

  /** The OP_INFO reply for the current level. */
  info(): Uint8Array {
    throw new Error("TODO info");
  }
}

const envs: Env[] = Array.from({ length: Number(process.argv[2] ?? 1) }, () => new Env());

/** Decode one request payload and return the reply payload. */
function handle(req: DataView): Uint8Array {
  // TODO: switch on req.getUint8(0) and call into `envs`. Each case encodes
  // its reply as described at the top of the file.
  throw new Error(`TODO handle op ${req.getUint8(0)} for ${envs.length} envs`);
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
