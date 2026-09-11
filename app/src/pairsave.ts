import { supabase } from "./supabase.js";
import { auth } from "./auth.js";
import type { SaveStore } from "@engine/game/save.js";
import { acknowledge, mergeProgress, pendingFor, remember, type PendingProgress, type ProgressArrays } from "./outbox.js";

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
  const [lo, hi] = pairKey(owner, friendId);
  let query = supabase.from("pair_progress").select("node, medal, best_time_s, best_time_str").eq("user_a", lo).eq("user_b", hi);
  if (signal) query = query.abortSignal(signal);
  const { data: rows, error } = await query;
  if (error) throw new Error(error.message);
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
async function post(p: PendingProgress, keepalive = false): Promise<void> {
  const { data, error } = await supabase.auth.getSession();
  if (error || data.session?.user.id !== p.owner) throw new Error("Sign in to the account that earned this result");
  const response = await fetch(__SUPABASE_URL__ + "/rest/v1/rpc/sync_progress", {
    method: "POST", keepalive,
    headers: { apikey: __SUPABASE_KEY__, Authorization: "Bearer " + data.session.access_token, "content-type": "application/json" },
    body: JSON.stringify({ their_id: p.friendId, p_stats: p.stats, p_times: p.times, p_times_str: p.timesString }),
  });
  if (!response.ok) throw new Error("Progress could not be saved (" + response.status + ")");
  await acknowledge(p);
}

export function drainOutbox(): Promise<number> {
  const owner = auth().user?.id;
  if (!owner) return Promise.resolve(0);
  const active = drains.get(owner);
  if (active) return active;
  const run = async () => {
    let sent = 0;
    for (const pending of await pendingFor(owner)) {
      if (auth().user?.id !== owner) break;
      await post(pending);
      sent++;
    }
    return sent;
  };
  const draining = (async () => navigator.locks
    ? await navigator.locks.request("fbwg.progress." + owner, run) : await run())()
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
}

export function pairProgress(local: SaveStore): PairProgress {
  const owner = auth().user?.id ?? "";
  const data = local.data as ProgressArrays;
  let friendId: string | null = null;
  let solo: ProgressArrays | null = null;
  let durable = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0, saves = 0, waiting = 0, failures = 0;
  let lastError: string | null = null, storageError: string | null = null;
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
      saves += await drainOutbox();
      waiting = (await pendingFor(owner)).length;
      lastError = null; failures = 0;
    } catch (e) { lastError = (e as Error).message; failures++; retry(); }
    announce();
  }

  function confirmed(snapshot: ProgressArrays): void {
    if (!friendId || auth().user?.id !== owner || closed) return;
    const sig = signature(snapshot);
    if (sig === lastSignature) return;
    lastSignature = sig;
    const forFriend = friendId;
    const copy = read(snapshot);
    durable = durable.then(async () => {
      try {
        await remember(owner, forFriend, copy);
        waiting = (await pendingFor(owner)).length;
        storageError = null;
      } catch (e) { storageError = (e as Error).message; lastSignature = ""; }
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
    store: { data, flush: () => { if (!friendId) local.flush(); } },
    get shared() { return friendId !== null; }, get saves() { return saves; },
    get own() { return solo ? read(solo) : read(data); },
    get lastError() { return lastError; }, get storageError() { return storageError ?? local.lastError ?? null; },
    get waiting() { return waiting; },
    confirm: confirmed,
    onChange(fn) { listeners.add(fn); fn(); return () => listeners.delete(fn); },
    async adopt(id, signal) {
      const mine = ++generation;
      signal?.throwIfAborted();
      if (friendId) throw new Error("Leave the current pair before loading another");
      await flush();
      signal?.throwIfAborted();
      const [lo, hi] = pairKey(owner, id);
      let query = supabase.from("pair_progress").select("node, medal, best_time_s, best_time_str").eq("user_a", lo).eq("user_b", hi);
      if (signal) query = query.abortSignal(signal);
      const { data: rows, error } = await query;
      if (error) throw new Error(error.message);
      signal?.throwIfAborted();
      if (mine !== generation || closed || auth().user?.id !== owner) throw new Error("cancelled");
      let next = progressFromRows(rows as ProgressRow[] | null);
      // Not `readPairProgress`, which swallows an outbox failure because a
      // READER can live with the server's answer. Adopting cannot: this is the
      // map the next level's results are compared against, and a pending result
      // silently left out of it would let `Recuent` call a slower run an
      // improvement. So the same merge, with the error kept.
      try {
        for (const p of await pendingFor(owner)) if (p.friendId === id) next = mergeProgress(next, p);
      } catch (e) { storageError = (e as Error).message; }
      signal?.throwIfAborted();
      if (mine !== generation || closed || auth().user?.id !== owner) throw new Error("cancelled");
      solo = read(data); friendId = id; lastSignature = signature(next); write(data, next); announce();
    },
    async flushNow() { if (timer !== null) clearTimeout(timer); timer = null; await flush(); },
    async release() {
      generation++;
      if (!friendId) return;
      friendId = null;
      if (solo) write(data, solo);
      solo = null; lastSignature = "";
      local.flush(); announce();
      await flush();
    },
    beacon() {
      // Writes were made durable at confirmation, before this unload event.
      void durable.then(async () => {
        for (const p of await pendingFor(owner)) await post(p, true);
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
