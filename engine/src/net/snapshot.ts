import type { Ported } from "../ported.js";
/**
 * Save and restore the whole simulation, so netplay can roll back.
 *
 * Lockstep never needed this: a peer that fell out of step rebuilt the level
 * and replayed the log, which is fast enough to be a hitch rather than a
 * disconnect. Rollback needs something stronger. It has to undo *the last few
 * frames* many times a second, and replaying from the start of the level each
 * time would cost 200 ms where it can afford about one.
 *
 * The approach is a generic reflective walk rather than a hand-written Box2D
 * serialiser, for two reasons. The obvious one is that the world graph is large
 * and hand-listing its fields is a standing invitation to forget one. The
 * subtler one is that the state that matters is not only Box2D's: the display
 * tree's playheads gate level completion, the contact listener counts diamonds,
 * and the level's own flags decide whether anyone has died. A walk reaches all
 * of it without being told about any of it.
 *
 * ## Restoring in place
 *
 * The snapshot keeps hard references to the objects themselves and writes their
 * field values back into those same instances. It never rebuilds the graph.
 * That is the load-bearing decision here, and it buys three things:
 *
 *  * **Identity survives.** `game.m_level`, the renderer's per-node caches and
 *    every cross-reference inside Box2D still point at the right objects after
 *    a restore, because they are the same objects.
 *  * **Objects created since the snapshot disappear correctly.** Nothing
 *    references them once the arrays and fields that did are rewritten.
 *  * **Objects destroyed since the snapshot come back.** The snapshot was still
 *    holding them, so they were never collected.
 *
 * ## Why the storage looks like this
 *
 * A first, obvious version -- one flat `any[]` of key, tag, value -- measured
 * **11.3 ms** per capture on adventure 1, which is a third of a 38.5 ms frame
 * and far too much to pay every frame. A census said why: 26,000 objects but
 * only about 107,000 fields, so the cost was not the state, it was ~105 ns of
 * overhead per field. Three things caused it, and each is now gone:
 *
 *  * `Object.keys()` allocated an array per object per capture -- 26,000 arrays
 *    a frame. `for...in` yields the same names in the same order and allocates
 *    nothing, into a list kept on the object and corrected as it is walked.
 *  * Every object-valued field cost a `Map.get`. Objects now carry a
 *    non-enumerable generation stamp, so "have I already seen this?" is a
 *    property load and a compare.
 *  * One mixed `any[]` holding numbers, strings and keys together is a generic
 *    array in every engine. Tags and numbers now live in typed arrays, and
 *    booleans, null and undefined are tags with no payload at all -- which
 *    matters, because the display tree is full of them.
 *
 * ## What is treated as opaque
 *
 * Functions are stored as references and never walked. So is anything whose
 * constructor is in FOREIGN -- images, audio nodes, promises, DOM. Those are
 * host objects the simulation reads but never mutates, and walking into one
 * would be both pointless and slow. `foreign` counts them, so a test can assert
 * that a level's graph does not touch any.
 *
 * The rule that follows is worth stating, because it has bitten once already:
 * **anything hung off the Game is simulation state, whether or not it was meant
 * to be.** The save store is the example -- its bag of progress arrays SHOULD
 * rewind with the game, but the bookkeeping it once kept beside them rewound
 * too, and a pending timer handle restored to a stale value is a timer that
 * never fires. Host machinery that must survive a rewind belongs in a closure
 * or behind a function, where a walk of the object graph cannot reach it.
 */

/** Value tags. Everything a field can hold, in the order it is cheapest. */
const T_NUM = 0;
const T_REF = 1;
const T_FALSE = 2;
const T_TRUE = 3;
const T_NULL = 4;
const T_UNDEF = 5;
/** Strings, functions, symbols -- anything held by reference in `others`. */
const T_OTHER = 6;

/** Kinds of walkable container. */
const K_OBJ = 0;
const K_ARR = 1;
const K_MAP = 2;
const K_SET = 3;

/**
 * Host objects that may be reachable but are never simulation state. Matched by
 * constructor name so this file does not have to import anything.
 */
const FOREIGN = new Set([
  "HTMLImageElement", "HTMLCanvasElement", "HTMLAudioElement", "Image",
  "CanvasRenderingContext2D", "AudioContext", "AudioBuffer",
  "AudioBufferSourceNode", "GainNode", "Promise", "WeakMap", "WeakSet",
  "RTCPeerConnection", "RTCDataChannel", "BroadcastChannel", "Window",
]);

/**
 * Cross-check every cached field list against the object's real one.
 *
 * The cache assumes an object's set of field NAMES stops changing once it has
 * been built -- its values change every frame, but not which fields exist. That
 * held for every object in all 32 levels when this was written, but AS3 symbol
 * classes are `dynamic` and the ported code is free to assign a new name at any
 * time, so it is an assumption rather than a guarantee.
 *
 * The first version of this cache was keyed by CONSTRUCTOR, which is the more
 * obvious idea and is wrong: `MovieClip` covers both plain clips and the
 * character clips, and the latter carry a `head`. Turning this on found that on
 * its first run, which is the argument for keeping it on in the tests.
 *
 * If the assumption ever breaks in production instead, the consequence is
 * bounded rather than silent: the new field is not snapshotted, the two peers
 * disagree, and the digest check that runs every eight frames catches it and
 * resyncs by replay.
 */
