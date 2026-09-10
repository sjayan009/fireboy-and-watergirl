/**
 * Progress earned alone, kept against the account rather than the browser.
 *
 * The ported game saves through one `SaveStore`, and until now that store was
 * `localStorage` under the key `FBCookie` -- the shape the 2009 SharedObject
 * had, carried straight across. One key, with no account anywhere in it, so
 * progress belonged to a MACHINE: sign out, sign in as somebody else, and the
 * next account opened with the last person's map unlocked and their times on
 * it. Clearing site data threw it away, a second device never had it, and
 * deleting the account could not reach it.
 *
 * Two things change that, and both are needed.
 *
 * **The key carries the account.** `FBCookie:<user id>`, so two people on one
 * laptop no longer share a save even before anything reaches the network.
 *
 * **The server holds the truth.** `sync_solo_progress` merges what this browser
 * has into what the account has and hands the whole answer back, so a phone and
 * a laptop converge instead of overwriting each other.
 *
 * ## Local first, still
 *
 * The local save is not demoted to a cache that can be skipped. The game reads
 * and writes it mid-level, synchronously, through an interface that cannot wait
 * for a network call -- and somebody playing on a train has to keep their
 * medals. So the order is: the game writes locally as it always did, and this
 * pushes what accumulated up afterwards. A failed sync costs nothing; the next
 * one carries the same result, because the merge takes the best of both and
 * does not care how many times it is told.
 */
import { supabase } from "./supabase.js";
import { auth } from "./auth.js";
import { LocalSave } from "@engine/game/save.js";
import type { SaveStore } from "@engine/game/save.js";
import type { ProgressArrays } from "./outbox.js";

/** What the browser-wide save was called before accounts were part of the key. */
const LEGACY_KEY = "FBCookie";
const keyFor = (userId: string) => `${LEGACY_KEY}:${userId}`;
/** Long enough that finishing a level does not send three of these. */
const SETTLE_MS = 1200;

interface SoloRow {
  node: number;
  medal: number;
  best_time_s: number | null;
  best_time_str: string | null;
}

/**
 * Take over the browser-wide save, once, for the first account that asks.
 *
 * The old key belongs to whoever was using this machine, and there is no way to
 * find out who that was -- nothing in it names an account, which is the whole
 * bug. So it is handed to the first account to sign in after this ships and
 * then REMOVED, rather than being left to seed every future account on the
 * machine with the same borrowed medals.
 *
 * Handing it over is safe in a way that keeping it was not, because the server
 * MERGES it. Nothing can be lost by adopting it and nothing can be overwritten
 * by it: a medal already earned stays, a better time already recorded stays.
 * The worst case is that one account absorbs progress somebody else earned on
 * the same laptop, which is exactly what was happening to every account before.
 */
function adoptLegacy(target: string): ProgressArrays | null {
  let raw: string;
  try {
    const found = localStorage.getItem(LEGACY_KEY);
    if (!found) return null;
    raw = found;
    // Claimed before it is parsed. A save this browser cannot read is still a
    // save that must not be offered to the next account that signs in.
    localStorage.removeItem(LEGACY_KEY);
    localStorage.setItem(keyFor(target), raw);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProgressArrays>;
    if (!Array.isArray(parsed?.stats) || !Array.isArray(parsed?.times)) return null;
    return {
      stats: parsed.stats, times: parsed.times,
      timesString: parsed.timesString ?? [],
    };
  } catch {
    return null;
  }
}

export interface SoloProgress {
  /** The store handed to the game, exactly as `LocalSave` was before. */
  readonly store: SaveStore;
  /** Push what the browser has, adopt what the account has. */
  sync(): Promise<void>;
  /** Note that the engine confirmed a change, and sync once it settles. */
  touched(): void;
  close(): void;
  readonly lastError: string | null;
}

export function soloProgress(): SoloProgress {
  const owner = auth().user?.id ?? "";
  // Signed out there is no account to key on, and no server to sync with. The
  // legacy key is deliberately NOT used as a fallback: an anonymous session
  // writing into it is how the shared save came about.
  const local = new LocalSave(owner ? keyFor(owner) : `${LEGACY_KEY}:anonymous`);
  const data = local.data as ProgressArrays;
  if (owner) {
    const inherited = adoptLegacy(owner);
    if (inherited) mergeInto(data, inherited);
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let lastError: string | null = null;

  async function sync(): Promise<void> {
    if (!owner || closed || auth().user?.id !== owner) return;
    try {
      const { data: rows, error } = await supabase.rpc("sync_solo_progress", {
        p_stats: data.stats.slice(0, 32),
        p_times: data.times.slice(0, 32),
      });
      if (error) throw new Error(error.message);
      // The account's own answer, which may be better than this browser's.
      const server = blank();
      for (const r of (rows ?? []) as SoloRow[]) {
        const i = r.node - 1;
        if (i < 0 || i > 31) continue;
        server.stats[i] = r.medal;
        server.times[i] = r.best_time_s ?? 0;
        server.timesString[i] = r.best_time_str ?? "";
      }
      mergeInto(data, server);
      local.flush();
      lastError = null;
    } catch (e) {
      // Deliberately quiet and deliberately not retried on a timer. The next
      // level finished sends the same arrays, and the merge is indifferent to
      // how often it is told the same thing.
      lastError = (e as Error).message;
    }
  }

  return {
    store: {
      data,
      flush: () => { local.flush(); },
      get lastError() { return local.lastError; },
      set lastError(v: string | null) { local.lastError = v; },
    } as SaveStore,
    get lastError() { return lastError; },
    sync,
    touched() {
      if (closed || timer !== null) return;
      timer = setTimeout(() => { timer = null; void sync(); }, SETTLE_MS);
    },
    close() {
      closed = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
    },
  };
}

function blank(): ProgressArrays {
  const stats = new Array<number>(32).fill(-1);
  stats[0] = 0;
  return {
    stats,
    times: new Array<number>(32).fill(0),
    timesString: new Array<string>(32).fill(""),
  };
}

/**
 * Best-of, in place.
 *
 * The same rule the database applies, for the same reason: whichever copy is
 * ahead on a node wins that node, so it does not matter which of a phone and a
 * laptop synced last. A locked node (-1) never closes an open one.
 */
function mergeInto(into: ProgressArrays, from: ProgressArrays): void {
  for (let i = 0; i < 32; i++) {
    const medal = from.stats[i] ?? -1;
    if (medal > (into.stats[i] ?? -1)) into.stats[i] = medal;
    const t = from.times[i] ?? 0;
    const mine = into.times[i] ?? 0;
    if (t > 0 && (mine === 0 || t < mine)) {
      into.times[i] = t;
      into.timesString[i] = from.timesString[i] ?? "";
    }
  }
}
