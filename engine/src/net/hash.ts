/**
 * Deterministic state hashing.
 *
 * Lockstep netcode needs a cheap way to ask "are we still in sync?". Each peer
 * hashes its world every N frames and exchanges the digest; a mismatch means
 * divergence, and the sooner it is caught the smaller the resync.
 *
 * The hash covers the *exact bits* of every float, not a rounded value: a
 * one-ulp drift is exactly the failure we are hunting, so rounding it away
 * would defeat the point. Bodies are walked in world list order, which Box2D
 * derives from creation order and is therefore identical on both peers.
 */

const buf = new ArrayBuffer(8);
const f64 = new Float64Array(buf);
const u32 = new Uint32Array(buf);

/** FNV-1a, 32-bit, over the raw bytes of the values fed in. */
export class Hasher {
  private h = 0x811c9dc5;

  int(v: number): this {
    let x = v | 0;
    for (let i = 0; i < 4; i++) {
      this.h ^= x & 0xff;
      this.h = Math.imul(this.h, 0x01000193);
      x >>>= 8;
    }
    return this;
  }

  /** Hash a double by its IEEE-754 bit pattern. */
  num(v: number): this {
    f64[0] = v;
    return this.int(u32[0]).int(u32[1]);
  }

  get value(): number {
    return this.h >>> 0;
  }

  get hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, "0");
  }
}

/**
 * Hash the simulation state of a level: every body's transform and velocity,
 * plus the game-visible counters that live outside Box2D.
 */
export function hashLevel(lv: any): string {
  const h = new Hasher();
  let bodies = 0;
  for (let b = lv.m_world.GetBodyList(); b; b = b.GetNext()) {
    const p = b.GetPosition();
    const v = b.GetLinearVelocity();
    h.num(p.x).num(p.y).num(b.GetAngle());
    h.num(v.x).num(v.y).num(b.GetAngularVelocity());
    bodies++;
  }
  h.int(bodies);

  const cl = lv.myContactListener;
  if (cl) {
    h.int(cl.finish1).int(cl.finish2);
    h.int(cl.RedCount | 0).int(cl.BlueCount | 0).int(cl.GreenCount | 0);
    h.int(cl.deadFire ? 1 : 0).int(cl.deadWater ? 1 : 0);
  }
  h.int(lv.RDcount | 0).int(lv.BDcount | 0);
  h.int(lv.ended ? 1 : 0).int(lv.pause ? 1 : 0);

  // door animation frames gate level completion, so they are state too
  for (const nm of ["finish1", "finish2"]) {
    const d: any = lv.SlidersAndRots?.getChildByName?.(nm);
    h.int(d ? d.currentFrame : 0);
  }
  return h.hex;
}

/** The six input bits, packed. This is the entire per-frame netcode payload. */
export function packInput(lv: any): number {
  return (lv.l_pressed ? 1 : 0) | (lv.r_pressed ? 2 : 0) |
         (lv.u_pressed ? 4 : 0) | (lv.l_pressed2 ? 8 : 0) |
         (lv.r_pressed2 ? 16 : 0) | (lv.u_pressed2 ? 32 : 0);
}

export function applyInput(lv: any, bits: number): void {
  lv.l_pressed = (bits & 1) !== 0;
  lv.r_pressed = (bits & 2) !== 0;
  lv.u_pressed = (bits & 4) !== 0;
  lv.l_pressed2 = (bits & 8) !== 0;
  lv.r_pressed2 = (bits & 16) !== 0;
  lv.u_pressed2 = (bits & 32) !== 0;
}
