/**
 * The one channel a pair of friends shares.
 *
 * Every accepted friendship has exactly one Supabase Realtime topic,
 * `pair:<channel>`, where `channel` is a column of the friendship row that the
 * database replaces whenever the friendship changes state. A topic built from
 * the two user ids could never be withdrawn: an ex-friend who kept a tab open
 * would still be subscribed to it. That single channel carries four things that would otherwise need
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
import { ENGINE_VERSION } from "@engine/version.js";
import { decode } from "./base64.js";
import type { ByteLane } from "./realtime.js";
export { encode, decode } from "./base64.js";

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
  attempt?: string;
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
  between?: boolean;
  /** Opt-in capability, enabled only when the accepting reply also echoes it. */
  pathManager?: true;
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
  attempt?: string;
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
  /** Both clients must advertise this before using the managed path lanes. */
  pathManager?: true;
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
  attempt?: string;
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
  from?: string;
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
  attempt?: string;
  from?: string;
  /** The user id of whoever may start a level from here on. */
  chooser: string;
}

/** The pair's current topic, read from the friendship row both members may see. */
export async function topicFor(me: string, friendId: string): Promise<string> {
  const [lo, hi] = me < friendId ? [me, friendId] : [friendId, me];
  const { data, error } = await supabase.from("friendships").select("channel")
    .eq("user_a", lo).eq("user_b", hi).eq("status", "accepted").maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("You are not friends with that person");
  return "pair:" + (data as { channel: string }).channel;
}

// ---- what arrives on the wire -------------------------------------------
//
// Everything below this line exists because the peer on the other end of an
// accepted friendship is AUTHORIZED, not TRUSTED. The two are easy to conflate
// on a private channel, and the payloads used to be type-cast straight into the
// handlers: `payload as Invite`, `(payload as { p: string[] }).p ?? []`. A
// friend running a modified client -- or anyone who first forged a friendship,
// which until 0015 was a single POST -- could send `p` as a string and have the
// packet loop iterate its characters, send invalid base64 and have `atob` throw
// out of the Realtime callback, send a hundred thousand packets in one message,
// or send a level number the game has no data for and watch the level
// constructor dereference it.
//
// So every event is now parsed rather than cast: a shape that does not fit is
// dropped, and what reaches a handler is an object this file built out of
// values it checked.

/** The three modes and how many levels each has. */
const MODES: Record<string, number> = { adventure: 17, puzzle: 9, speed: 6 };

/** As many packets as one message may carry. A relayed game sends 9-18. */
const MAX_BATCH = 64;

/**
 * The longest a single base64 packet may be.
 *
 * A game packet is 34 bytes -- 48 characters -- and a first draft of this cap
 * said 512 on exactly that reasoning. It was wrong, and wrong in a way worth
 * writing down: this channel does not only carry game packets. The WebRTC
 * handshake runs over it too, as `SIGNAL`-prefixed JSON, and an SDP offer is
 * several kilobytes. A 512-character cap therefore dropped every offer and
 * every answer, silently, and the only symptom was that every pair "fell back"
 * to the relay after eight seconds -- which is a working game, played the
 * expensive way, with nothing in the log to say why.
 *
 * `webrtc.ts` refuses a signalling message over 64 KB, so this is that in
 * base64 with room to spare.
 */
const MAX_PACKET_CHARS = 128 * 1024;

/**
 * And the budget for a whole message, so the two caps cannot be multiplied.
 *
 * Sixty-four packets of a hundred and twenty-eight kilobytes would be eight
 * megabytes of work for one broadcast. Realtime has a message size limit of its
 * own well below this; the point of stating it here is that the limit is ours
 * rather than a property of somebody else's default.
 */
const MAX_MESSAGE_CHARS = 512 * 1024;
/** Enough malformed messages to be a decision rather than a glitch. */
const BAD_LIMIT = 200;

const isUuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const isText = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;

const isSession = (v: unknown): v is string => isText(v, 64);

/**
 * The packets in a byte message, dropping anything that is not one.
 *
 * Capped before it is decoded, not after: the cost of a hostile message has to
 * be bounded by the message rather than by what it claims about itself.
 */
