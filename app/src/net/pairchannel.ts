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
const RESUME = "resume";
const REPLY = "reply";
const CANCEL = "cancel";
const HANDOVER = "handover";
const SHARING = "sharing";
const SHOWING = "showing";
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

/**
 * Who picks the levels now.
 *
 * Deliberately here and not in the netcode. Which map node somebody clicks is
 * menu state -- the pair is between levels, nothing is being simulated, and the
 * two maps are each player's own -- so it needs a message the two of them agree
 * on, not a command applied on an agreed frame. Adding a fifth Command to a
 * wire format that carries three bits a frame would be paying for a precision
 * nobody needs.
 */
/**
 * Whether this pair's game may be watched.
 *
 * Opt-in, per match, off unless both of them see it turned on -- so a game
 * nobody has asked to share puts nothing on any channel. Agreed the same way
 * the level pick is agreed, and for the same reason: nothing about it is
 * simulated, so it wants a message the two of them settle on rather than a
 * command applied on a frame.
 */
export interface Sharing {
  session: string;
  on: boolean;
}

/**
 * "We are playing, and you may watch."
 *
 * Sent to each player's OWN friends, on the channels that already exist and are
 * already authorized. It has to work this way round: a friend cannot ask who is
 * playing, because they cannot see other people's friendships -- so discovery
 * is pushed by the people who know, not pulled by the person who wants to
 * watch.
 */
export interface Showing {
  /** The watch topic to join. */
  topic: string;
  /** Both usernames, for a row that says whose game it is. */
  players: [string, string];
  on: boolean;
}

export interface Handover {
  session: string;
  /** The user id of whoever may start a level from here on. */
  chooser: string;
}

export function topicFor(a: string, b: string): string {
  return `pair:${a < b ? a : b}:${a < b ? b : a}`;
}

export class PairChannel {
  private constructor(
    readonly topic: string,
    private live: RealtimeChannel,
    readonly me: Presence,
  ) {}

  /**
   * The subscription as it stands right now.
   *
   * Deliberately not the same object for the life of the pair. A server-side
   * close cannot be undone on a `RealtimeChannel` -- `subscribe()` refuses to
   * run twice on one instance -- so rejoining means building another and
   * pointing this at it. Everything that matters lives on the PairChannel:
   * the handler sets, the topic, who we are. The channel is just the current
   * pipe.
   */
  get channel(): RealtimeChannel { return this.live; }

