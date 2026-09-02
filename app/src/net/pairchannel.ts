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
  /**
   * The last link this pair had was a relay, so do not try for another peer
   * connection.
   *
   * Only ever set on a RESUME, and it is on the invitation rather than agreed
   * separately because both peers read this same object -- the one that offers
   * and the one that answers -- so there is nothing for them to disagree
   * about. A fresh invitation never carries it, which is what gives a pair who
   * have since moved networks their peer connection back.
   */
  relay?: boolean;
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

/**
 * The shortest gap between two presence announcements, in milliseconds.
 *
 * This is a hard server limit and not a nicety. Realtime allows a client FIVE
 * presence calls per channel per thirty seconds, and the sixth is not dropped
 * -- it CLOSES THE CHANNEL. In the project's Realtime log it reads
 * `ClientPresenceRateLimitReached: :client_rate_limit_exceeded`, and the line
 * after it in the server is `shutdown_response`, which arrives here as CLOSED.
 *
 * A pair spends that budget just by playing: every level says "in a game" when
 * it starts and "in the lobby" when it ends, so three levels in half a minute
 * is five calls and the fourth transition takes the channel down -- presence,
 * invitations, the level handover and, for a relayed pair, the game itself.
 *
 * Eight seconds allows four in any thirty, which leaves a call in hand for the
 * announcement a rejoin has to make. The cost is that "in a game" can be up to
 * eight seconds late in a friend's list, which is a readout nobody is timing.
 */
const PRESENCE_MS = 8000;

/**
 * How long a subscription may be missing before anybody is told, in
 * milliseconds.
 *
 * A channel that has gone is rebuilt here in about a second and a half, and
 * for a relayed game the difference between saying so and not is the
 * difference between a stall and a teardown: the netcode stalls when it gets
 * ten frames ahead of what the peer has confirmed and resumes from exactly
 * there, whereas `onClosed` costs the pair their session, another handshake --
 * eight seconds of it waiting for a peer connection that already failed once
 * -- and the level starting again from the beginning.
 *
 * So a blip is not reported at all, and a real outage is reported late. Long
 * enough for two attempts at coming back; short enough that a pair whose
 * channel is actually gone is not left watching a frozen canvas.
 */
