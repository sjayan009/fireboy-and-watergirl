import { supabase } from "./supabase.js";
import { auth } from "./auth.js";
import type { SaveStore } from "@engine/game/save.js";
import { acknowledge, deliveryFailed, retryDelivery, mergeProgress, pendingFor, remember, type PendingProgress, type ProgressArrays } from "./outbox.js";

const SETTLE_MS = 1500;
const drains = new Map<string, Promise<number>>();

function blank(): ProgressArrays {
  const stats = new Array<number>(32).fill(-1); stats[0] = 0;
  return { stats, times: new Array<number>(32).fill(0), timesString: new Array<string>(32).fill("") };
}
function read(data: ProgressArrays): ProgressArrays {
  return { stats: data.stats.slice(), times: data.times.slice(), timesString: data.timesString.slice() };
}
function write(data: ProgressArrays, from: ProgressArrays): void {
  for (let i = 0; i < 32; i++) {
    data.stats[i] = from.stats[i] ?? -1;
    data.times[i] = from.times[i] ?? 0;
    data.timesString[i] = from.timesString[i] ?? "";
  }
}
const signature = (p: ProgressArrays) => p.stats.join(",") + ":" + p.times.join(",");

/** The two ids a `pair_progress` row is keyed by, in the order it stores them. */
export function pairKey(a: string, b: string): [string, string] {
  const sorted = [a, b].sort();
  return [sorted[0], sorted[1]];
}

export interface ProgressRow { node: number; medal: number; best_time_s: number | null; best_time_str: string | null }

/** A selected pair's read is cancellable and cannot hold the playable-ready barrier forever. */
async function pairRows(owner: string, friendId: string, signal?: AbortSignal): Promise<ProgressRow[] | null> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => controller.abort(new Error("Shared progress timed out. Retry to keep your existing results.")), 12000);
  const expired = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => {
    const reason = controller.signal.reason;
    reject(reason instanceof Error ? reason : new Error(String(reason ?? "cancelled")));
  }, { once: true }));
  try {
    const [lo, hi] = pairKey(owner, friendId);
    const query = supabase.from("pair_progress").select("node, medal, best_time_s, best_time_str").eq("user_a", lo).eq("user_b", hi).abortSignal(controller.signal);
    const { data, error } = await Promise.race([query, expired]);
    controller.signal.throwIfAborted();
    if (error) throw new Error(error.message);
    return data as ProgressRow[] | null;
  } finally { clearTimeout(deadline); signal?.removeEventListener("abort", abort); }
}

/**
 * `pair_progress` rows as the 32-entry arrays the game and the panels speak.
 *
 * Written out once rather than three times: `adopt` fills the live save from
 * it, and the Progress panel reads a friend's map with the same shape without
 * going anywhere near the live save.
 */
export function progressFromRows(rows: readonly ProgressRow[] | null): ProgressArrays {
  const next = blank();
  for (const row of rows ?? []) {
    const i = row.node - 1;
    if (i < 0 || i >= 32) continue;
    next.stats[i] = row.medal;
    next.times[i] = row.best_time_s ?? 0;
    next.timesString[i] = row.best_time_str ?? "";
  }
  return next;
}

/**
 * One pair's stored map, read without adopting it.
 *
 * The Progress panel lets you look at any friend's shared map, in or out of a
 * match, and looking must never disturb the game: `adopt` SWAPS the store the
 * running engine writes through, which is the opposite of what a reader wants.
 * This is the same query `adopt` runs, with the same outbox merge so a result
 * that has not been sent yet still shows, and no side effect at all.
 *
 * `progress_read` already permits it -- either member of an accepted friendship
 * may read their pair's rows whenever they like.
 */
export async function readPairProgress(owner: string, friendId: string, signal?: AbortSignal): Promise<ProgressArrays> {
  const rows = await pairRows(owner, friendId, signal);
  signal?.throwIfAborted();
  let next = progressFromRows(rows as ProgressRow[] | null);
  // Best effort: a browser that cannot open the outbox can still show what the
  // server has, and saying so is the save indicator's job rather than this one's.
  try {
    for (const p of await pendingFor(owner)) if (p.friendId === friendId) next = mergeProgress(next, p);
  } catch { /* the panel shows the server's answer */ }
  return next;
}

/** Snapshot the account's token before the request; auth can change in another tab. */
async function post(p: PendingProgress, keepalive = false, timeoutMs = 8000): Promise<void> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  const expired = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Cloud save timed out. The result remains on this device.")), { once: true }));
  try {
  const { data, error } = await Promise.race([supabase.auth.getSession(), expired]);
  if (error || data.session?.user.id !== p.owner || auth().user?.id !== p.owner) throw new DeliveryError("Sign in to the account that earned this result", 401);
  const response = await Promise.race([fetch(__SUPABASE_URL__ + "/rest/v1/rpc/sync_progress", {
    method: "POST", keepalive, signal: controller.signal,
    headers: { apikey: __SUPABASE_KEY__, Authorization: "Bearer " + data.session.access_token, "content-type": "application/json" },
    body: JSON.stringify({ their_id: p.friendId, p_stats: p.stats, p_times: p.times, p_times_str: p.timesString }),
  }), expired]);
  if (!response.ok) throw new DeliveryError("Progress could not be saved (" + response.status + ")", response.status, Number(response.headers.get("retry-after")) || 0);
  if (auth().user?.id !== p.owner || controller.signal.aborted) return;
  await Promise.race([acknowledge(p), expired]);
  } finally { clearTimeout(deadline); }
}