  private inviteHandlers = new Set<(i: Invite) => void>();
  private resumeHandlers = new Set<(i: Invite) => void>();
  private replyHandlers = new Set<(r: InviteReply) => void>();
  private cancelHandlers = new Set<(c: InviteCancel) => void>();
  private statusHandlers = new Set<(status: string) => void>();
  private handoverHandlers = new Set<(h: Handover) => void>();
  private sharingHandlers = new Set<(s: Sharing) => void>();
  private showingHandlers = new Set<(s: Showing) => void>();
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
    const pair = new PairChannel(
      topic,
      supabase.channel(topic, {
        config: { private: true, presence: { key: me.userId } },
      }),
      me);
    return pair.join(true).then(() => pair);
  }

  /** Whether `close` has been called, so a rejoin knows to stop trying. */
  private closing = false;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;

  /**
   * Subscribe, wiring every listener the pair needs on the way.
   *
   * `first` decides what a refusal means. The first time, it is the answer to
   * "may I be here at all", and the caller has to hear it. Afterwards it is a
   * connection that has gone and will be tried again.
   */
  private join(first: boolean): Promise<void> {
    const pair = this;
    const channel = this.live;

    channel.on("broadcast", { event: INVITE }, ({ payload }) => {
      for (const fn of pair.inviteHandlers) fn(payload as Invite);
    });
    // Deliberately an Invite, and deliberately a different event. It carries
    // exactly the same five things -- who, which level, who is Fireboy -- but
    // it must not raise a banner asking a question that was answered before the
    // connection dropped.
    channel.on("broadcast", { event: RESUME }, ({ payload }) => {
      for (const fn of pair.resumeHandlers) fn(payload as Invite);
    });
    channel.on("broadcast", { event: REPLY }, ({ payload }) => {
      for (const fn of pair.replyHandlers) fn(payload as InviteReply);
    });
    channel.on("broadcast", { event: CANCEL }, ({ payload }) => {
      for (const fn of pair.cancelHandlers) fn(payload as InviteCancel);
    });
    channel.on("broadcast", { event: HANDOVER }, ({ payload }) => {
      for (const fn of pair.handoverHandlers) fn(payload as Handover);
    });
    channel.on("broadcast", { event: SHARING }, ({ payload }) => {
      for (const fn of pair.sharingHandlers) fn(payload as Sharing);
    });
    channel.on("broadcast", { event: SHOWING }, ({ payload }) => {
      for (const fn of pair.showingHandlers) fn(payload as Showing);
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
        // Everything AFTER the first status is what the connection is doing
        // for the rest of its life, and it used to be dropped on the floor.
        if (settled) {
          if (status === "SUBSCRIBED") {
            pair.attempts = 0;
            // Re-announced, because a rejoin brings back the subscription and
            // not what we had told it about ourselves. Without this, a blip
            // leaves you invisible to a friend looking straight at your name.
            await channel.track(pair.activity
              ? { ...pair.me, activity: pair.activity } : pair.me);
          } else {
            pair.rejoin();
          }
          for (const fn of pair.statusHandlers) fn(status);
          return;
        }
        if (status === "SUBSCRIBED") {
          settled = true;
          pair.attempts = 0;
          clearTimeout(timer);
          await channel.track(pair.me);
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "CLOSED") {
          settled = true;
          clearTimeout(timer);
          if (first) {
            reject(new Error(
              "that channel is not yours -- the friendship must be accepted"));
          } else {
            pair.rejoin();
            resolve();
          }
        }
      });
    });
  }

  /**
   * Join again, on a channel the server has closed on us.
   *
   * It does close them. The stack when it happens is `Socket.onConnMessage` --
   * a `phx_close` pushed from the other end, not anything this client did --
   * and the Supabase client does not come back from it on its own. What made
   * that so hard to see is that `send` keeps returning "ok" afterwards, by
   * quietly falling back to the REST endpoint: messages go out, nobody is
   * subscribed to receive them, and the pair simply stops hearing each other.
   * Presence, invitations, reconnection and the level handover all ride on
   * this channel, so all four die together and none of them says anything.
   *
   * A closed `RealtimeChannel` cannot be re-subscribed -- the client refuses
   * to run `subscribe()` twice on one instance -- so this builds another and
   * re-wires it. The handler sets belong to the PairChannel, so nothing above
   * here notices that the pipe underneath was replaced.
   */
  private rejoin(): void {
    if (this.closing || this.rejoinTimer !== null) return;
    // Backing off, and capped: the usual cause is a limit at the far end, and
    // hammering it is the one response guaranteed not to help.
    const wait = Math.min(1000 * 2 ** this.attempts++, 30000);
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      if (this.closing) return;
      void supabase.removeChannel(this.live).catch(() => { /* already gone */ });
      this.live = supabase.channel(this.topic, {
        config: { private: true, presence: { key: this.me.userId } },
      });
      void this.join(false).catch((e) => {
        console.warn("could not rejoin the pair's channel:", e);
      });
    }, wait);
  }

  // ---- presence ----------------------------------------------------------

  onPresence(fn: (all: Presence[]) => void): () => void {
    this.presenceHandlers.add(fn);
    return () => this.presenceHandlers.delete(fn);
  }

  /** Say what we are doing now. */
  async setActivity(activity: Activity): Promise<void> {
    this.activity = activity;
    await this.live.track({ ...this.me, activity });
  }

  /**
   * What we last said we were doing, so a rejoin can say it again.
   *
   * Presence is per-subscription: the new channel knows nothing about what the
   * old one had been told, and announcing the default would put somebody who
   * is mid-game back to "online" in their friend's list.
   */
  private activity: Activity | null = null;

  // ---- invites -----------------------------------------------------------

  onInvite(fn: (i: Invite) => void): () => void {
    this.inviteHandlers.add(fn);
    return () => this.inviteHandlers.delete(fn);
  }

  onReply(fn: (r: InviteReply) => void): () => void {
    this.replyHandlers.add(fn);
    return () => this.replyHandlers.delete(fn);
  }

  onResume(fn: (i: Invite) => void): () => void {
    this.resumeHandlers.add(fn);
    return () => this.resumeHandlers.delete(fn);
  }

  onCancel(fn: (c: InviteCancel) => void): () => void {
    this.cancelHandlers.add(fn);
    return () => this.cancelHandlers.delete(fn);
  }

  onHandover(fn: (h: Handover) => void): () => void {
    this.handoverHandlers.add(fn);
    return () => this.handoverHandlers.delete(fn);
  }

  onSharing(fn: (s: Sharing) => void): () => void {
    this.sharingHandlers.add(fn);
    return () => this.sharingHandlers.delete(fn);
  }

  onShowing(fn: (s: Showing) => void): () => void {
    this.showingHandlers.add(fn);
    return () => this.showingHandlers.delete(fn);
  }

  /** Every status the subscription reports after the first one. */
  onStatus(fn: (status: string) => void): () => void {
    this.statusHandlers.add(fn);
    return () => this.statusHandlers.delete(fn);
  }

  send(event: string, payload: unknown): void {
    // The result is worth looking at. `send` resolves to "ok", "timed out" or
    // "error" -- and, on a channel the server has closed, quietly falls back to
    // the REST endpoint and still says "ok" while nobody is subscribed to
    // receive it. Discarding that makes a message that never arrived look
    // exactly like one that was never sent.
    void this.live.send({ type: "broadcast", event, payload })
      .then((status) => {
        if (status !== "ok") console.warn(`${event} did not send: ${status}`);
      })
      .catch((e) => console.warn(`${event} did not send:`, e));
  }

  invite(i: Invite): void { this.send(INVITE, i); }
  resume(i: Invite): void { this.send(RESUME, i); }
  reply(r: InviteReply): void { this.send(REPLY, r); }
  cancel(c: InviteCancel): void { this.send(CANCEL, c); }
  handover(h: Handover): void { this.send(HANDOVER, h); }
  sharing(x: Sharing): void { this.send(SHARING, x); }
  showing(x: Showing): void { this.send(SHOWING, x); }

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
    this.closing = true;
    if (this.rejoinTimer !== null) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    this.inviteHandlers.clear();
    this.resumeHandlers.clear();
    this.replyHandlers.clear();
    this.cancelHandlers.clear();
    this.statusHandlers.clear();
    this.handoverHandlers.clear();
    this.sharingHandlers.clear();
    this.showingHandlers.clear();
    this.byteHandlers.clear();
    this.presenceHandlers.clear();
    await supabase.removeChannel(this.live);
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
