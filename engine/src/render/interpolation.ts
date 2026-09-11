/** Display-only state. Nothing in this module is attached to the simulation. */
export interface VisualTransform { x: number; y: number; sx: number; sy: number; rot: number; }
export type VisualMode = "interpolate" | "predict" | "latest";

interface Entry {
  previous: VisualTransform;
  current: VisualTransform;
  output: VisualTransform;
  parent: object | null;
  revision: number;
  mode: VisualMode;
  dx: number;
  dy: number;
}

const copy = (out: VisualTransform, from: VisualTransform): void => {
  out.x = from.x; out.y = from.y; out.sx = from.sx; out.sy = from.sy; out.rot = from.rot;
};
const same = (a: VisualTransform, b: VisualTransform): boolean =>
  a.x === b.x && a.y === b.y && a.sx === b.sx && a.sy === b.sy && a.rot === b.rot;
/** Shortest arc, including negative angles and wraparound at 360 degrees. */
export const visualAngleDelta = (a: number, b: number): number => ((b - a + 180) % 360 + 360) % 360 - 180;

/**
 * One pair of transform samples per visible node, reused at every display frame.
 * Remote/world transforms interpolate one simulation step behind the latest.
 * The controlled character uses bounded linear extrapolation from the latest
 * step, so its first response is never postponed to the next simulation step.
 * This is a visual estimate, not collision prediction: the offset from the
 * latest state is bounded to one observed step. Future prediction error is
 * unknown and is corrected as soon as the next real state is available.
 */
export class VisualSnapshots {
  private entries = new WeakMap<object, Entry>();
  private revision = 0;
  private blockedPrediction = -1;
  private moving = false;
  private dirty = false;

  clear(): void {
    this.entries = new WeakMap();
    this.revision = 0;
    this.blockedPrediction = -1;
    this.moving = false;
    this.dirty = false;
  }

  begin(): void { this.revision++; this.moving = false; }
  /** Stop using a previous input's velocity until the new input is simulated. */
  inputChanged(): void { this.blockedPrediction = this.revision; }
  get hasMotion(): boolean { return this.moving; }
  /** A same-frame rollback correction must be presented even during a stall. */
  get presentationDirty(): boolean { return this.dirty; }
  invalidate(): void { this.dirty = true; }
  presented(): void { this.dirty = false; }

  capture(node: object, t: VisualTransform, parent: object | null, mode: VisualMode,
          reconcile = false): void {
    let e = this.entries.get(node);
    if (!e) {
      e = { previous: { ...t }, current: { ...t }, output: { ...t }, parent,
        revision: this.revision, mode, dx: 0, dy: 0 };
      this.entries.set(node, e);
      if (reconcile) this.dirty = true;
      return;
    }
    // Replayed frames are never published. Compare only the final corrected
    // state with the last published state; unchanged snapshot maintenance does
    // not restart interpolation every few ticks.
    if (reconcile) {
      if (!same(e.current, t) || e.parent !== parent || e.mode !== mode) {
        copy(e.previous, t); copy(e.current, t); e.dx = e.dy = 0;
        this.dirty = true;
      }
      e.parent = parent; e.mode = mode; e.revision = this.revision;
      return;
    }
    const dx = t.x - e.current.x, dy = t.y - e.current.y;
    const discontinuous = e.revision !== this.revision - 1 || e.parent !== parent ||
      e.mode !== mode || Math.abs(dx) > 64 || Math.abs(dy) > 64 ||
      Math.abs(visualAngleDelta(e.current.rot, t.rot)) > 90 ||
      e.current.sx * t.sx < 0 || e.current.sy * t.sy < 0;
    copy(e.previous, discontinuous ? t : e.current);
    copy(e.current, t);
    // An observed impact/reversal cancels extrapolation on that axis. It does
    // not move the simulation, or invent a future collision/world step.
    const safeDelta = (next: number, old: number): number =>
      next * old < 0 || (Math.abs(old) > 0.01 && Math.abs(next) < Math.abs(old) * 0.5) ? 0 : next;
    e.dx = discontinuous ? 0 : safeDelta(dx, e.dx);
    e.dy = discontinuous ? 0 : safeDelta(dy, e.dy);
    e.parent = parent; e.mode = mode; e.revision = this.revision;
    if (mode !== "latest" && !same(e.previous, e.current)) this.moving = true;
  }

  /** The returned transform is owned here and reused; consumers must not edit it. */
  sample(node: object, fallback: VisualTransform, alpha: number): VisualTransform {
    const e = this.entries.get(node);
    if (!e || e.revision !== this.revision || e.mode === "latest") return fallback;
    const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    const c = e.current, p = e.previous, out = e.output;
    if (e.mode === "predict") {
      const f = this.blockedPrediction === this.revision ? 0 : a;
      copy(out, c);
      out.x += e.dx * f; out.y += e.dy * f;
      return out;
    }
    out.x = p.x + (c.x - p.x) * a;
    out.y = p.y + (c.y - p.y) * a;
    out.sx = p.sx + (c.sx - p.sx) * a;
    out.sy = p.sy + (c.sy - p.sy) * a;
    out.rot = p.rot + visualAngleDelta(p.rot, c.rot) * a;
    return out;
  }
}