let verifying = false;
export function verify(on: boolean): void { verifying = on; }

/** Bumped once per capture; objects stamped with the current one are indexed. */
let GEN = 0;

export interface SnapshotStats {
  /** Objects walked. */
  objects: number;
  /** Fields recorded. */
  slots: number;
  /** Host objects held by reference rather than walked. */
  foreign: number;
  /** Bytes of the typed arrays, which is what a ring buffer of these costs. */
  bytes: number;
}

export class Snapshot {
  /** Every walked object, in discovery order. The index is the reference id. */
  private objs: Ported[] = [];
  /** Per object: container kind, field count, and the field names for K_OBJ. */
  private kind = new Uint8Array(1024);
  private count = new Uint32Array(1024);
  private keys: (string[] | null)[] = [];

  /** Per field, in object order: the tag, and a number or reference id. */
  private tags = new Uint8Array(4096);
  private nums = new Float64Array(4096);
  /** Strings and functions, in field order but compacted. */
  private others: Ported[] = [];

  private nObj = 0;
  private nSlot = 0;
  private nOther = 0;
  private gen = 0;
  foreign = 0;

  /** The frame this was taken after. The session keys its ring buffer by it. */
  frame = -1;
  /**
   * The simulation clock, which lives in a module variable and so is invisible
   * to any walk of the object graph. The host puts it here on the way in and
   * takes it back on the way out; `Recuent` awards the medal by reading it, so
   * restoring the world without restoring this would award a different one.
   */
  clock = 0;

  get stats(): SnapshotStats {
    return {
      objects: this.nObj, slots: this.nSlot, foreign: this.foreign,
      bytes: this.tags.length + this.nums.length * 8,
    };
  }

  // ---- capture ----------------------------------------------------------

  /**
   * Walk `roots` and record everything reachable.
   *
   * Reuses this instance's arrays, because the session keeps a ring of these
   * and re-fills them in place rather than allocating one per frame.
   */
  capture(roots: Ported[]): this {
    this.gen = ++GEN;
    this.nObj = 0;
    this.nSlot = 0;
    this.nOther = 0;
    this.foreign = 0;

    for (const r of roots) if (this.walkable(r)) this.idOf(r);

    // idOf appends as it discovers, so this loop grows while it runs. That is
    // the walk: breadth-first, no recursion, and therefore no stack to overflow
    // on a deep display tree.
    for (let i = 0; i < this.nObj; i++) this.record(i);

    // Anything left over from a larger previous capture would be restored on
    // top of this one.
    this.objs.length = this.nObj;
    this.others.length = this.nOther;
    return this;
  }

  /** The reference id of an object, assigning one on first sight. */
  private idOf(v: Ported): number {
    if (v.__sgen === this.gen) return v.__sid as number;
    const id = this.nObj++;
    if (v.__sgen === undefined) {
      // Non-enumerable, so the walk cannot see its own bookkeeping and neither
      // can anything else that iterates these objects.
      Object.defineProperty(v, "__sgen", { value: 0, writable: true,
                                           enumerable: false, configurable: true });
      Object.defineProperty(v, "__sid", { value: 0, writable: true,
                                          enumerable: false, configurable: true });
    }
    v.__sgen = this.gen;
    v.__sid = id;
    this.objs[id] = v;
    if (id >= this.kind.length) this.growObjects();
    return id;
  }

  private growObjects(): void {
    const k = new Uint8Array(this.kind.length * 2);
    k.set(this.kind);
    this.kind = k;
    const c = new Uint32Array(this.count.length * 2);
    c.set(this.count);
    this.count = c;
  }

  private growSlots(): void {
    const n = Math.max(this.tags.length * 2, this.nSlot + 64);
    const t = new Uint8Array(n);
    t.set(this.tags);
    this.tags = t;
    const v = new Float64Array(n);
    v.set(this.nums);
    this.nums = v;
  }

  /** Whether a value is a container this walk should descend into. */
  private walkable(v: Ported): boolean {
    if (v === null || typeof v !== "object") return false;
    const c = v.constructor;
    if (c !== undefined && FOREIGN.has(c.name)) { this.foreign++; return false; }
    return true;
  }

  private push(v: Ported): void {
    const s = this.nSlot++;
    if (s >= this.tags.length) this.growSlots();
    const t = typeof v;
    if (t === "number") { this.tags[s] = T_NUM; this.nums[s] = v; return; }
    if (t === "object") {
      if (v === null) { this.tags[s] = T_NULL; return; }
      const c = v.constructor;
      if (c !== undefined && FOREIGN.has(c.name)) {
        this.foreign++;
        this.tags[s] = T_OTHER;
        this.others[this.nOther++] = v;
        return;
      }
      this.tags[s] = T_REF;
      this.nums[s] = this.idOf(v);
      return;
    }
    if (t === "boolean") { this.tags[s] = v ? T_TRUE : T_FALSE; return; }
    if (v === undefined) { this.tags[s] = T_UNDEF; return; }
    this.tags[s] = T_OTHER;
    this.others[this.nOther++] = v;
  }

