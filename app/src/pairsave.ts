/**
 * Progress that belongs to the PAIR, not to a browser.
 *
 * `Game.as` keeps everything in one SharedObject -- `stats[32]`, `times[32]`,
 * `timesString[32]` -- and the ported `GameReady` and `Recuent` read and write
 * those fields verbatim. `engine/src/game/save.ts` turned that into a
 * `SaveStore` interface with a swappable factory precisely so this could exist
 * without a line of the ported game changing, and it does not change one.
 *
 * It lives in the app rather than in the engine for the same reason the
 * Realtime transport does: **the engine does not know Supabase exists**, and
 * keeping it that way is what lets the whole simulation be tested in Node with
 * no network and no account.
 *
 * ## Adopt and release
 *
 * One store serves both kinds of play. Alone, it is the browser's own
 * localStorage. When a pair session starts it *adopts* that pair -- swapping
 * the three arrays for the pair's, and directing writes at the database -- and
 * releases them again afterwards, putting the solo progress back. The ported
 * code sees one bag of arrays throughout and never learns which it is looking
 * at.
 *
 * ## Why the state is in a closure and not on the object
 *
 * This one was expensive to learn. The store is reachable from the Game, which
 * means it is inside the rollback snapshot -- and that is CORRECT for `data`,
 * because a medal awarded on a frame that gets taken back must be taken back
 * with it. But it was equally true of every other field the store carried, and
 * a pending timer handle restored to a stale value is a timer that never fires
 * and a `flush` that believes one is already pending. Progress silently stopped
 * being saved, with no error anywhere, because the bookkeeping was being
 * rewound along with the game.
 *
 * So the store handed to the engine owns exactly two things: the bag of arrays,
 * which SHOULD roll back, and a `flush` function, which is a reference the walk
 * stores opaquely and cannot follow into. Everything else lives in this
 * closure, where no walk of the object graph can reach it.
 *
 * ## Why writes are late on purpose
 *
 * The same rollback is why nothing is sent immediately. Waiting a second and a
 * half and then sending whatever the arrays say by then lets corrections settle
 * first, and it doubles as rate limiting.
 */
import { supabase } from "./supabase.js";
import { auth } from "./auth.js";
import type { SaveStore } from "@engine/game/save.js";

/** How long after the last change the arrays are sent. */
const SETTLE_MS = 1500;

const NODES = 32;

interface Arrays {
  stats: number[];
  times: number[];
  timesString: string[];
}

function blank(): Arrays {
  const stats = new Array(NODES).fill(-1);
  // The map always opens with its first node available, exactly as a fresh
  // SharedObject does in `GameReady`.
  stats[0] = 0;
  return {
    stats,
    times: new Array(NODES).fill(0),
    timesString: new Array(NODES).fill(""),
  };
}

function read(data: any): Arrays {
  return {
    stats: (data.stats ?? []).slice(0, NODES),
    times: (data.times ?? []).slice(0, NODES),
    timesString: (data.timesString ?? []).slice(0, NODES),
  };
}

/**
 * Copy arrays into the live bag WITHOUT replacing it.
 *
 * The ported code holds `The_cookie.data` from the moment the Game is built, so
 * handing it a different object would leave it reading the old one forever.
 */
function write(data: any, from: Arrays): void {
  if (!Array.isArray(data.stats)) data.stats = new Array(NODES);
  if (!Array.isArray(data.times)) data.times = new Array(NODES);
  if (!Array.isArray(data.timesString)) data.timesString = new Array(NODES);
  for (let i = 0; i < NODES; i++) {
    data.stats[i] = from.stats[i] ?? -1;
    data.times[i] = from.times[i] ?? 0;
    data.timesString[i] = from.timesString[i] ?? "";
  }
}

/** What we last sent, so an unchanged map costs nothing. */
function signature(a: Arrays): string {
  return a.stats.join(",") + "|" + a.times.join(",");
}

export interface PairProgress {
  /** The store to hand the engine. Owns the arrays and nothing else. */
  readonly store: SaveStore;
  /** True while the arrays belong to a pair rather than to this browser. */
  readonly shared: boolean;
  /** Writes that reached the database, and whatever stopped the last one. */
  readonly saves: number;
  readonly lastError: string | null;
  adopt(friendId: string): Promise<void>;
  release(): void;
}

export function pairProgress(local: SaveStore): PairProgress {
  const data = local.data;

  let friendId: string | null = null;
  let solo: Arrays | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sent = "";
  let saves = 0;
  let lastError: string | null = null;

  /** Send now, whatever the arrays currently say. */
  function send(): void {
    if (!friendId) return;
    const now = read(data);
    const sig = signature(now);
    if (sig === sent) return;
    sent = sig;

    void (async () => {
      try {
        const { error } = await supabase.rpc("sync_progress", {
          their_id: friendId,
          p_stats: now.stats,
          p_times: now.times,
          p_times_str: now.timesString,
        });
        if (error) throw new Error(error.message);
        saves++;
        lastError = null;
      } catch (e) {
        // Losing a level's result is worth a retry but not worth stopping play
        // for: clearing the signature means the next flush sends it again.
        lastError = (e as Error).message;
        console.warn("could not save the pair's progress:", lastError);
        sent = "";
      }
    })();
  }

  const store: SaveStore = {
    data,
    flush(): void {
      if (!friendId) { local.flush(); return; }
      if (timer !== null) return;
      timer = setTimeout(() => { timer = null; send(); }, SETTLE_MS);
    },
  };

  return {
    store,
    get shared() { return friendId !== null; },
    get saves() { return saves; },
    get lastError() { return lastError; },

    /**
     * Load a pair's map and put it in front of the game.
     *
     * Called before the level starts, because `Recuent` compares the finished
     * run against what is already stored to decide whether it is an improvement
     * -- against the PAIR's best, not against whatever this browser happens to
     * remember from playing alone.
     */
    async adopt(id: string): Promise<void> {
      const rows = await fetchPair(id);
      solo = read(data);
      friendId = id;
      sent = "";
      write(data, rows);
    },

    /** Put the solo progress back, after a last write of the pair's. */
    release(): void {
      if (!friendId) return;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      send();
      const back = solo;
      friendId = null;
      solo = null;
      sent = "";
      if (back) write(data, back);
      local.flush();
    },
  };
}

/**
 * The pair's stored map, as the three arrays the game expects.
 *
 * Filtered by both ids rather than relying on row level security alone. RLS
 * limits the rows to pairs this account is IN, which for anyone with two
 * friends is more than one pair -- correct, and not what is being asked for.
 */
async function fetchPair(friendId: string): Promise<Arrays> {
  const me = auth().user?.id;
  if (!me) return blank();
  const lo = me < friendId ? me : friendId;
  const hi = me < friendId ? friendId : me;

  const { data, error } = await supabase
    .from("pair_progress")
    .select("node, medal, best_time_s, best_time_str")
    .eq("user_a", lo)
    .eq("user_b", hi);
  if (error) throw new Error(error.message);

  const out = blank();
  for (const row of data ?? []) {
    const i = row.node - 1;
    if (i < 0 || i >= NODES) continue;
    out.stats[i] = row.medal;
    out.times[i] = row.best_time_s ?? 0;
    out.timesString[i] = row.best_time_str ?? "";
  }
  // A pair with no rows at all is a pair that has never played: the map opens
  // at its first node, the same as a fresh save.
  if (out.stats[0] < 0) out.stats[0] = 0;
  return out;
}