class DeliveryError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter = 0) { super(message); }
}

export function drainOutbox(): Promise<number> {
  const owner = auth().user?.id;
  if (!owner) return Promise.resolve(0);
  const active = drains.get(owner);
  if (active) return active;
  const run = async () => {
    let sent = 0;
    const until = Date.now() + 18000;
    const records = (await pendingFor(owner)).filter(p => !p.quarantine && (p.retryAt ?? 0) <= Date.now()).sort((a, b) => a.at - b.at);
    let next = 0, authFailed = false;
    const lane = async () => {
      while (next < records.length && Date.now() < until && !authFailed && auth().user?.id === owner) {
        const pending = records[next++];
        try { await post(pending, false, Math.max(1, Math.min(8000, until - Date.now()))); sent++; }
        catch (error) {
          const status = error instanceof DeliveryError ? error.status : 0;
          authFailed = status === 401;
          const quarantine = [400, 403, 404, 422].includes(status);
          const delay = error instanceof DeliveryError && error.retryAfter > 0 ? error.retryAfter * 1000 :
            Math.min(60000, 1500 * 2 ** Math.min(pending.attempts ?? 0, 5)) * (0.85 + Math.random() * 0.3);
          await deliveryFailed(pending, (error as Error).message, quarantine, Date.now() + delay);
        }
      }
    };
    await Promise.all([lane(), lane()]);
    return sent;
  };
  const draining = (async () => navigator.locks
    ? await navigator.locks.request("fbwg.progress." + owner, { ifAvailable: true }, lock => lock ? run() : 0) : await run())()
    .finally(() => drains.delete(owner));
  drains.set(owner, draining);
  return draining;
}

export interface PairProgress {
  readonly store: SaveStore;
  readonly shared: boolean;
  /**
   * This account's own map, whether or not a pair's is currently installed.
   *
   * `adopt` writes the pair's map INTO the local store's arrays and keeps the
   * solo copy privately, so during a match `store.data` is the pair's and the
   * solo one is reachable from nowhere. The Progress panel has to be able to
   * show "Just me" mid-match, so it is reachable from here -- a copy, because
   * a caller holding the live array would see it swapped underneath them when
   * the match ends.
   */
  readonly own: ProgressArrays;
  /** The active subject's confirmed canonical results, without predicted engine writes. */
  readonly current: ProgressArrays;
  readonly saves: number;
  readonly lastError: string | null;
  readonly storageError: string | null;
  readonly waiting: number;
  adopt(friendId: string, signal?: AbortSignal): Promise<void>;
  flushNow(): Promise<void>;
  release(): Promise<void>;
  beacon(): void;
  close(): void;
  onChange(fn: () => void): () => void;
  /** Only confirmed engine state is eligible for the pair outbox. */
  confirm(data: ProgressArrays): void;
  /** Adopt canonical solo only at a safe menu/release boundary. */
  refreshSolo(): void;
  pendingResults(): Promise<PendingProgress[]>;
  retryPending(friendId: string): Promise<void>;
}

