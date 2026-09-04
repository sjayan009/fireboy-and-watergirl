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
 *
 * ## And why a late write must survive the page
 *
 * That delay is exactly as long as it takes somebody who has just finished a
 * level to click "Friends", or close the tab. `release()` used to start the
 * final send without awaiting it, clear the friend identity in the next
 * statement, and return; route cleanup then destroyed the view, and the browser
 * cancelled the request during unload. The screen had already shown the medal.
 * There was no record of it anywhere.
 *
 * So the map is written to an OUTBOX in localStorage before it is sent and
 * removed only when the database has acknowledged it. A send that is cancelled,
 * fails, or never happens leaves a record that the next `adopt` -- or the next
 * time this module loads at all -- picks up and retries. `beacon()` is the
 * best-effort half for the same moment: a `keepalive` fetch that the browser
 * is allowed to finish after the document has gone.
 */
import { supabase } from "./supabase.js";
import { auth } from "./auth.js";
import type { SaveStore } from "@engine/game/save.js";

/** How long after the last change the arrays are sent. */
const SETTLE_MS = 1500;

const NODES = 32;

/** Where unacknowledged writes wait for another go. */
const OUTBOX_KEY = "fbwg.pairoutbox";

interface Arrays {
  stats: number[];
  times: number[];
  timesString: string[];
}

