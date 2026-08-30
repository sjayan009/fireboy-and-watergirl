/**
 * Seeded, deterministic pseudo-randomness.
 *
 * `level.as` calls `Math.random()` ten times while building a level: to place
 * the fireflies, to pick which of GroundBox1..4 draws each terrain tile, and to
 * rotate the decor. None of it reaches the physics, so it never showed up in
 * the state digest -- but it is exactly why two peers would look at visibly
 * different levels and reasonably conclude they had desynced.
 *
 * Seeding it from (mode, level) makes both peers build the same scenery from
 * the same level id, with no extra bytes on the wire.
 *
 * Every operation here is a 32-bit integer op plus one divide by 2^32, so the
 * arithmetic can never leave the exactly-representable range. That matters:
 * an earlier LCG in this project used `s * 1103515245`, which exceeds 2^53 and
 * silently produced *different numbers per host* -- indistinguishable from a
 * physics desync, and not one.
 */

/** FNV-1a over a string, for turning a level id into a seed. */
export function seedFrom(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2c;                       // separator, so ("a","bc") != ("ab","c")
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, and entirely 32-bit. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Uniform in [0, 1), the drop-in replacement for Math.random(). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
