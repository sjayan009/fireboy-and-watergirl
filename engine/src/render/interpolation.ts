/** Display-only state. Nothing in this module is attached to the simulation. */
export interface VisualTransform { x: number; y: number; sx: number; sy: number; rot: number; }
export type VisualMode = "interpolate" | "predict" | "latest";

export interface VisualSnapshotOptions {
  /** Staged rollout switches; false keeps rollback snaps and latest local descendants. */
  rollbackSmoothing?: boolean;
  localDescendantInterpolation?: boolean;
  /** Monotonic milliseconds; injectable for deterministic presentation tests. */
  now?: () => number;
}

export interface VisualCaptureOptions {
  now?: number;
  /** Identity/revision of the art, separate from this object's capture sequence. */
  identity?: unknown;
  revision?: unknown;
  /** Semantic life/scene state. Animation playhead frames are deliberately excluded. */
  state?: unknown;
  /** Explicit teleports or a discontinuity in an ancestor's coordinate space. */
  snap?: boolean;
  /** Upper bound on parent-local units to stage pixels, including ancestor scales. */
  worldScale?: number;
}

interface Entry {
  previous: VisualTransform;
  current: VisualTransform;
  output: VisualTransform;
  presented: VisualTransform | null;
  error: VisualTransform;
  correctionStart: number;
  parent: object | null;
  revision: number;
  identity: unknown;
  objectRevision: unknown;
  state: unknown;
  mode: VisualMode;
  dx: number;
  dy: number;
}

/** The game's 20 local px/physics unit become 16 stage px at level scale 0.8. */
export const VISUAL_CORRECTION_LIMIT_PX = 56;
export const VISUAL_CORRECTION_MS = 80;
const copy = (out: VisualTransform, from: VisualTransform): void => {
  out.x = from.x; out.y = from.y; out.sx = from.sx; out.sy = from.sy; out.rot = from.rot;
};
const same = (a: VisualTransform, b: VisualTransform): boolean =>
  a.x === b.x && a.y === b.y && a.sx === b.sx && a.sy === b.sy && a.rot === b.rot;
/** Shortest arc, including negative angles and wraparound at 360 degrees. */
export const visualAngleDelta = (a: number, b: number): number => ((b - a + 180) % 360 + 360) % 360 - 180;
const semanticTransformChange = (a: VisualTransform, b: VisualTransform): boolean =>
  Math.abs(visualAngleDelta(a.rot, b.rot)) > 90 ||
  Math.sign(a.sx) !== Math.sign(b.sx) || Math.sign(a.sy) !== Math.sign(b.sy);

/**
 * One pair of local transform samples per visible node, reused at every display
 * frame. World nodes interpolate one step behind; controlled roots extrapolate
 * by at most one observed step so local controls are never delayed.
 *
 * Optional reconciliation residuals offset presentation only. The corrected
 * transform is accepted immediately, and a small error relative to the last
 * actual draw decays over 80 ms, including while the simulation is stalled.
 */
export class VisualSnapshots {
  private entries = new WeakMap<object, Entry>();
  private residuals = new Set<Entry>();
  private revision = 0;
  private blockedPrediction = -1;
  private moving = false;
  private dirty = false;
  private presentationTime: number | null = null;
  private readonly clock: () => number;
  readonly rollbackSmoothing: boolean;
  readonly localDescendantInterpolation: boolean;

  constructor(o: VisualSnapshotOptions = {}) {
    this.clock = o.now ?? (() => performance.now());
    this.rollbackSmoothing = o.rollbackSmoothing === true;
    this.localDescendantInterpolation = o.localDescendantInterpolation === true;
  }

  clear(): void {
    this.entries = new WeakMap();
    this.residuals.clear();
    this.revision = 0;
    this.blockedPrediction = -1;
    this.moving = false;
    this.dirty = false;
    this.presentationTime = null;
  }

  begin(): void { this.revision++; this.moving = false; }
  /** Stop using a previous input's velocity until the new input is simulated. */
  inputChanged(): void { this.blockedPrediction = this.revision; }
  get hasMotion(): boolean { return this.moving || this.residuals.size > 0; }
  /** A same-frame rollback correction must be presented even during a stall. */
  get presentationDirty(): boolean { return this.dirty; }
  invalidate(): void { this.dirty = true; }
  /** Use the sampled frame time even if rasterization finishes after the decay deadline. */
  beginPresentation(now = this.clock()): void { this.presentationTime = now; }
  presented(now = this.presentationTime ?? this.clock()): void {
    this.dirty = false;
    this.presentationTime = null;
    // Finish on a real draw, so the last residual-free image is never skipped.
    for (const e of this.residuals) if (now - e.correctionStart >= VISUAL_CORRECTION_MS || e.revision !== this.revision) {
      this.residuals.delete(e);
    }
  }

  /** Called only by actual canvas traversal; hit testing must not change this. */
  recordPresented(node: object, transform: VisualTransform): void {
    if (!this.rollbackSmoothing) return;
    const e = this.entries.get(node);
    if (!e || e.revision !== this.revision) return;
    if (e.presented) copy(e.presented, transform);
    else e.presented = { ...transform };
  }