export function pairProgress(local: SaveStore): PairProgress {
  const owner = auth().user?.id ?? "";
  const data = read(local.data as ProgressArrays);
  let friendId: string | null = null;
  const canonicalPairs = new Map<string, ProgressArrays>();
  let durable = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0, saves = 0, waiting = 0, failures = 0;
  let lastError: string | null = null, storageError: string | null = null;
  const storageFailures = new Map<string, string>();
  let closed = false;
  let lastSignature = "";
  const listeners = new Set<() => void>();
  const announce = () => { for (const fn of listeners) fn(); };

  const retry = () => {
    if (closed || timer !== null || auth().user?.id !== owner) return;
    timer = setTimeout(() => { timer = null; void flush(); }, Math.min(30000, SETTLE_MS * 2 ** Math.min(failures, 5)));
  };
  async function flush(): Promise<void> {
    await durable;
    if (auth().user?.id !== owner) return;
    try {
      // Storage may recover while the run is paused or already on its results.
      // Reattempt retained canonical results without waiting for another game frame.
      for (const id of [...storageFailures.keys()]) {
        const copy = canonicalPairs.get(id);
        if (!copy) continue;
        try { await remember(owner, id, copy); storageFailures.delete(id); }
        catch (error) { storageFailures.set(id, (error as Error).message); }
        if (auth().user?.id !== owner) return;
      }
      saves += await drainOutbox();
      const pending = (await pendingFor(owner)).filter(p => !friendId || p.friendId === friendId);
      waiting = pending.length;
      lastError = pending.find(p => p.error)?.error ?? null;
      failures = lastError ? failures + 1 : 0;
      if (waiting && pending.some(p => !p.quarantine)) retry();
    } catch (e) { lastError = (e as Error).message; failures++; retry(); }
    announce();
  }

  function confirmed(snapshot: ProgressArrays): void {
    if ((owner && auth().user?.id !== owner) || closed) return;
    if (!friendId) {
      const merged = mergeProgress(local.data, snapshot);
      if (signature(merged) !== signature(local.data)) { write(local.data, merged); local.flush(); announce(); }
      return;
    }
    const sig = signature(snapshot);
    if (sig === lastSignature) return;
    lastSignature = sig;
    const forFriend = friendId;
    const copy = mergeProgress(canonicalPairs.get(forFriend) ?? snapshot, snapshot);
    canonicalPairs.set(forFriend, copy);
    waiting++; announce();
    durable = durable.then(async () => {
      try {
        await remember(owner, forFriend, copy);
        const records = await pendingFor(owner);
        if (friendId === forFriend) waiting = records.filter(p => p.friendId === forFriend).length;
        storageFailures.delete(forFriend);
      } catch (e) { storageFailures.set(forFriend, (e as Error).message); if (friendId === forFriend) lastSignature = ""; }
      announce();
    });
    retry();
  }

  const onWake = () => { if (document.visibilityState === "visible") void flush(); };
  addEventListener("online", onWake);
  document.addEventListener("visibilitychange", onWake);
  // Ownerless records stay quarantined at their original key, never guessed at.
  try {
    if (localStorage.getItem("fbwg.pairoutbox")) storageError = "Older unsent results were preserved on this browser but cannot be assigned to an account safely";
  } catch { /* IndexedDB reports its own storage failure when first used. */ }

  return {
    // Engine flush may run during prediction/replay. Only confirm publishes.
    store: { data, lastError: null, flush: () => {} },
    get shared() { return friendId !== null; }, get saves() { return saves; },
    get own() { return read(local.data); },
    get current() { return read(friendId ? canonicalPairs.get(friendId) ?? data : local.data); },
    get lastError() { return lastError; }, get storageError() { return (friendId ? storageFailures.get(friendId) : local.lastError) ?? storageError ?? null; },
    get waiting() { return waiting; },
    confirm: confirmed,
    refreshSolo() { if (!friendId && !closed) write(data, local.data); },
    async pendingResults() {
      if (closed || auth().user?.id !== owner) return [];
      await durable;
      const results = await pendingFor(owner);
      return !closed && auth().user?.id === owner ? results : [];
    },
    async retryPending(id) { if (!closed && auth().user?.id === owner) { await retryDelivery(owner, id); await flush(); } },
    onChange(fn) { listeners.add(fn); fn(); return () => listeners.delete(fn); },
    async adopt(id, signal) {
      const mine = ++generation;
      signal?.throwIfAborted();
      if (friendId) throw new Error("Leave the current pair before loading another");
      // Selected-pair reads never wait for another friend's delivery.
      signal?.throwIfAborted();
      const rows = await pairRows(owner, id, signal);
      signal?.throwIfAborted();
      if (mine !== generation || closed || auth().user?.id !== owner) throw new Error("cancelled");
      let next = progressFromRows(rows as ProgressRow[] | null);
      // Not `readPairProgress`, which swallows an outbox failure because a
      // READER can live with the server's answer. Adopting cannot: this is the
      // map the next level's results are compared against, and a pending result
      // silently left out of it would let `Recuent` call a slower run an
      // improvement. So the same merge, with the error kept.
      try {
        const pending = (await pendingFor(owner)).filter(p => p.friendId === id);
        waiting = pending.length; lastError = pending.find(p => p.error)?.error ?? null;
        for (const p of pending) next = mergeProgress(next, p);
      } catch (e) { storageFailures.set(id, (e as Error).message); throw e; }
      signal?.throwIfAborted();
      if (mine !== generation || closed || auth().user?.id !== owner) throw new Error("cancelled");
      next = mergeProgress(canonicalPairs.get(id) ?? next, next);
      canonicalPairs.set(id, next); friendId = id; lastSignature = signature(next); write(data, next); announce();
    },
    async flushNow() {
      if (timer !== null) clearTimeout(timer); timer = null;
      try { await retryDelivery(owner, friendId ?? undefined); }
      catch (error) { lastError = (error as Error).message; announce(); }
      await flush();
    },
    async release() {
      generation++;
      if (!friendId) return;
      friendId = null;
      write(data, local.data);
      lastSignature = "";
      announce();
      await flush();
    },
    beacon() {
      // Writes were made durable at confirmation, before this unload event.
      void durable.then(async () => {
        for (const p of await pendingFor(owner)) {
          if (auth().user?.id !== owner) break;
          try { await post(p, true); } catch { /* each record remains durable independently */ }
        }
      }).catch(() => { /* The durable entry remains for the next authenticated visit. */ });
    },
    close() {
      closed = true; generation++;
      if (timer !== null) clearTimeout(timer);
      removeEventListener("online", onWake); document.removeEventListener("visibilitychange", onWake);
      listeners.clear();
    },
  };
}
