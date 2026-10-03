/** Renderer-owned scratch surfaces. A lease remains exclusive across nested draws. */
export interface TileRect { x: number; y: number; w: number; h: number; }
export interface SurfaceLease { canvas: HTMLCanvasElement; release(): void; }

export class ScratchPool {
  private surfaces: { canvas: HTMLCanvasElement; busy: boolean; used: number }[] = [];
  private clock = 0;
  allocations = 0;
  peakPixels = 0;
  constructor(readonly maxPixels = 2 * 1024 * 1024) {}

  acquire(width: number, height: number): SurfaceLease {
    const w = Math.max(1, Math.ceil(width / 32) * 32);
    const h = Math.max(1, Math.ceil(height / 32) * 32);
    let slot = this.surfaces.filter(s => !s.busy && s.canvas.width >= w && s.canvas.height >= h)
      .sort((a, b) => a.canvas.width * a.canvas.height - b.canvas.width * b.canvas.height)[0];
    if (!slot) {
      const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
      slot = { canvas, busy: false, used: 0 }; this.surfaces.push(slot); this.allocations++;
    }
    slot.busy = true; slot.used = ++this.clock;
    this.peakPixels = Math.max(this.peakPixels, this.pixels);
    this.trim();
    let released = false;
    return { canvas: slot.canvas, release: () => {
      if (released) return; released = true; slot.busy = false; this.trim();
    } };
  }

  get pixels(): number { return this.surfaces.reduce((n, s) => n + s.canvas.width * s.canvas.height, 0); }
  private trim(): void {
    // In-flight nested operations may exceed the retention limit temporarily.
    // Once released, oversized surfaces are discarded rather than retained.
    for (const s of [...this.surfaces].sort((a, b) => a.used - b.used)) {
      if (this.pixels <= this.maxPixels) break;
      if (s.busy) continue;
      this.surfaces.splice(this.surfaces.indexOf(s), 1); s.canvas.width = s.canvas.height = 1;
    }
  }
  clear(): void { for (const s of this.surfaces) s.canvas.width = s.canvas.height = 1; this.surfaces = []; }
}

export interface CachedTile {
  canvas: HTMLCanvasElement;
  rect: TileRect;
  dependencies: Map<string, number>;
}

/** One renderer-wide LRU budget, including terrain and recurring character poses. */
export class TileCache {
  private entries = new Map<string, CachedTile>();
  bytes = 0;
  evictions = 0;
  constructor(readonly maxBytes = 16 * 1024 * 1024) {}
  get(key: string, revision: (key: string) => number): CachedTile | undefined {
    const tile = this.entries.get(key);
    if (!tile) return;
    for (const [url, version] of tile.dependencies) if (revision(url) !== version) {
      this.delete(key); return;
    }
    this.entries.delete(key); this.entries.set(key, tile); return tile;
  }
  set(key: string, tile: CachedTile): void {
    this.delete(key);
    const bytes = tile.canvas.width * tile.canvas.height * 4;
    if (bytes > this.maxBytes) return;
    this.entries.set(key, tile); this.bytes += bytes;
    while (this.bytes > this.maxBytes) { this.delete(this.entries.keys().next().value!); this.evictions++; }
  }
  delete(key: string): void {
    const old = this.entries.get(key); if (!old) return;
    this.bytes -= old.canvas.width * old.canvas.height * 4;
    this.entries.delete(key);
  }
  get size(): number { return this.entries.size; }
  clear(): void { this.entries.clear(); this.bytes = 0; }
}

export function intersect(a: TileRect, b: TileRect): TileRect {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x),
    h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}
export function union(a: TileRect, b: TileRect): TileRect {
  if (!a.w || !a.h) return b; if (!b.w || !b.h) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
export function transformed(rect: TileRect, m: DOMMatrix): TileRect | null {
  const points = [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x, rect.y + rect.h], [rect.x + rect.w, rect.y + rect.h]]
    .map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
  if (points.some(p => p.some(v => !Number.isFinite(v)))) return null;
  const x = Math.min(...points.map(p => p[0])), y = Math.min(...points.map(p => p[1]));
  return { x, y, w: Math.max(...points.map(p => p[0])) - x, h: Math.max(...points.map(p => p[1])) - y };
}
