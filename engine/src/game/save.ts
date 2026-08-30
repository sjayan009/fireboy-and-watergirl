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
 */

export interface SaveStore {
  /** The bag the ported code reads and writes. */
  data: any;
  /** SharedObject.flush(); persist whatever `data` now holds. */
  flush(): void;
}

/** localStorage-backed, for solo play in one browser. */
class LocalSave implements SaveStore {
  data: any;

  constructor(private key: string) {
    let loaded: any = null;
    try {
      const raw = localStorage.getItem(this.key);
      if (raw) loaded = JSON.parse(raw);
    } catch {
      // A private window, cleared site data, or storage disabled entirely.
      // Losing progress is bad; refusing to start the game is worse.
      loaded = null;
    }
    this.data = loaded ?? {};
  }

  flush(): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.data));
    } catch { /* quota or disabled storage; play continues */ }
  }
}

/** In-memory, for Node tests and for a peer whose progress lives elsewhere. */
class MemorySave implements SaveStore {
  data: any = {};
  flush(): void {}
}

/**
 * How a store is obtained. Swappable, because `Game`'s constructor calls
 * `openSave` directly and the ported code must not learn about accounts.
 *
 * Online co-op keys progress to a PAIR rather than to a browser, so the app
 * installs a Supabase-backed factory before building the Game and the ported
 * code never knows the difference.
 */
let factory: ((key: string) => SaveStore) | null = null;

export function setSaveStore(f: ((key: string) => SaveStore) | null): void {
  factory = f;
}

export function openSave(key: string): SaveStore {
  if (factory) return factory(key);
  const hasLocal = typeof localStorage !== "undefined";
  return hasLocal ? new LocalSave(key) : new MemorySave();
}

export { LocalSave, MemorySave };