export function packetsIn(payload: unknown): Uint8Array[] {
  const list = (payload as { p?: unknown } | null)?.p;
  if (!Array.isArray(list)) return [];
  const out: Uint8Array[] = [];
  let spent = 0;
  for (const b64 of list.slice(0, MAX_BATCH)) {
    if (typeof b64 !== "string" || b64.length > MAX_PACKET_CHARS) continue;
    spent += b64.length;
    if (spent > MAX_MESSAGE_CHARS) break;
    try {
      out.push(decode(b64));
    } catch {
      // Not base64. `atob` throws, and it used to throw here, inside a
      // Realtime callback, where there was nothing to catch it.
    }
  }
  return out;
}

function asInvite(payload: unknown): Invite | null {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  if (!isSession(p.session) || !isUuid(p.fireboy) || !isUuid(p.from)) return null;
  const levels = typeof p.mode === "string" ? MODES[p.mode] : undefined;
  if (levels === undefined) return null;
  const num = p.num;
  if (typeof num !== "number" || !Number.isInteger(num) ||
      num < 1 || num > levels) {
    return null;
  }
  // Rebuilt rather than passed through, so nothing the sender added travels
  // any further than this function.
  return {
    session: p.session, mode: p.mode as string, num,
    ...(isUuid(p.attempt) ? { attempt: p.attempt } : {}),
    fireboy: p.fireboy, from: p.from,
    ...(p.relay === true ? { relay: true } : {}),
    ...(p.between === true ? { between: true } : {}),
    ...(p.pathManager === true ? { pathManager: true } : {}),
  };
}

function asReply(payload: unknown): InviteReply | null {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  if (!isSession(p.session) || typeof p.accepted !== "boolean") return null;
  return { session: p.session, accepted: p.accepted, ready: p.ready === true,
    ...(isUuid(p.attempt) ? { attempt: p.attempt } : {}),
    ...(p.pathManager === true ? { pathManager: true } : {}) };
}

function asCancel(payload: unknown): InviteCancel | null {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  if (!isSession(p.session) || !isUuid(p.from)) return null;
  return { session: p.session, from: p.from, ...(isUuid(p.attempt) ? { attempt: p.attempt } : {}) };
}

function asHandover(payload: unknown): Handover | null {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  if (!isSession(p.session) || !isUuid(p.chooser)) return null;
  return { session: p.session, chooser: p.chooser, ...(isUuid(p.attempt) ? { attempt: p.attempt } : {}) };
}

function asSharing(payload: unknown): Sharing | null {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  if (!isSession(p.session) || typeof p.on !== "boolean") return null;
  return { session: p.session, on: p.on };
}

function asShowing(payload: unknown): Showing | null {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  // The topic becomes a channel this client subscribes to, so its shape is
  // load-bearing rather than cosmetic.
  if (typeof p.topic !== "string" ||
      !/^watch:[0-9a-f-]{36}:[0-9a-f-]{36}$/i.test(p.topic)) {
    return null;
  }
  const players = p.players;
  if (!Array.isArray(players) || players.length !== 2) return null;
  if (!players.every((n) => isText(n, 20))) return null;
  if (typeof p.on !== "boolean") return null;
  return { topic: p.topic, players: [players[0], players[1]], on: p.on };
}

function asPresence(entry: unknown): Presence | null {
  const p = entry as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  if (!isUuid(p.userId) || !isText(p.username, 20)) return null;
  const activity = p.activity;
  if (activity !== "online" && activity !== "in_lobby" && activity !== "in_game") {
    return null;
  }
  return { userId: p.userId, username: p.username, activity };
}

