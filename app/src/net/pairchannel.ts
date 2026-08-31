/**
 * The one channel a pair of friends shares.
 *
 * Every accepted friendship has exactly one Supabase Realtime topic,
 * `pair:<lo>:<hi>`, using the same canonical ordering the `friendships` table
 * enforces. That single channel carries four things that would otherwise need
 * four mechanisms:
 *
 *   presence     is my friend online, in the lobby, or in a game
 *   invites      who plays, which level, and who is Fireboy
 *   signalling   the SDP and ICE exchange for the peer connection
 *   relay        the game itself, for the pairs whose NAT refuses a peer
 *                connection
 *
 * It is private, and privately is the only way it works: `realtime.messages`
 * has row level security allowing exactly the two members of an ACCEPTED
 * friendship, proved from a third account in `supabase/realtimetest.mjs`. A
 * stranger who knows the topic name exactly is refused.
 *
 * One subscription serves all four uses. Opening a second channel on the same
 * topic would double the connection count for nothing.
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../supabase.js";

/** What a friend is doing, as far as their client last said. */
export type Activity = "online" | "in_lobby" | "in_game";

export interface Presence {
  userId: string;
  username: string;
  activity: Activity;
}

/**
 * An invitation to play.
 *
 * The role assignment travels with it: the inviter decides who is Fireboy and
 * who is Watergirl, so neither client has to negotiate it and both agree before
 * a single frame is simulated. `fireboy` is a user id, and the peer whose id it
 * is takes slot 0.
 */
export interface Invite {
  session: string;
  mode: string;
  num: number;
  fireboy: string;
  from: string;
}

/** Events on the wire. Kept short: they are typed on every message. */
const INVITE = "invite";
const REPLY = "reply";
const CANCEL = "cancel";
const BYTES = "b";

export interface InviteReply {
  session: string;
  /**
   * False is a real answer -- "not now" -- and not merely the absence of yes.
   *
   * Without it the only way to decline was silence, and silence is
   * indistinguishable from a friend who walked away from their desk: the
   * inviter sat on "waiting for them to accept" for two minutes either way.
   */
  accepted: boolean;
  /** Set once the replying peer is ready for the level to start. */
  ready?: boolean;
}

/**
 * The inviter has withdrawn, or the invitee has backed out after saying yes.
 *
 * Sent by whichever side changed its mind, and it has to exist separately from
 * a reply because either of them can be the one to send it -- and because it
 * has to be able to arrive in the MIDDLE of the connection handshake, which is
 * a place a reply never comes from.
 */
export interface InviteCancel {
  session: string;
  from: string;
}

export function topicFor(a: string, b: string): string {
  return `pair:${a < b ? a : b}:${a < b ? b : a}`;
}

export class PairChannel {
  private constructor(
    readonly topic: string,
    readonly channel: RealtimeChannel,
    readonly me: Presence,
  ) {}

  private inviteHandlers = new Set<(i: Invite) => void>();
  private replyHandlers = new Set<(r: InviteReply) => void>();
  private cancelHandlers = new Set<(c: InviteCancel) => void>();
  private byteHandlers = new Set<(d: Uint8Array) => void>();
  private presenceHandlers = new Set<(p: Presence[]) => void>();

