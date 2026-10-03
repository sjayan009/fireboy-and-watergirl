/** Shared resource service. Ownership and scheduling live outside the Game graph. */
export type AssetPriority = "critical" | "near" | "background";
export type AssetState = "pending" | "ready" | "error" | "missing";
export interface AssetOptions {
  owner?: AssetOwner; priority?: AssetPriority; deadlineMs?: number; signal?: AbortSignal;
}
export interface ImageResource { image: HTMLImageElement; ready: Promise<void>; }
interface Resource {
  key: string; url: string; kind: "image" | "json"; state: AssetState;
  image?: HTMLImageElement; value?: unknown; ready: Promise<unknown>;
  resolve: (value?: unknown) => void; reject: (error: Error) => void;
  owners: Map<AssetOwner, AssetPriority>; priority: AssetPriority; legacy: boolean;
  created: number; touched: number; bytes: number; running: boolean;
  controller: AbortController; timer: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
}
const resources = new Map<string, Resource>();
const states = new Map<string, { revision: number; state: AssetState }>();
const queue = new Set<Resource>();
const liveOwners = new Set<AssetOwner>();
const rank: Record<AssetPriority, number> = { critical: 0, near: 1, background: 2 };
let active = 0, revision = 0, decodedBytes = 0;
let releasing = 0;
let lanes = 12, byteBudget = 64 * 1024 * 1024, documentBudget = 128;
const counters = { hits: 0, failures: 0, cancelled: 0, evictions: 0, waitMs: 0, loadMs: 0 };
const now = (): number => typeof performance === "undefined" ? Date.now() : performance.now();
const abortError = (): Error => new DOMException("Asset preparation cancelled", "AbortError");
function changed(r: Resource): void {
  revision++;
  states.set(r.url, { revision, state: r.state });
  if (states.size > 8192) for (const url of states.keys()) {
    if (!resources.has(`image:${url}`) && !resources.has(`json:${url}`)) states.delete(url);
    if (states.size <= 8192) break;
  }
}
export function assetRevision(): number { return revision; }
export function assetContentRevision(url: string): number { return states.get(url)?.revision ?? 0; }
export function assetContentState(url: string): { revision: number; state: AssetState } {
  return states.get(url) ?? { revision: 0, state: "missing" };
}
/** Active owners pin resources; these limits apply to the cold reusable cache. */
export function configureAssetBudget(options: { bytes?: number; documents?: number; lanes?: number }): void {
  if (options.bytes != null) byteBudget = Math.max(0, options.bytes);
  if (options.documents != null) documentBudget = Math.max(0, options.documents);
  if (options.lanes != null) lanes = Math.max(1, Math.min(32, options.lanes));
  trim(); pump();
}
export function assetMetrics(): object {
  const tiers = { critical: 0, near: 0, background: 0 };
  let pinnedBytes = 0;
  for (const r of resources.values()) {
    if (r.owners.size) pinnedBytes += r.bytes;
    if (r.state === "pending") tiers[r.priority]++;
  }
  return { ...counters, queued: queue.size, active, tiers, decodedBytes, pinnedBytes,
    byteBudget, entries: resources.size, consumers: liveOwners.size,
    owners: [...liveOwners].reduce((count, owner) => count + owner.count, 0) };
}
function trim(): void {
  if (releasing) return;
  const cold = [...resources.values()].filter(r => r.state === "ready" && !r.owners.size)
    .sort((a, b) => a.touched - b.touched);
  let documents = [...resources.values()].filter(r => r.kind === "json").length;
  for (const r of cold) {
    if (decodedBytes <= byteBudget && documents <= documentBudget) break;
    resources.delete(r.key); decodedBytes -= r.bytes;
    if (r.kind === "json") documents--;
    counters.evictions++; r.state = "missing"; changed(r);
  }
}
function settle(r: Resource, error?: Error, value?: unknown): void {
  if (r.state !== "pending") return;
  queue.delete(r); clearTimeout(r.timer); r.cleanup?.();
  if (r.running) { active--; counters.loadMs += now() - r.touched; }
  r.running = false; r.state = error ? "error" : "ready"; r.touched = now();
  if (error) {
    resources.delete(r.key); counters.failures++; changed(r); r.reject(error);
  } else {
    r.value = value;
    if (r.image) r.bytes = r.image.naturalWidth * r.image.naturalHeight * 4;
    decodedBytes += r.bytes; changed(r); r.resolve(value);
  }
  trim(); pump();
}
function cancelIfUnused(r: Resource): void {
  if (r.state === "pending" && !r.owners.size && !r.legacy) {
    counters.cancelled++; r.controller.abort(); settle(r, abortError());
  }
}
function start(r: Resource): void {
  active++; r.running = true; counters.waitMs += now() - r.created; r.touched = now();
  if (r.kind === "json") {
    void fetch(r.url, { cache: "force-cache", signal: r.controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`Asset unavailable (${response.status})`);
      const value: unknown = await response.json(); settle(r, undefined, value);
    }).catch((error: unknown) => settle(r, error instanceof Error ? error : new Error(typeof error === "string" ? error : "Asset loading failed")));
    return;
  }
  const img = r.image!;
  r.cleanup = () => { img.onload = null; img.onerror = null; };
  r.controller.signal.addEventListener("abort", () => { img.src = ""; }, { once: true });
  img.onload = () => {
    // Browsers that cannot decode a supported SVG still report usable natural dimensions.
    void img.decode().catch(() => undefined).then(() => settle(r));
  };
  img.onerror = () => settle(r, new Error("Some game art could not be loaded"));
  img.src = r.url;
}
function pump(): void {
  if (releasing) return;
  while (active < lanes && queue.size) {
    const time = now();
    // Age by a tier every two seconds. Ties preserve creation order.
    const next = [...queue].sort((a, b) =>
      Math.max(0, rank[a.priority] - Math.floor((time - a.created) / 2000)) -
      Math.max(0, rank[b.priority] - Math.floor((time - b.created) / 2000)) || a.created - b.created)[0];
    queue.delete(next); start(next);
  }
}
function request(kind: Resource["kind"], url: string, options: AssetOptions = {}): Resource {
  options.signal?.throwIfAborted();
  if (options.owner?.released) throw abortError();
  const key = `${kind}:${url}`;
  let r = resources.get(key);
  if (r) { counters.hits++; r.touched = now(); }
  else {
    let resolve!: Resource["resolve"], reject!: Resource["reject"];
    const ready = new Promise<unknown>((ok, fail) => { resolve = ok; reject = fail; });
    void ready.catch(() => undefined);
    r = { key, url, kind, state: "pending", image: kind === "image" ? new Image() : undefined,
      ready, resolve, reject, owners: new Map(), priority: options.priority ?? options.owner?.priority ?? "near",
      legacy: !options.owner, created: now(), touched: now(), bytes: 0, running: false,
      controller: new AbortController(), timer: undefined! };
    const resource = r;
    // Deadline begins at creation, including queue time and metadata parsing.
    r.timer = setTimeout(() => {
      resource.controller.abort(); settle(resource, new Error("Asset loading deadline exceeded"));
    }, options.deadlineMs ?? 15000);
    resources.set(key, r); queue.add(r); changed(r);
  }
  if (options.owner) options.owner.retain(r, options.priority ?? options.owner.priority);
  else r.legacy = true;
  if (rank[options.priority ?? "background"] < rank[r.priority]) r.priority = options.priority!;
  pump(); return r;
}
function forSignal<T>(ready: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return ready;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const abort = (): void => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    void ready.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
/** One view/preparation owns each resource once, independent of other consumers. */
export class AssetOwner {
  private held = new Map<string, Resource>();
  private controller = new AbortController();
  private detach?: () => void;
  released = false;
  constructor(public priority: AssetPriority = "near", signal?: AbortSignal) {
    liveOwners.add(this);
    if (signal) {
      const abort = (): void => this.release();
      signal.addEventListener("abort", abort, { once: true });
      this.detach = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) this.release();
    }
  }
  retain(r: Resource, priority: AssetPriority): void {
    const old = this.held.get(r.key);
    if (old && old !== r) { old.owners.delete(this); cancelIfUnused(old); }
    this.held.set(r.key, r); r.owners.set(this, priority);
    if (rank[priority] < rank[r.priority]) r.priority = priority;
  }
  promote(priority: AssetPriority): void {
    this.priority = priority;
    for (const r of this.held.values()) {
      r.owners.set(this, priority);
      r.priority = [...r.owners.values()].sort((a, b) => rank[a] - rank[b])[0] ?? priority;
    }
    pump();
  }
  image(url: string, options: Omit<AssetOptions, "owner"> = {}): ImageResource {
    return imageAsset(url, { ...options, owner: this });
  }
  json<T>(url: string, options: Omit<AssetOptions, "owner"> = {}): Promise<T> {
    return jsonAsset<T>(url, { ...options, owner: this });
  }
  consumer<T>(ready: Promise<T>, signal?: AbortSignal): Promise<T> {
    return forSignal(forSignal(ready, this.controller.signal), signal);
  }
  release(): void {
    if (this.released) return;
    this.released = true; liveOwners.delete(this); this.detach?.(); this.controller.abort();
    releasing++;
    try {
      // Remove the whole consumer before pumping, so release cannot start its next obsolete job.
      for (const r of this.held.values()) r.owners.delete(this);
      for (const r of this.held.values()) cancelIfUnused(r);
      this.held.clear();
    } finally { releasing--; }
    trim(); pump();
  }
  get count(): number { return this.held.size; }
}
export function createAssetOwner(options: AssetOptions = {}): AssetOwner {
  return new AssetOwner(options.priority, options.signal);
}
export function jsonAsset<T>(url: string, options: AssetOptions = {}): Promise<T> {
  const r = request("json", url, options);
  const ready = r.ready as Promise<T>;
  return options.owner ? options.owner.consumer(ready, options.signal) : forSignal(ready, options.signal);
}
export function imageAsset(url: string, options: AssetOptions = {}): ImageResource {
  const r = request("image", url, options);
  const ready = r.ready.then(() => undefined);
  return { image: r.image!, ready: options.owner ? options.owner.consumer(ready, options.signal) : forSignal(ready, options.signal) };
}
