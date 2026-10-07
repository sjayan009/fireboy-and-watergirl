import type { Ported } from "../ported.js";
/**
 * Progress storage, shaped exactly like the SharedObject it replaces.
 *
 * `Game.as` keeps everything in `The_cookie.data`:
 *
 *   stats[32]        -1 locked, 0 unlocked-unplayed, 1..3 medals earned
 *   times[32]        best time in whole seconds, 0 if never finished
 *   timesString[32]  the same time as "M:SS", shown on the menu map
 *   submited         a leftover of the dead hiscore screen
 *
 * The ported `GameReady()` and `Recuent()` read and write those fields
 * verbatim, so the interface has to keep that shape rather than a tidier one.
 *
 * The point of the indirection is what comes next: online play needs progress
 * keyed to a *pair* of players rather than to a browser, so a Supabase-backed
 * store slots in behind this same interface without touching the ported code.
 *
 * ## What is loaded is not what was stored
 *
 * `localStorage` is shared with anything else running on the origin, survives
 * every release, and can be edited by hand or by an extension. The loader used
 * to accept whatever `JSON.parse` returned -- so `{"stats":null}` became the
 * save, and the first thing the ported code did with it was index it. A single
 * bad value in one key made the game unstartable until somebody knew to clear
 * site data.
 *
 * So a load is a MIGRATION, not a parse: every field is checked, every array is
 * brought to 32 entries, every number is clamped to what the game can mean by
 * it, and anything that fails is replaced rather than passed on. What was
 * rejected is kept beside the save under `.broken`, because a corrupt file is
 * still the only copy of somebody's progress and deleting it silently is worse
 * than not reading it.
 */

export interface SaveStore {
  /** The bag the ported code reads and writes. */
  data: Ported;
  /** SharedObject.flush(); persist whatever `data` now holds. */
  flush(): void;
  /**
   * Whether the last write reached storage, and what stopped it.
   *
   * `localStorage.setItem` throws on a full quota and in some private modes,
   * and the exception used to be swallowed -- so a browser that had silently
   * stopped saving looked exactly like one that was saving fine. The page can
   * now say so.
   *
   * A PLAIN property, not an accessor, and that is load-bearing. The store is
   * reachable from the Game, so it is inside the rollback snapshot -- and the
   * snapshot restores every field it captured by assigning it back. A getter
   * with no setter is captured happily and then throws
   * "Cannot set property lastError" on the first correction, which is a
   * TypeError inside the frame loop of a live session. Anything added here has
   * to be assignable.
   */
  lastError?: string | null;
}

/** The map has 32 nodes; every array in the save is one entry per node. */
const NODES = 32;

/**
 * Bring a loaded value to the shape the ported code indexes.
 *
 * Deliberately total: every input has an output, and the output is always
 * usable. Anything unrecognised becomes the default for that slot rather than
 * an error, because the alternative on this path is a game that will not start.
 */
export function normaliseSave(loaded: unknown): { data: Ported; repaired: boolean } {
  let repaired = false;
  const src: Record<string, unknown> =
    loaded && typeof loaded === "object" && !Array.isArray(loaded)
      ? loaded as Record<string, unknown>
      : (loaded === undefined || loaded === null ? {} : (repaired = true, {}));

  const numbers = (key: string, fallback: number,
                   lo: number, hi: number): number[] => {
    const raw = src[key];
    const out = new Array(NODES).fill(fallback);
    if (!Array.isArray(raw)) {
      if (raw !== undefined) repaired = true;
      return out;
    }
    if (raw.length !== NODES) repaired = true;
    for (let i = 0; i < NODES; i++) {
      const v = raw[i];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        if (v !== undefined) repaired = true;
        continue;
      }
      const clamped = Math.min(hi, Math.max(lo, Math.trunc(v)));
      if (clamped !== v) repaired = true;
      out[i] = clamped;
    }
    return out;
  };

  const strings = (key: string): string[] => {
    const raw = src[key];
    const out = new Array(NODES).fill("");
    if (!Array.isArray(raw)) {
      if (raw !== undefined) repaired = true;
      return out;
    }
    if (raw.length !== NODES) repaired = true;
    for (let i = 0; i < NODES; i++) {
      const v = raw[i];
      if (typeof v !== "string") {
        if (v !== undefined) repaired = true;
        continue;
      }
      // The game writes "MM:SS" and nothing else; a longer value is somebody
      // else's, and it is drawn straight onto the map.
      out[i] = v.length > 8 ? (repaired = true, v.slice(0, 8)) : v;
    }
    return out;
  };

  // -1 locked, 0 reached and unplayed, 1..3 the grades `Recuent` awards.
  const stats = numbers("stats", -1, -1, 3);
  // 99:59 is the largest the timer can display, so 5999 is the largest a real
  // result can be.
  const times = numbers("times", 0, 0, 5999);
  const timesString = strings("timesString");

  // A fresh SharedObject opens with the first node available; a save whose
  // first node is locked has lost the only entry point the map has.
  if (stats[0] < 0) { stats[0] = 0; if (src.stats !== undefined) repaired = true; }

  return {
    data: { ...src, stats, times, timesString, submited: !!src.submited },
    repaired,
  };
}

/** localStorage-backed, for solo play in one browser. */
class LocalSave implements SaveStore {
  data: Ported;
  lastError: string | null = null;

  constructor(private key: string) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(this.key);
    } catch (e) {
      // A private window, cleared site data, or storage disabled entirely.
      // Losing progress is bad; refusing to start the game is worse.
      this.lastError = (e as Error).message;
    }

    let parsed: unknown = null;
    let broken = false;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        broken = true;
      }
    }

    const { data, repaired } = normaliseSave(parsed);
    this.data = data;

    // Keep what could not be used. It is still the only copy of somebody's
    // progress, and a bug that eats a save is much easier to answer for with
    // the evidence still on the machine.
    if (raw && (broken || repaired)) {
      try { localStorage.setItem(this.key + ".broken", raw); } catch { /* full */ }
    }
  }

  flush(): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.data));
      this.lastError = null;
    } catch (e) {
      // Quota, or storage disabled. Play continues -- but the page can now find
      // out that it is not being recorded, which it could not before.
      this.lastError = (e as Error).message;
    }
  }
}

/** In-memory, for Node tests and for a peer whose progress lives elsewhere. */
class MemorySave implements SaveStore {
  data: Ported = normaliseSave(null).data;
  lastError: string | null = null;
  flush(): void {}
}

/**
 * How a store is obtained. Swappable, because `Game`'s constructor calls
 * `openSave` directly and the ported code must not learn about accounts.
 *
 * Online co-op keys progress to a PAIR rather than to a browser, so the app
 * installs a Supabase-backed factory before building the Game and the ported
 * code never knows the difference.
 *
 * It is a module global, which is what made spectating write into the
 * watcher's own progress: the play screen installed the pair's store and never
 * put it back, and the watch screen built a `GameView` without saying anything
 * about saves at all. `GameView` now scopes this around the one call that reads
 * it -- see `embed.ts` -- so the factory is never left pointing at the last
 * screen's storage.
 */
let factory: ((key: string) => SaveStore) | null = null;

export function setSaveStore(f: ((key: string) => SaveStore) | null): void {
  factory = f;
}

/** What the factory is now, so a caller can put it back. */
export function getSaveStore(): ((key: string) => SaveStore) | null {
  return factory;
}

export function openSave(key: string): SaveStore {
  if (factory) return factory(key);
  const hasLocal = typeof localStorage !== "undefined";
  return hasLocal ? new LocalSave(key) : new MemorySave();
}

export { LocalSave, MemorySave };