  /**
   * Join, and resolve once the server has actually let us in.
   *
   * A refusal arrives as `CHANNEL_ERROR`, not as a thrown error, so it has to be
   * turned into one here or a caller would sit waiting on a channel that is
   * never coming up.
   */
  static open(friendId: string, me: Presence): Promise<PairChannel> {
    const topic = topicFor(me.userId, friendId);
    const channel = supabase.channel(topic, {
      config: { private: true, presence: { key: me.userId } },
    });
    const pair = new PairChannel(topic, channel, me);

    channel.on("broadcast", { event: INVITE }, ({ payload }) => {
      for (const fn of pair.inviteHandlers) fn(payload as Invite);
    });
    channel.on("broadcast", { event: REPLY }, ({ payload }) => {
      for (const fn of pair.replyHandlers) fn(payload as InviteReply);
    });
    channel.on("broadcast", { event: CANCEL }, ({ payload }) => {
      for (const fn of pair.cancelHandlers) fn(payload as InviteCancel);
    });
    channel.on("broadcast", { event: BYTES }, ({ payload }) => {
      // One message can carry several packets; see RealtimeTransport.
      for (const b64 of (payload as { p: string[] }).p ?? []) {
        const bytes = decode(b64);
        for (const fn of pair.byteHandlers) fn(bytes);
      }
    });
    /**
     * Presence, recomputed from the whole state on every event.
     *
     * All three events, not just `sync`. Listening only for `sync` is the
     * obvious version and it drops arrivals: whoever joins an empty channel
     * first gets their sync immediately and then, depending on timing, hears
     * about the second person only as a `join`. The symptom is a friend who is
     * online and sitting in the lobby but shows as offline to one side and not
     * the other, roughly half the time.
     *
     * Recomputing from `presenceState()` rather than patching a local copy
     * means all three events can share one path and none of them can drift.
     */
    const sync = () => {
      const state = channel.presenceState<Presence>();
      const all: Presence[] = [];
      for (const entries of Object.values(state)) {
        for (const p of entries) all.push(p as unknown as Presence);
      }
      for (const fn of pair.presenceHandlers) fn(all);
    };
    channel.on("presence", { event: "sync" }, sync);
    channel.on("presence", { event: "join" }, sync);
    channel.on("presence", { event: "leave" }, sync);

    return new Promise((resolve, reject) => {
      // Settling once matters: tearing the channel down fires CLOSED
      // synchronously, which would otherwise re-enter this callback.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("the channel did not come up"));
      }, 15000);

      channel.subscribe(async (status) => {
        if (settled) return;
        if (status === "SUBSCRIBED") {
          settled = true;
          clearTimeout(timer);
          await channel.track(me);
          resolve(pair);
        } else if (status === "CHANNEL_ERROR" || status === "CLOSED") {
          settled = true;
          clearTimeout(timer);
          reject(new Error(
            "that channel is not yours -- the friendship must be accepted"));
        }
      });
    });
  }

  // ---- presence ----------------------------------------------------------

  onPresence(fn: (all: Presence[]) => void): () => void {
    this.presenceHandlers.add(fn);
    return () => this.presenceHandlers.delete(fn);
  }

  /** Say what we are doing now. */
  async setActivity(activity: Activity): Promise<void> {
    await this.channel.track({ ...this.me, activity });
  }

  // ---- invites -----------------------------------------------------------

  onInvite(fn: (i: Invite) => void): () => void {
    this.inviteHandlers.add(fn);
    return () => this.inviteHandlers.delete(fn);
  }

  onReply(fn: (r: InviteReply) => void): () => void {
    this.replyHandlers.add(fn);
    return () => this.replyHandlers.delete(fn);
  }

  onCancel(fn: (c: InviteCancel) => void): () => void {
    this.cancelHandlers.add(fn);
    return () => this.cancelHandlers.delete(fn);
  }

  send(event: string, payload: unknown): void {
    void this.channel.send({ type: "broadcast", event, payload });
  }

  invite(i: Invite): void { this.send(INVITE, i); }
  reply(r: InviteReply): void { this.send(REPLY, r); }
  cancel(c: InviteCancel): void { this.send(CANCEL, c); }

  // ---- bytes -------------------------------------------------------------

  onBytes(fn: (d: Uint8Array) => void): () => void {
    this.byteHandlers.add(fn);
    return () => this.byteHandlers.delete(fn);
  }

  sendBytes(packets: string[]): void {
    this.send(BYTES, { p: packets });
  }

  /** Awaitable: leaving is a message to the server, not a local flag. */
  async close(): Promise<void> {
    this.inviteHandlers.clear();
    this.replyHandlers.clear();
    this.cancelHandlers.clear();
    this.byteHandlers.clear();
    this.presenceHandlers.clear();
    await supabase.removeChannel(this.channel);
  }
}

/**
 * Realtime carries JSON, so the netcode's packets ride as base64.
 *
 * A 32-byte input packet becomes 44 characters, which is nothing against a
 * message frame -- and doing it here means neither the netcode nor the channel
 * has to know the other exists.
 */
export function encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