  /** Hidden/dead/replaced art cannot reuse its previous pose on reappearance. */
  forget(node: object): void {
    const e = this.entries.get(node);
    if (!e) return;
    this.residuals.delete(e);
    this.entries.delete(node);
  }

  /** Returns whether this node snapped, allowing children to discard the old coordinate space. */
  capture(node: object, t: VisualTransform, parent: object | null, mode: VisualMode,
          reconcile = false, o: VisualCaptureOptions = {}): boolean {
    let e = this.entries.get(node);
    if (!e) {
      e = { previous: { ...t }, current: { ...t }, output: { ...t }, presented: null,
        error: { x: 0, y: 0, sx: 0, sy: 0, rot: 0 }, correctionStart: 0, parent,
        revision: this.revision, mode, identity: o.identity, objectRevision: o.revision,
        state: o.state, dx: 0, dy: 0 };
      this.entries.set(node, e);
      if (reconcile) this.dirty = true;
      return true;
    }
    const dx = t.x - e.current.x, dy = t.y - e.current.y;
    const scale = Number.isFinite(o.worldScale) ? Math.abs(o.worldScale!) : 1;
    const changedIdentity = e.parent !== parent || e.mode !== mode || e.identity !== o.identity ||
      e.objectRevision !== o.revision || e.state !== o.state;
    const discontinuous = o.snap === true || changedIdentity ||
      e.revision !== this.revision - (reconcile ? 0 : 1) ||
      (this.rollbackSmoothing || this.localDescendantInterpolation ? Math.hypot(dx, dy) * scale > VISUAL_CORRECTION_LIMIT_PX :
        Math.abs(dx) > 64 || Math.abs(dy) > 64) || semanticTransformChange(e.current, t);

    // Replayed frames are never published. Unchanged maintenance preserves
    // interpolation and does not restart an in-flight correction's timer.
    if (reconcile) {
      if (!same(e.current, t) || discontinuous) {
        const old = e.presented;
        const smooth = this.rollbackSmoothing && mode !== "latest" && !discontinuous && old !== null &&
          !semanticTransformChange(old, t) && Math.hypot(old.x - t.x, old.y - t.y) * scale <= VISUAL_CORRECTION_LIMIT_PX;
        this.residuals.delete(e);
        if (smooth) {
          e.error.x = old.x - t.x; e.error.y = old.y - t.y;
          e.error.sx = old.sx - t.sx; e.error.sy = old.sy - t.sy;
          e.error.rot = visualAngleDelta(t.rot, old.rot);
          e.correctionStart = o.now ?? this.clock();
          if (!same(old, t)) this.residuals.add(e);
        } else e.presented = null;
        copy(e.previous, t); copy(e.current, t); e.dx = e.dy = 0;
        this.dirty = true;
      }
    } else {
      copy(e.previous, discontinuous ? t : e.current);
      copy(e.current, t);
      // An observed impact/reversal cancels extrapolation on that axis.
      const safeDelta = (next: number, old: number): number =>
        next * old < 0 || (Math.abs(old) > 0.01 && Math.abs(next) < Math.abs(old) * 0.5) ? 0 : next;
      e.dx = discontinuous ? 0 : safeDelta(dx, e.dx);
      e.dy = discontinuous ? 0 : safeDelta(dy, e.dy);
      if (discontinuous) { this.residuals.delete(e); e.presented = null; }
      if (mode !== "latest" && !same(e.previous, e.current)) this.moving = true;
    }
    e.parent = parent; e.mode = mode; e.revision = this.revision;
    e.identity = o.identity; e.objectRevision = o.revision; e.state = o.state;
    return discontinuous;
  }

  /** The returned transform is owned here and reused; consumers must not edit it. */
  sample(node: object, fallback: VisualTransform, alpha: number, now = this.clock()): VisualTransform {
    const e = this.entries.get(node);
    if (!e || e.revision !== this.revision || e.mode === "latest") return fallback;
    const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    const c = e.current, p = e.previous, out = e.output;
    if (e.mode === "predict") {
      const f = this.blockedPrediction === this.revision ? 0 : a;
      copy(out, c);
      out.x += e.dx * f; out.y += e.dy * f;
    } else {
      out.x = p.x + (c.x - p.x) * a;
      out.y = p.y + (c.y - p.y) * a;
      out.sx = p.sx + (c.sx - p.sx) * a;
      out.sy = p.sy + (c.sy - p.sy) * a;
      out.rot = p.rot + visualAngleDelta(p.rot, c.rot) * a;
    }
    if (this.residuals.has(e)) {
      const t = Math.max(0, Math.min(1, (now - e.correctionStart) / VISUAL_CORRECTION_MS));
      const residual = 1 - t * t * (3 - 2 * t);
      out.x += e.error.x * residual; out.y += e.error.y * residual;
      out.sx += e.error.sx * residual; out.sy += e.error.sy * residual;
      out.rot += e.error.rot * residual;
    }
    return out;
  }
}