  /**
   * The field names of an object, kept on the object and refreshed as it goes.
   *
   * `Object.keys` was the obvious way to do this and cost an array allocation
   * per object per capture -- 26,000 of them a frame, which was most of the
   * original 11.3 ms. Caching the result instead was the obvious fix and is
   * WRONG: objects here really do grow fields as they run. `level` gains
   * `allowjump1` and three siblings the first time somebody jumps, and they are
   * as much simulation state as anything else. A cached list silently drops
   * them, which is a desync that looks like a physics bug.
   *
   * So: `for...in` yields the same names in the same order with no allocation
   * at all, and the cached array is corrected in place as it is walked. Nothing
   * is assumed to stay still; the cost of a shape that changed is one string
   * comparison per field, which is a pointer compare because property names are
   * interned.
   */
  private fieldsOf(o: Ported): string[] {
    let ks: string[] | undefined = o.__skeys;
    if (ks === undefined) {
      ks = [];
      // Non-enumerable, so `for...in` never sees the walk's own bookkeeping.
      Object.defineProperty(o, "__skeys", { value: ks, writable: true,
                                            enumerable: false, configurable: true });
    }
    let n = 0;
    for (const k in o) {
      if (ks[n] !== k) ks[n] = k;
      n++;
    }
    if (ks.length !== n) ks.length = n;
    if (verifying) {
      const real = Object.keys(o);
      if (real.length !== ks.length || real.some((k, i) => k !== ks![i])) {
        const what = o.constructor ? o.constructor.name : "object";
        throw new Error(
          `for...in and Object.keys disagree about a ${what}, so something is ` +
          `enumerable on a prototype. Walked [${ks.join(", ")}], own ` +
          `[${real.join(", ")}].`);
      }
    }
    return ks;
  }

  private record(i: number): void {
    const o = this.objs[i];
    if (Array.isArray(o)) {
      this.kind[i] = K_ARR;
      this.count[i] = o.length;
      for (let j = 0; j < o.length; j++) this.push(o[j]);
      return;
    }
    if (o instanceof Map) {
      this.kind[i] = K_MAP;
      this.count[i] = o.size;
      for (const [k, v] of o) { this.push(k); this.push(v); }
      return;
    }
    if (o instanceof Set) {
      this.kind[i] = K_SET;
      this.count[i] = o.size;
      for (const v of o) this.push(v);
      return;
    }
    // Own enumerable properties only. Accessors declared on the prototype --
    // DisplayObject's `stage`, `loaderInfo`, `mask` -- are deliberately out of
    // reach. `mask` is the one that matters: its backing field `_mask` IS an own
    // property and is captured, and going through the setter on restore would
    // re-run its isMask bookkeeping against a half-restored graph.
    const ks = this.fieldsOf(o);
    this.kind[i] = K_OBJ;
    this.count[i] = ks.length;
    this.keys[i] = ks;
    for (let j = 0; j < ks.length; j++) this.push(o[ks[j]]);
  }

  // ---- restore ----------------------------------------------------------

  /** Put every recorded field back where it was. */
  restore(): void {
    const { objs, kind, count, keys, tags, nums, others } = this;
    let p = 0;
    let q = 0;

    // Reading one field: the mirror of push(). The two cursors are why this is
    // a closure rather than a method -- `others` is compacted, so it advances
    // only on the tags that actually consumed one.
    const value = (): Ported => {
      const t = tags[p];
      const n = nums[p];
      p++;
      switch (t) {
        case T_NUM: return n;
        case T_REF: return objs[n];
        case T_FALSE: return false;
        case T_TRUE: return true;
        case T_NULL: return null;
        case T_UNDEF: return undefined;
        default: return others[q++];
      }
    };

    for (let i = 0; i < this.nObj; i++) {
      const o = objs[i];
      const n = count[i];
      const k = kind[i];

      if (k === K_ARR) {
        o.length = n;
        for (let j = 0; j < n; j++) o[j] = value();
        continue;
      }
      if (k === K_MAP) {
        o.clear();
        for (let j = 0; j < n; j++) { const key = value(); o.set(key, value()); }
        continue;
      }
      if (k === K_SET) {
        o.clear();
        for (let j = 0; j < n; j++) o.add(value());
        continue;
      }

      const ks = keys[i]!;
      for (let j = 0; j < n; j++) o[ks[j]] = value();

      // A plain object may have GAINED keys since the snapshot -- AS3 symbol
      // classes are dynamic and the ported code does assign new fields as it
      // runs. Putting the old values back is not enough on its own; the keys
      // that were not there then have to go. Writing every recorded key back
      // means the object now holds at least those n, so a count above n is
      // exactly a set of extra keys, and the list is only built when there is
      // one.
      if (Object.keys(o).length !== n) {
        const had = new Set(ks);
        for (const key of Object.keys(o)) if (!had.has(key)) delete o[key];
      }
    }
  }
}
