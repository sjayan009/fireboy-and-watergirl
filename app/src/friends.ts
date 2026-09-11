/**
 * Friends: the list, and the four things you can do to it.
 *
 * All of the rules live in the database and were proved there before any of
 * this existed -- `request_friend` accepts when the other person has already
 * asked, so two people both pressing "add" become friends rather than
 * deadlocking; a friendship is stored once in a canonical order; and nobody can
 * insert a row claiming somebody else asked. This module is the thin part.
 */
import { supabase } from "./supabase.js";
import { auth } from "./auth.js";

export type FriendStatus = "pending" | "accepted" | "blocked";

export interface Friend {
  id: string;
  username: string;
  status: FriendStatus;
  /** True when the request is theirs to accept, not ours. */
  theirMove: boolean;
  /** True when we are waiting on them. */
  ourMove: boolean;
  /**
   * True when the block on this row is ours to lift.
   *
   * Blocked rows are visible to both people -- the row is still theirs too --
   * but only one of them can do anything about it, and the screen has to be
   * able to tell which one it is looking at.
   */
  blockedByMe: boolean;
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

/**
 * Everyone we have a row with, and what to call them.
 *
 * Two queries rather than an embedded select: `friendships` references
 * `auth.users`, not `profiles`, so PostgREST has no foreign key to follow and
 * would need one invented purely to please it.
 */
export async function listFriends(): Promise<Friend[]> {
  const me = auth().user?.id;
  if (!me) return [];
  const joined = await supabase.rpc("list_friends");
  if (!joined.error) return (joined.data ?? []) as Friend[];
  // Additive migration compatibility while the prior client is still deployed.
  if (joined.error.code !== "PGRST202") throw new Error(joined.error.message);

  const { data: rows, error } = await supabase
    .from("friendships")
    .select("user_a, user_b, status, requested_by, blocked_by");
  fail(error);
  if (!rows || rows.length === 0) return [];

  const ids = rows.map((r) => (r.user_a === me ? r.user_b : r.user_a));
  const names = new Map<string, string>();
  // Batched, because `in(...)` becomes a query string and a long enough one is
  // refused by the server rather than truncated. A hundred friends is not a
  // number this project expects, and "not expected" is how a URL length limit
  // gets found in production rather than here.
  for (let i = 0; i < ids.length; i += 100) {
    const { data: profiles, error: err } = await supabase
      .from("profiles")
      .select("id, username")
      .in("id", ids.slice(i, i + 100));
    // A failure here is a failure to name people, not a failure to find them.
    // It used to be dropped, and the list rendered a screen of "(unknown)"
    // that looked like data rather than like an outage.
    fail(err);
    for (const p of profiles ?? []) names.set(p.id, p.username);
  }

  return rows.map((r) => {
    const id = r.user_a === me ? r.user_b : r.user_a;
    const pending = r.status === "pending";
    return {
      id,
      username: names.get(id) ?? "(unknown)",
      status: r.status as FriendStatus,
      theirMove: pending && r.requested_by === me,
      ourMove: pending && r.requested_by !== me,
      blockedByMe: r.status === "blocked" && r.blocked_by === me,
    };
  }).sort((a, b) => a.username.localeCompare(b.username));
}

/*
 * `findByUsername` used to be here, reading `profiles` by name so a stranger's
 * row could be fetched before asking to be their friend. It had no callers, and
 * removing it is what makes the tightened `profiles_read` safe -- see
 * `20260912000000_tighten_reads`.
 *
 * Nothing is lost. `request` below hands the NAME to `request_friend`, a
 * definer function that resolves it server-side, so adding somebody never
 * needed a client-side read of their profile. What the policy no longer permits
 * is the other thing that query could do: ask, one name at a time, who plays
 * here -- or, without a filter, ask for everybody at once.
 */

export async function request(username: string): Promise<void> {
  const { data, error } = await supabase.rpc("request_friend",
                                             { their_username: username });
  fail(error);
  // A name nobody has comes back as NULL rather than as an error, and it has to:
  // `request_friend` charges an attempt against an hourly budget, and a raise
  // would roll that charge back along with everything else in the transaction --
  // leaving the one call in this project that will still resolve a username free
  // to be asked over and over. See `20260913010000_charge_failed_requests`.
  //
  // The sentence below is also what somebody blocked by that person sees, on
  // purpose: being blocked must not be distinguishable from not existing.
  //
  // Tested for by a FIELD rather than by the row. The function is declared
  // `returns public.friendships`, so a NULL comes back over PostgREST as a row
  // whose every column is null -- an object, and a truthy one. `!data` would
  // never have fired, and the caller would have been told the request went
  // through.
  if (!(data as { user_a?: string } | null)?.user_a) {
    throw new Error("No player with that name.");
  }
}

export async function accept(theirId: string): Promise<void> {
  const { error } = await supabase.rpc("accept_friend", { their_id: theirId });
  fail(error);
}

/**
 * Remove a friendship entirely.
 *
 * Deleting takes the pair's shared progress with it -- `pair_progress` is
 * foreign-keyed to the friendship and cascades. That is the intended meaning of
 * unfriending, and worth saying out loud in the UI before doing it.
 */
export async function remove(theirId: string): Promise<void> {
  // Through the function, like every other transition. 0015 took the direct
  // INSERT and UPDATE verbs away because the policies were broader than the
  // rules; DELETE stayed, and this is here so that every change to a friendship
  // has one named entry point and the one that destroys shared progress can say
  // what it destroys.
  const { error } = await supabase.rpc("remove_friend", { their_id: theirId });
  fail(error);
}

/**
 * Block a friend, and lift it again.
 *
 * Both go through the database rather than through an update, for the same
 * reason `request_friend` does: the rule is "only the person who blocked may
 * unblock", and a rule the client states is a rule the client can decline to
 * state. `0009` owns it -- the row records who cast the block, the update and
 * delete policies refuse everyone else, and `request_friend` will not reopen a
 * blocked pair.
 *
 * The friendship survives a block rather than being deleted, deliberately:
 * unfriending takes the pair's shared progress with it, and blocking somebody
 * you have played thirty levels with should not quietly throw those away.
 */
export async function block(theirId: string): Promise<void> {
  const { error } = await supabase.rpc("block_friend", { their_id: theirId });
  fail(error);
}

export async function unblock(theirId: string): Promise<void> {
  const { error } = await supabase.rpc("unblock_friend", { their_id: theirId });
  fail(error);
}