export class PairChannel {
  private constructor(
    readonly topic: string,
    readonly friendId: string,
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

  /**
   * How many messages from this peer made no sense.
   *
   * Counted rather than acted on immediately, and the circuit breaker below is
   * deliberately one-sided: it stops this client SPENDING work on the peer, and
   * does not take the channel down. Closing on hostile input would hand a
   * malicious friend a way to end your session -- and, since the channel also
   * carries presence, to take you offline to everybody -- which is a worse
   * outcome than ignoring them.
   */
  private bad = 0;
  private receipts = new Set<string>();
  private delivery = new Map<string, ReturnType<typeof setInterval>>();
  private budgetAt = Date.now();
  private budget = 0;
  private unpack(payload: unknown): { id: string; data: unknown } | null {
    if (Date.now() - this.budgetAt > 10000) { this.budgetAt = Date.now(); this.budget = 0; }
    if (++this.budget > 512) {
      for (const fn of this.statusHandlers) fn("PROTOCOL_ERROR");
      void this.close(); return null;
    }
    const p = payload as Record<string, unknown> | null;
    if (!p || p.v !== 2 || p.build !== ENGINE_VERSION || p.from !== this.friendId || !isUuid(p.id)) return null;
    return { id: p.id, data: p.data };
  }

  /** Note a message that did not parse. */
  rubbish(event: string): void {
    this.bad++;
    if (this.bad === BAD_LIMIT) {
      console.warn(`ignoring further malformed messages on ${this.topic} ` +
                   `(last was a ${event})`);
    }
  }

  /** Whether this peer has spent its credibility. */
  tooMuchRubbish(): boolean { return this.bad >= BAD_LIMIT; }

  /** For tests: how many messages have been dropped. */
  get malformed(): number { return this.bad; }

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
  static async open(friendId: string, me: Presence,
                    signal?: AbortSignal, known?: string): Promise<PairChannel> {
    // A Quick Match is handed its topic by the matcher; a friendship reads it.
    const topic = known ?? await topicFor(me.userId, friendId);
    if (signal?.aborted) throw new Error("cancelled");
    const pair = new PairChannel(
      topic,
      friendId,
      supabase.channel(topic, {
        config: { private: true, presence: { key: me.userId } },
      }),
      me);
    // Every way this can fail has to give the channel back. `join(true)`
    // rejects on a refusal and on a fifteen-second timeout, and the callers all
    // catch and drop the object -- so `close()`, the only thing that called
    // `removeChannel`, had become unreachable on exactly the paths that
    // allocate a channel and never use it. A lobby retrying a friend whose
    // channel will not come up leaked one per attempt.
    return pair.join(true).then(() => {
      // Subscribed after the caller gave up. Nothing else holds this.
      if (signal?.aborted) {
        void pair.close();
        throw new Error("cancelled");
      }
      return pair;
    }, async (e) => {
      await pair.close().catch(() => { /* never joined */ });
      throw e;
    });
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
    // A new subscription has heard nothing from anybody and has said nothing
    // to them. Carrying either across would let an activity announce go out to
    // a channel that has not been told who is on it, or let the arrival edge
    // conclude that a channel built one second ago already knows where we are.
    this.occupied = false;
    this.announced = undefined;

    /** Parse, then deliver -- or count it against the peer and drop it. */
    const on = <T>(event: string, parse: (p: unknown) => T | null,
                   handlers: () => Set<(v: T) => void>) => {
      channel.on("broadcast", { event }, ({ payload }) => {
        if (generation !== pair.generation || pair.closing || pair.tooMuchRubbish()) return;
        const envelope = pair.unpack(payload);
        if (!envelope) return;
        const value = parse(envelope.data);
        if (value === null) { pair.rubbish(event); return; }
        void channel.send({ type: "broadcast", event: "ack", payload: { v: 2, build: ENGINE_VERSION, from: pair.me.userId, id: envelope.id } }).catch(() => {});
        if (pair.receipts.has(envelope.id)) return;
        pair.receipts.add(envelope.id);
        if (pair.receipts.size > 256) pair.receipts.delete(pair.receipts.values().next().value!);
        for (const fn of handlers()) fn(value);
      });
    };

    on(INVITE, asInvite, () => pair.inviteHandlers);
    // Deliberately an Invite, and deliberately a different event. It carries
    // exactly the same five things -- who, which level, who is Fireboy -- but
    // it must not raise a banner asking a question that was answered before the
    // connection dropped.
    on(RESUME, asInvite, () => pair.resumeHandlers);
    on(REPLY, asReply, () => pair.replyHandlers);
    on(CANCEL, asCancel, () => pair.cancelHandlers);
    on(HANDOVER, asHandover, () => pair.handoverHandlers);
    on(SHARING, asSharing, () => pair.sharingHandlers);
    on(SHOWING, asShowing, () => pair.showingHandlers);
    channel.on("broadcast", { event: "ack" }, ({ payload }) => {
      const message = pair.unpack(payload);
      if (!message) return;
      const timer = pair.delivery.get(message.id);
      if (timer !== undefined) clearInterval(timer);
      pair.delivery.delete(message.id);
    });
    channel.on("broadcast", { event: BYTES }, ({ payload }) => {
      // One message can carry several packets; see RealtimeTransport. The batch
      // is capped and each entry is decoded inside a catch, so a malformed
      // message costs a bounded amount of work and nothing else.
      if (generation !== pair.generation || pair.closing || pair.tooMuchRubbish()) return;
      const envelope = pair.unpack(payload);
      if (!envelope) return;
      payload = envelope.data;
      // Counted against the peer only when the message was not the right SHAPE.
      // An empty batch is pointless rather than malformed, and counting it
      // would let a peer trip the circuit breaker with a message this client
      // has no complaint about.
      if (!Array.isArray((payload as { p?: unknown } | null)?.p)) {
        pair.rubbish(BYTES);
        return;
      }
      for (const bytes of packetsIn(payload)) {
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
        for (const p of entries) {
          // Presence is whatever the other client tracked, so it is peer input
          // like everything else. An entry that is not one is dropped rather
          // than shown as a friend called `[object Object]`.
          const one = asPresence(p);
          if (one) all.push(one);
        }
      }
      if (generation === pair.generation) pair.occupancy(all);
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
    const wait = Math.min(1000 * 2 ** this.attempts++, 30000) * (0.75 + Math.random() * 0.5);
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
    fn(Object.values(this.live.presenceState<Presence>()).flat().map(asPresence).filter((p): p is Presence => p !== null));
    return () => this.presenceHandlers.delete(fn);
  }

  /**
   * Say what we are doing now.
   *
   * Three things stand between this and the server: saying the same thing
   * twice is not said at all, nobody is told when nobody is listening, and
   * what is left is spaced out. See `PRESENCE_MS` -- the sixth presence call
   * in thirty seconds does not fail, it takes the channel down, and a pair
   * going from level to level spends five without doing anything unusual.
   *
   * Returns as soon as the intention is recorded rather than when it reaches
   * the server, because the only callers are a screen saying what it is doing
   * and none of them can act on the answer.
   */
  setActivity(activity: Activity): void {
    if (this.activity === activity) return;
    this.activity = activity;
    this.announce();
  }

  /**
   * Whether anybody is on the other end of this channel.
   *
   * The lobby holds one channel per accepted friend and `Lobby.setActivity`
   * tells every one of them at once, so entering a level announced to fifty
   * channels whether or not a soul was listening on any of them. Realtime
   * meters a presence call when it is sent and again for each subscriber it
   * reaches, and the cost is that fan-out times the number of transitions the
   * play loop makes -- which is the largest thing this project spends its
   * message allowance on, well before a relayed game is in the picture.
   *
   * So an activity change is announced only where somebody is there to read
   * it. The rest is not deferred or queued, it is simply not said: the value
   * is still kept in `activity`, and the announce that matters happens on the
   * edge below, when a friend actually arrives.
   */
  private occupied = false;

  /**
   * Recompute occupancy, and catch a friend up when they arrive.
   *
   * The false-to-true edge is what makes the gate safe. Without it a friend
   * joining would find a channel whose other member had gone quiet several
   * transitions ago and would show them as merely `online` for as long as the
   * activity held -- so arrival is itself the trigger to say where we are.
   *
   * Their arrival is a `join`, which `sync` already listens for, and the
   * announce it causes is spaced by the same `PRESENCE_MS` budget as any
   * other: a friend reconnecting in a loop cannot spend the channel's
   * allowance on our behalf.
   */
  private occupancy(all: Presence[]): void {
    const was = this.occupied;
    this.occupied = all.some((p) => p.userId !== this.me.userId);
    // A trailing announcement queued while a friend was present has no
    // listener once they leave. Keep the activity, but cancel that send;
    // their next arrival will announce the latest value.
    if (!this.occupied && this.presenceTimer !== null) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    if (this.occupied && !was && this.announced !== this.activity) this.announce();
  }

  /**
   * The activity this subscription has actually sent, as distinct from the one
   * we hold.
   *
   * Without it the arrival edge double-announces on the ordinary path. The
   * join reply arrives before the presence state, so `SUBSCRIBED` fires
   * `announceNow` and the state that follows it is the friend who was already
   * there -- a false-to-true edge, immediately after an announce that said
   * exactly what the edge would say again.
   *
   * Comparing against what went out settles that, and one other case for
   * free: a friend who drops and comes back needs nothing re-sent, because
   * the server holds our presence for as long as we are tracked and hands
   * them the whole state when they rejoin.
   *
   * `undefined` rather than `null` for "nothing sent yet", because `null` is
   * a legitimate activity to have announced -- it is what `track` sends
   * before any screen has said what it is doing.
   */
  private announced: Activity | null | undefined = undefined;

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
   *
   * `force` is for the one announce that cannot wait for somebody to be
   * listening: the first after a subscription, which is how the other side
   * discovers us at all. If both members held their announce until the other
   * appeared, two friends coming online together would sit invisible to each
   * other forever -- the gate has to be opened by somebody, and it is opened
   * by whoever joins.
   */
  private announce(force = false): void {
    if (this.closing || this.presenceTimer !== null) return;
    if (!force && !this.occupied) return;
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
    this.announce(true);
  }

  private async track(): Promise<void> {
    if (this.closing) return;
    this.lastPresence = Date.now();
    const sending = this.activity;
    try {
      await this.live.track(sending ? { ...this.me, activity: sending } : this.me);
      // Only once it has gone. A failed call has told the channel nothing, and
      // recording it as sent would let the arrival edge skip the announce that
      // is meant to repair exactly this.
      this.announced = sending;
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
    if (this.closing) return;
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
    const id = crypto.randomUUID();
    const envelope = { v: 2, build: ENGINE_VERSION, from: this.me.userId, id, data: payload };
    if (event !== BYTES && event !== SHOWING && this.delivery.size < 32) {
      let tries = 0;
      const timer = setInterval(() => {
        if (++tries > 10 || this.closing) {
          clearInterval(timer); this.delivery.delete(id);
          if (!this.closing) for (const fn of this.statusHandlers) fn("CONTROL_TIMEOUT");
          return;
        }
        if (this.live.state === "joined") void this.live.send({ type: "broadcast", event, payload: envelope }).catch(() => {});
      }, 1000);
      this.delivery.set(id,timer);
    }
    void this.live.send({ type: "broadcast", event, payload: envelope })
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
    this.heldBytes = new Map();
    // Gameplay heals the stalled input history before any new negotiation.
    for (const lane of ["gameplay", "legacy", "control", "signaling"] as const) {
      const packets = bytes.get(lane);
      if (packets) this.sendBytes(packets, lane === "legacy" ? undefined : lane);
    }
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
  // Lane metadata is local only; the scoped byte prefix remains the wire
  // contract. A pending PROBE or ICE candidate must never evict the final
  // history packet of a stalled relay session. Legacy callers retain their
  // original newest-batch semantics. Signaling keeps a bounded offer/ICE burst.
  private heldBytes = new Map<ByteLane | "legacy", string[]>();

  sendBytes(packets: string[], lane?: ByteLane): void {
    if (this.closing) return;
    if (this.live.state !== "joined") {
      const key = lane ?? "legacy";
      const candidates = lane === "signaling"
        ? [...(this.heldBytes.get(key) ?? []), ...packets] : packets;
      let chars = 0;
      const held: string[] = [];
      for (let i = candidates.length - 1; i >= 0 && held.length < MAX_BATCH; i--) {
        const packet = candidates[i];
        if (packet.length > MAX_PACKET_CHARS || chars + packet.length > MAX_MESSAGE_CHARS) continue;
        chars += packet.length; held.push(packet);
      }
      this.heldBytes.set(key, held.reverse());
      return;
    }
    this.send(BYTES, { p: packets });
  }

  /**
   * Awaitable: leaving is a message to the server, not a local flag.
   *
   * Idempotent, because it is now reached from the failure paths of `open` as
   * well as from the lobby, and both can happen for one channel.
   */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const timer of this.delivery.values()) clearInterval(timer);
    this.delivery.clear(); this.receipts.clear(); this.held = []; this.heldBytes.clear();
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