const DOWN_GRACE_MS = 6000;

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
  /** How many subscriptions this pair has had. See `join`. */
  private generation = 0;
  /** Whether the handlers have been told the subscription is gone. */
  private reportedDown = false;
  private downTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The subscription is back, or never really went.
   *
   * Told to nobody if nobody was told it had gone: the whole point of the
   * grace period is that an outage the client repairs by itself is not an
   * event anything above here has to have an opinion about.
   */
  private channelUp(): void {
    if (this.downTimer !== null) clearTimeout(this.downTimer);
    this.downTimer = null;
    if (!this.reportedDown) return;
    this.reportedDown = false;
    for (const fn of this.statusHandlers) fn("SUBSCRIBED");
  }

  /** The subscription has gone. Said out loud only if it stays gone. */
  private channelDown(status: string): void {
    if (this.reportedDown || this.downTimer !== null || this.closing) return;
    this.downTimer = setTimeout(() => {
      this.downTimer = null;
      this.reportedDown = true;
      for (const fn of this.statusHandlers) fn(status);
    }, DOWN_GRACE_MS);
  }

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
    /** Which subscription this is, so a discarded one can be ignored. */
    const generation = ++this.generation;

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

      channel.subscribe((status) => {
        // A subscription that has been replaced must stop speaking. Leaving a
        // channel is not silent -- `removeChannel` ends with a CLOSED on the
        // old one -- and that CLOSED used to arrive here, after `rejoin` had
        // already built the replacement, and ask for another rejoin: a channel
        // discarded a moment after it came up, then another, with the backoff
        // doubling each time. The pair reads as permanently reconnecting, and
        // the cause is the reconnection itself.
        if (generation !== pair.generation) return;
        // Everything AFTER the first status is what the connection is doing
        // for the rest of its life, and it used to be dropped on the floor.
        if (settled) {
          if (status === "SUBSCRIBED") {
            pair.attempts = 0;
            pair.flushHeld();
            // The client rejoins this same channel after a socket reconnect,
            // and the server builds a new one to receive it -- which knows
            // nothing about what the old one had been told. Without this, a
            // blip leaves you invisible to a friend looking straight at your
            // name. Its budget is untouched for the same reason.
            pair.announceNow();
            pair.channelUp();
          } else {
            pair.rejoin();
            pair.channelDown(status);
          }
          return;
        }
        if (status === "SUBSCRIBED") {
          settled = true;
          pair.attempts = 0;
          clearTimeout(timer);
          pair.flushHeld();
          // Re-announced, because a rejoin brings back the subscription and
          // not what we had told it about ourselves. Without this, a blip
          // leaves you invisible to a friend looking straight at your name.
          //
          // At once, and the budget is reset to allow it: the limit that
          // budget exists for is counted per channel by the server, and this
          // is a channel the server has only just built.
          pair.announceNow();
          pair.channelUp();
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "CLOSED") {
          settled = true;
          clearTimeout(timer);
          if (first) {
            reject(new Error(
              "that channel is not yours -- the friendship must be accepted"));
          } else {
            pair.rejoin();
            pair.channelDown(status);
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

  /**
   * Say what we are doing now.
   *
   * Two things stand between this and the server: saying the same thing twice
   * is not said at all, and what is left is spaced out. See `PRESENCE_MS` --
   * the sixth presence call in thirty seconds does not fail, it takes the
   * channel down, and a pair going from level to level spends five without
   * doing anything unusual.
   *
   * Returns as soon as the intention is recorded rather than when it reaches
   * the server, because the only callers are a screen saying what it is doing
   * and none of them can act on the answer.
   */
  async setActivity(activity: Activity): Promise<void> {
    if (this.activity === activity) return;
    this.activity = activity;
    this.announce();
  }

  /**
   * What we last said we were doing, so a rejoin can say it again.
   *
   * Presence is per-subscription: the new channel knows nothing about what the
   * old one had been told, and announcing the default would put somebody who
   * is mid-game back to "online" in their friend's list.
   */
  private activity: Activity | null = null;
  /** When a presence call last went out, for the budget above. */
  private lastPresence = 0;
  /** Set while the latest activity is waiting for that budget. */
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Announce, or arrange to.
   *
   * Trailing edge, and deliberately not a queue: what is owed is always just
   * the latest activity, so a pair that starts and finishes three levels
   * inside the window announces the state they ended in, once.
   */
  private announce(): void {
    if (this.closing || this.presenceTimer !== null) return;
    const since = Date.now() - this.lastPresence;
    if (since >= PRESENCE_MS) { void this.track(); return; }
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      void this.track();
    }, PRESENCE_MS - since);
  }

  /**
   * Announce at once, on a subscription whose budget is untouched.
   *
   * Anything that was waiting is dropped rather than sent as well: it can only
   * have been an older activity than the one this is about to send.
   */
  private announceNow(): void {
    if (this.presenceTimer !== null) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    this.lastPresence = 0;
    this.announce();
  }

  private async track(): Promise<void> {
    if (this.closing) return;
    this.lastPresence = Date.now();
    try {
      await this.live.track(this.activity
        ? { ...this.me, activity: this.activity } : this.me);
    } catch (e) {
      console.warn("could not announce presence:", e);
    }
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

  /**
   * Messages sent while the subscription was not up, waiting for it to be.
   *
   * Capped, and the oldest go first: this exists to carry a handful of small
   * decisions across a reconnection, not to buffer a game.
   */
  private held: { event: string; payload: unknown }[] = [];

  send(event: string, payload: unknown): void {
    // Held rather than sent while the channel is between subscriptions. The
    // client does not refuse a send on a channel that is only joining -- it
    // quietly falls back to the REST endpoint and returns "ok", and REST
    // publishes to a topic that, at that instant, nobody is subscribed to. The
    // message is reported as delivered and is simply gone, which is the most
    // expensive kind of failure to find: it looks exactly like a screen that
    // ignored a message it never received.
    if (this.live.state !== "joined") {
      this.held.push({ event, payload });
      if (this.held.length > 16) this.held.shift();
      return;
    }
    // The result is worth looking at for the same reason.
    void this.live.send({ type: "broadcast", event, payload })
      .then((status) => {
        if (status !== "ok") console.warn(`${event} did not send: ${status}`);
      })
      .catch((e) => console.warn(`${event} did not send:`, e));
  }

  /** Say the things that were waiting for a subscription. */
  private flushHeld(): void {
    const waiting = this.held;
    this.held = [];
    for (const m of waiting) this.send(m.event, m.payload);
    const bytes = this.heldBytes;
    this.heldBytes = null;
    if (bytes) this.sendBytes(bytes);
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

  /**
   * The one message that is allowed to be thrown away.
   *
   * A game on the relay puts nine of these a second on the channel, and they
   * used to go into the same sixteen-deep hold as everything else -- so two
   * seconds without a subscription evicted every invitation, cancel and
   * handover waiting there, which is exactly the traffic a reconnection is
   * made of. What is held instead is the newest batch and only the newest:
   * every input packet already repeats the last sixteen frames, so an older
   * one has nothing in it the newer one lacks, and keeping one means the Quit
   * that `RealtimeTransport.close` flushes still has somewhere to wait.
   */
  private heldBytes: string[] | null = null;

  sendBytes(packets: string[]): void {
    if (this.live.state !== "joined") { this.heldBytes = packets; return; }
    this.send(BYTES, { p: packets });
  }

  /** Awaitable: leaving is a message to the server, not a local flag. */
  async close(): Promise<void> {
    this.closing = true;
    if (this.rejoinTimer !== null) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    if (this.presenceTimer !== null) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    if (this.downTimer !== null) clearTimeout(this.downTimer);
    this.downTimer = null;
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
