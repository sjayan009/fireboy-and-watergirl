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
import { auth, Profile } from "./auth.js";

export type FriendStatus = "pending" | "accepted" | "blocked";

export interface Friend {
  id: string;
  username: string;
  status: FriendStatus;
  /** True when the request is theirs to accept, not ours. */
  theirMove: boolean;
  /** True when we are waiting on them. */
  ourMove: boolean;
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

  const { data: rows, error } = await supabase
    .from("friendships")
    .select("user_a, user_b, status, requested_by");
  fail(error);
  if (!rows || rows.length === 0) return [];

  const ids = rows.map((r) => (r.user_a === me ? r.user_b : r.user_a));
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, username")
    .in("id", ids);
  const names = new Map((profiles ?? []).map((p) => [p.id, p.username]));

  return rows.map((r) => {
    const id = r.user_a === me ? r.user_b : r.user_a;
    const pending = r.status === "pending";
    return {
      id,
      username: names.get(id) ?? "(unknown)",
      status: r.status as FriendStatus,
      theirMove: pending && r.requested_by === me,
      ourMove: pending && r.requested_by !== me,
    };
  }).sort((a, b) => a.username.localeCompare(b.username));
}

export async function findByUsername(username: string): Promise<Profile | null> {
  const { data } = await supabase
    .from("profiles")
    .select("id, username, display_name, avatar_url")
    .ilike("username", username)
    .maybeSingle();
  return (data as Profile) ?? null;
}

export async function request(username: string): Promise<void> {
  const { error } = await supabase.rpc("request_friend",
                                       { their_username: username });
  fail(error);
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
  const me = auth().user?.id;
  if (!me) return;
  const lo = me < theirId ? me : theirId;
  const hi = me < theirId ? theirId : me;
  const { error } = await supabase
    .from("friendships")
    .delete()
    .eq("user_a", lo)
    .eq("user_b", hi);
  fail(error);
}

export async function block(theirId: string): Promise<void> {
  const me = auth().user?.id;
  if (!me) return;
  const lo = me < theirId ? me : theirId;
  const hi = me < theirId ? theirId : me;
  const { error } = await supabase
    .from("friendships")
    .update({ status: "blocked" })
    .eq("user_a", lo)
    .eq("user_b", hi);
  fail(error);
}