/** One pair's map, waiting to be acknowledged. */
interface Pending extends Arrays {
  friendId: string;
  at: number;
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

// ---- the outbox ----------------------------------------------------------
//
// One entry per friend, newest wins. A map is monotonic -- it always contains
// everything earlier ones did -- so keeping the latest is keeping all of them,
// and the queue cannot grow with the length of a session.

function loadOutbox(): Record<string, Pending> {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, Pending> = {};
    for (const [id, v] of Object.entries(parsed as Record<string, any>)) {
      if (!v || !Array.isArray(v.stats) || !Array.isArray(v.times)) continue;
      out[id] = {
        friendId: id,
        at: typeof v.at === "number" ? v.at : 0,
        stats: v.stats.slice(0, NODES),
        times: v.times.slice(0, NODES),
        timesString: Array.isArray(v.timesString)
          ? v.timesString.slice(0, NODES) : new Array(NODES).fill(""),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function saveOutbox(all: Record<string, Pending>): void {
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(OUTBOX_KEY);
    else localStorage.setItem(OUTBOX_KEY, JSON.stringify(all));
  } catch { /* private mode or quota; the in-memory retry still applies */ }
}

function remember(p: Pending): void {
  const all = loadOutbox();
  all[p.friendId] = p;
  saveOutbox(all);
}

function forget(friendId: string, at: number): void {
  const all = loadOutbox();
  // Only if it is still the write we just committed. A newer one landing while
  // this request was in flight must not be dropped by its acknowledgement.
  if (all[friendId] && all[friendId].at === at) {
    delete all[friendId];
    saveOutbox(all);
  }
}

/** Push one map at the database. Resolves true when it is stored. */
async function post(p: Pending): Promise<boolean> {
  const { error } = await supabase.rpc("sync_progress", {
    their_id: p.friendId,
    p_stats: p.stats,
    p_times: p.times,
    p_times_str: p.timesString,
  });
  if (error) throw new Error(error.message);
  return true;
}

/**
 * Retry everything that was never acknowledged.
 *
 * Called when a pair is adopted and once when the module loads, which between
 * them cover the two ways a write is orphaned: the tab went, or the network
 * did. A row the pair has since bettered is merged monotonically, so a stale
 * retry cannot undo anything -- which is what makes replaying safe at all.
 */
export async function drainOutbox(): Promise<number> {
  if (!auth().user) return 0;
  let sent = 0;
  for (const p of Object.values(loadOutbox())) {
    try {
      await post(p);
      forget(p.friendId, p.at);
      sent++;
    } catch (e) {
      // Still not going through. Leave it where it is for next time.
      console.warn("a saved result is still waiting to be sent:",
                   (e as Error).message);
    }
  }
  return sent;
}

export interface PairProgress {
  /** The store to hand the engine. Owns the arrays and nothing else. */
  readonly store: SaveStore;
  /** True while the arrays belong to a pair rather than to this browser. */
  readonly shared: boolean;
  /** Writes that reached the database, and whatever stopped the last one. */
  readonly saves: number;
  readonly lastError: string | null;
  /** Whatever stopped this browser's own localStorage, for the solo case. */
  readonly storageError: string | null;
  /** Results written down but not yet acknowledged by the database. */
  readonly waiting: number;
  adopt(friendId: string): Promise<void>;
  /** Send whatever the arrays say now, and wait for the answer. */
  flushNow(): Promise<void>;
  /**
   * Put the solo progress back, after a last write of the pair's.
   *
   * Awaitable, and the identity it needs is captured before anything is
   * cleared -- so a caller that cannot wait (route teardown) still leaves a
   * complete record behind for the outbox to finish.
   */
  release(): Promise<void>;
  /** The last chance to send, during page termination. */
  beacon(): void;
}

export function pairProgress(local: SaveStore): PairProgress {
  const data = local.data;

  let friendId: string | null = null;
  let solo: Arrays | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sent = "";
  let saves = 0;
  let lastError: string | null = null;
  /** The request in flight, so two flushes do not race each other. */
  let inFlight: Promise<void> = Promise.resolve();

  /** Send now, whatever the arrays currently say. */
  function send(forFriend = friendId): Promise<void> {
    if (!forFriend) return Promise.resolve();
    const now = read(data);
    const sig = signature(now);
    if (sig === sent) return inFlight;
    sent = sig;

    const pending: Pending = { friendId: forFriend, at: Date.now(), ...now };
    // Written down BEFORE it is sent. Everything after this line can fail --
    // the request, the tab, the network -- and the result is still recoverable.
    remember(pending);

    inFlight = inFlight.then(async () => {
      try {
        await post(pending);
        forget(pending.friendId, pending.at);
        saves++;
        lastError = null;
      } catch (e) {
        // Losing a level's result is worth a retry but not worth stopping play
        // for: clearing the signature means the next flush sends it again, and
        // the outbox entry survives even if there is no next flush.
        lastError = (e as Error).message;
        console.warn("could not save the pair's progress:", lastError);
        sent = "";
      }
    });
    return inFlight;
  }

  // Exactly two members, and no more -- see the note at the top of this file
  // about what the rollback snapshot does to anything else that lives here.
  // A getter is worse than a field: the walk captures it and then assigns it
  // back, and assigning to a getter with no setter throws inside the frame
  // loop. Whatever went wrong with a write is reported on the PairProgress
  // object below, which the snapshot cannot reach.
  const store: SaveStore = {
    data,
    flush(): void {
      if (!friendId) { local.flush(); return; }
      if (timer !== null) return;
      timer = setTimeout(() => { timer = null; void send(); }, SETTLE_MS);
    },
  };

  return {
    store,
    get shared() { return friendId !== null; },
    get saves() { return saves; },
    get lastError() { return lastError; },
    get storageError() { return local.lastError ?? null; },
    get waiting() { return Object.keys(loadOutbox()).length; },

    /**
     * Load a pair's map and put it in front of the game.
     *
     * Called before the level starts, because `Recuent` compares the finished
     * run against what is already stored to decide whether it is an improvement
     * -- against the PAIR's best, not against whatever this browser happens to
     * remember from playing alone.
     */
    async adopt(id: string): Promise<void> {
      // Anything a previous session could not finish saying goes first, so the
      // map this pair loads includes the result the last one lost.
      await drainOutbox();
      const rows = await fetchPair(id);
      solo = read(data);
      friendId = id;
      sent = "";
      write(data, rows);
    },

    async flushNow(): Promise<void> {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      await send();
    },

    async release(): Promise<void> {
      if (!friendId) return;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      // Captured first. `send` used to read `friendId` off the closure at the
      // moment the request was built, and the three lines below cleared it --
      // so a retry after a failure had no idea who the result belonged to.
      const going = friendId;
      const writing = send(going);

      const back = solo;
      friendId = null;
      solo = null;
      sent = "";
      if (back) write(data, back);
      local.flush();

      await writing;
    },

    /**
     * One last attempt while the document is going away.
     *
     * `keepalive` is what makes it different from an ordinary flush: the
     * browser is permitted to finish the request after the page is gone, where
     * a normal `fetch` is cancelled. It is best effort by definition -- there
     * is a size limit and no way to hear the answer -- so the outbox entry is
     * left in place regardless and the next session settles it.
     */
    beacon(): void {
      if (!friendId) return;
      const now = read(data);
      const pending: Pending = { friendId, at: Date.now(), ...now };
      remember(pending);
      void keepaliveSync(pending);
    },
  };
}

/**
 * `sync_progress` as a raw request, so `keepalive` can be set.
 *
 * supabase-js builds its own `fetch` call and offers no way through to this
 * flag, and the flag is the entire point: without it the request is cancelled
 * with the document and this is exactly the moment that matters. The URL and
 * the headers are the ones the client would have used.
 */
async function keepaliveSync(p: Pending): Promise<void> {
  try {
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    if (!token) return;
    await fetch(`${__SUPABASE_URL__}/rest/v1/rpc/sync_progress`, {
      method: "POST",
      keepalive: true,
      headers: {
        apikey: __SUPABASE_KEY__,
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        their_id: p.friendId,
        p_stats: p.stats,
        p_times: p.times,
        p_times_str: p.timesString,
      }),
    });
    forget(p.friendId, p.at);
  } catch {
    // The document is going. The outbox is the answer, not this.
  }
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
