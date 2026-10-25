/**
 * Quick Match: the server pairs two players, strangers first and friends last.
 *
 * The rules live in `20261010000000_quick_match.sql`. A match is a friendship
 * row in a `matched` state that opens the pair's topic and save for as long as
 * one of the two keeps renewing it, so this module is the client's half of
 * that: search, renew, end.
 */
import { supabase } from "./supabase.js";

export type Role = "fireboy" | "watergirl" | "either";

export interface QuickMatch {
  partner: string;
  username: string;
  /** The pair's Realtime topic, `pair:<channel>`. */
  topic: string;
  iAmFireboy: boolean;
  /** Whether this side sends the invitation. */
  host: boolean;
  /** Already friends: the topic and save are the ones they always share. */
  friend: boolean;
}

/** How often a search asks the server. The queue forgets a player after ten seconds. */
const POLL_MS = 2000;
/** A live match lapses two minutes after its last renewal. */
export const TOUCH_MS = 45000;

/** Search until somebody is found or `signal` aborts. Leaves the queue either way. */
export async function findPartner(role: Role, me: string, signal: AbortSignal): Promise<QuickMatch> {
  try {
    for (;;) {
      signal.throwIfAborted();
      const { data, error } = await supabase.rpc("quick_match_find", { p_role: role }).abortSignal(signal);
      signal.throwIfAborted();
      if (error) throw new Error(error.message);
      const row = (data as { partner: string; username: string; topic: string; fireboy: string; host: string; friend: boolean }[] | null)?.[0];
      if (row) return { partner: row.partner, username: row.username, topic: row.topic, iAmFireboy: row.fireboy === me, host: row.host === me, friend: row.friend };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, POLL_MS);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true });
      });
    }
  } catch (e) {
    // Said even when the search was cancelled: a match found in that same
    // instant is ended by the server rather than left waiting for us.
    if (signal.aborted) void supabase.rpc("quick_match_leave").then(() => {});
    throw e;
  }
}

/** Keep the match alive. False once it has ended. */
export async function touchMatch(partner: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("quick_match_touch", { their_id: partner });
  if (error) throw new Error(error.message);
  return data === true;
}

export async function endMatch(partner: string): Promise<void> {
  await supabase.rpc("quick_match_end", { their_id: partner });
}
