/**
 * Finding each other, agreeing who plays whom, and getting connected.
 *
 * The lobby holds one open channel per accepted friend. That is what makes
 * presence and invitations possible at all: you cannot be told a friend came
 * online by a server you are not listening to.
 *
 * ## The handshake
 *
 *   1. The inviter picks a friend, a level, and **who is Fireboy** -- then
 *      broadcasts an invite carrying all three and a session id.
 *   2. The invitee accepts, says so, and starts listening for a peer
 *      connection.
 *   3. Only THEN does the inviter offer one. Both sides negotiate over the
 *      pair's channel, falling back to relaying over that same channel if the
 *      NAT refuses a direct connection.
 *   4. The invitee says `ready` once its session exists.
 *   5. Only then does the inviter send Start, so nobody starts a level the
 *      other peer has no session to receive.
 *
 * Steps 3 and 4 are not ceremony, and step 3 was learned the hard way. An
 * earlier version had the inviter offer as soon as it sent the invitation,
 * while the invitee was still looking at a banner: the offer arrived at a
 * channel nobody was listening on, was dropped, and eight seconds later every
 * pair on the same local network "fell back" to the relay. A direct connection
 * cannot be negotiated with somebody who has not agreed to negotiate yet.
 *
 * Step 4 is the same care applied to `Start`. It is re-sent a dozen times and
 * would probably survive being early, but "probably" is the wrong standard for
 * the one message that decides which frame both simulations begin on.
 *
 * The role assignment replaces the coin-toss that two anonymous tabs use.
 * `BroadcastTransport.pair()` compares random ids because it has nothing else;
 * an invite says who is who, so the slot comes from the invite and the inviter
 * is the one who offers.
 */
import { connect, TransportKind } from "@engine/net/connect.js";
import { Transport } from "@engine/net/transport.js";
import { Slot } from "@engine/net/session.js";
import {
  Activity, Handover, Invite, InviteCancel, PairChannel, Presence, Sharing,
  Showing,
} from "./net/pairchannel.js";
import { RealtimeTransport } from "./net/realtime.js";
import { runtimeIceServers } from "./net/turn.js";
import { createPathManager } from "./net/pathmanager.js";
import { networkFlags } from "./net/flags.js";
import { boundedTransport, scopedChannel } from "./net/scope.js";
import { auth, onAuth, onBeforeSignOut } from "./auth.js";
import { Friend, listFriends } from "./friends.js";

export interface FriendState extends Friend {
  /** What they are doing, or null when they are not online. */
  activity: Activity | null;
  connection: "connecting" | "connected" | "unavailable";
  /** A Quick Match partner: in the lobby for the match, never in the friends list. */
  stranger?: boolean;
}

export interface Ready {
  transport: Transport;
  kind: TransportKind;
  slot: Slot;
  mode: string;
  num: number;
  /** Whether this peer is the one that should send Start. */
  host: boolean;
  friend: FriendState;
  /**
   * The invitation this came from, carried back so the caller can hold on to
   * it. Rebuilding a dropped link means re-offering the same one -- same
   * session, same level, same roles -- so it has to outlive the handshake.
   */
  invite: Invite;
}

/** Public STUN fallback. Short-lived TURN credentials are loaded at runtime. */
const FALLBACK_ICE: RTCIceServer[] = iceServers();

function iceServers(): RTCIceServer[] {
  const configured = __ICE_SERVERS__;
  if (!configured) {
    return [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ];
  }
  try {
    // Validated STUN-only JSON from the build configuration. Runtime TURN
    // credentials never use this static value.
    return JSON.parse(configured) as RTCIceServer[];
  } catch (e) {
    console.warn("ICE_SERVERS is not valid JSON; using the defaults:", e);
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }
}

/**
 * How many friends' channels this client will hold at once.
 *
 * One private topic per accepted friendship is what makes presence and
 * invitations possible without a shared lobby channel that would tell every
 * account who else is online. It is also O(friends) persistent subscriptions
 * per user, which is fine for the population this project has and is not a
 * design that scales -- so the cap is here, visible, rather than discovered as
 * a Realtime connection limit in front of somebody.
 */
const MAX_CHANNELS = 50;

/** How many channels are opened at the same time. See `refresh`. */
const OPEN_LANES = 6;

export class Lobby {
  private closing = false;
  private abort = new AbortController();
  private refreshing: Promise<void> | null = null;
  lastError: string | null = null;
  private channels = new Map<string, PairChannel>();
  private opening = new Map<string, Promise<PairChannel>>();
  private warmQueue: string[] = [];
  private wanted = new Set<string>();
  private prioritized: string | null = null;
  prioritize(friendId: string): void {
    this.prioritized = friendId;
    this.warmQueue.sort((a, b) => Number(b === friendId) - Number(a === friendId));
    if (this.wanted.has(friendId) && !this.channels.has(friendId)) {
      void this.ensureChannel(friendId).catch(() => {});
    }
    if (this.refreshing) void this.refreshing.then(() => this.refresh());
    else void this.refresh();
  }
  private activity = new Map<string, Activity>();
  private friends: FriendState[] = [];
  /**
   * Quick Match partners, by id. Their channel was opened on the matcher's
   * topic rather than read from a friendship, so a refresh must neither drop
   * them from the list nor close it.
   */
  private strangers = new Map<string, FriendState>();
  private changeHandlers = new Set<(f: FriendState[]) => void>();
  private inviteHandlers = new Set<(i: Invite, from: FriendState) => void>();
  private resumeHandlers = new Set<(i: Invite, from: FriendState) => void>();
  private cancelHandlers =
    new Set<(session: string, from: FriendState, attempt?: string) => void>();
  private handoverHandlers = new Set<(h: Handover) => void>();
  private sharingHandlers = new Set<(s: Sharing) => void>();
  private showingHandlers =
    new Set<(s: Showing, from: FriendState) => void>();
  /**
   * Invitations sent and not yet answered, by session id.
   *
   * Three waiters, not one. The inviter needs to know when the other side has
   * agreed to negotiate (so it can offer) and, separately, when their session
   * exists (so it can start the level) -- and it needs a way to stop waiting,
   * because "not now" and "I changed my mind" are answers too and used to be
   * indistinguishable from a friend who had wandered off.
   */
  private outbound = new Map<string, {
    friendId: string; attempt?: string;
    accepted: (managed: boolean) => void;
    ready: () => void;
    failed: (e: Error) => void;
  }>();

  private refreshTimer: ReturnType<typeof setInterval>;
  private wake = () => { if (!document.hidden) void this.refresh(); };
  private constructor(private readonly me: Presence) {
    this.refreshTimer = setInterval(this.wake, 12000);
    document.addEventListener("visibilitychange", this.wake);
    window.addEventListener("focus", this.wake);
  }

  /** The signed-in user, as the other side sees them. */
  get self(): Presence { return this.me; }

  static open(): Promise<Lobby> {
    const profile = auth().profile;
    const user = auth().user;
    if (!profile || !user) throw new Error("not signed in");
    const lobby = new Lobby({
      userId: user.id, username: profile.username, activity: "online",
    });
    void lobby.refresh();
    return Promise.resolve(lobby);
  }

  /**
   * Re-read the friends list and open a channel for each accepted friend.
   *
   * Only accepted ones: the database refuses a channel for a pending
   * friendship, so opening one would be a guaranteed error rather than an
   * optimistic try.
   */
  async refresh(): Promise<void> {
    if (this.closing) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshNow().catch((e) => {
      this.lastError = (e as Error).message;
      this.announce();
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** A mutation needs a read that began after it, not an older in-flight poll. */
  async refreshAfterChange(): Promise<void> {
    if (this.refreshing) await this.refreshing;
    await this.refresh();
  }

  private async refreshNow(): Promise<void> {
    const list = await listFriends();
    if (this.closing) return;
    this.lastError = null;
    this.friends = list.map((f) => ({
      ...f, activity: this.activity.get(f.id) ?? null,
      connection: this.channels.has(f.id) ? "connected" : "connecting",
    }));
    // A partner who became a friend mid-match is in the list now, on the same
    // topic; one who is still a stranger is put back.
    for (const s of this.strangers.values()) {
      if (!this.friends.some(f => f.id === s.id)) this.friends.push(s);
    }
    this.announce();

    const accepted = list.filter((f) => f.status === "accepted").sort((a,b) => Number(b.id === this.prioritized) - Number(a.id === this.prioritized));
    if (accepted.length > MAX_CHANNELS) {
      // Not a limit anybody in an invite-only project will meet, and a limit
      // all the same: one Realtime channel per friend is a design that stops
      // working at some number, and finding out which number in production is
      // worse than choosing one here. The friends beyond it are still in the
      // list, labeled unavailable; selecting Connect prioritizes that friend.
      console.warn(`${accepted.length} accepted friends; keeping channels for ` +
                   `the first ${MAX_CHANNELS}`);
    }
    const wanted = new Set(accepted.slice(0, MAX_CHANNELS).map((f) => f.id));
    this.wanted = wanted;
    for (const friend of this.friends) {
      if (!wanted.has(friend.id) && !this.strangers.has(friend.id)) friend.connection = "unavailable";
    }

    for (const [id, channel] of this.channels) {
      if (!wanted.has(id) && !this.strangers.has(id)) {
        void channel.close(); this.channels.delete(id); this.activity.delete(id);
        const friend = this.friends.find(f => f.id === id);
        if (friend) friend.activity = null;
      }
    }

    /**
     * Opened a few at a time rather than one after another.
     *
     * Each `open` waits up to fifteen seconds before giving up, and they used
     * to run in a `for` loop -- so a partial Realtime outage cost fifteen
     * seconds PER FRIEND before the lobby was usable, in series, with nothing
     * on screen. Twenty friends and a bad afternoon is five minutes of a blank
     * list.
     *
     * Bounded rather than unbounded, because the far end has a connection
     * limit of its own and answering an outage by opening forty sockets at once
     * is the response most likely to prolong it.
     */
    this.warmQueue = [...wanted].filter(id => !this.channels.has(id) && !this.opening.has(id));
    this.warmChannels();
    this.announce();
  }

  /** Reserve one join lane for the friend the user actually selected. */
  private warmChannels(): void {
    while (!this.closing && this.opening.size < OPEN_LANES - 1 && this.warmQueue.length) {
      const id = this.warmQueue.shift()!;
      if (!this.wanted.has(id) || this.channels.has(id) || this.opening.has(id)) continue;
      void this.ensureChannel(id).catch(() => {
        const friend = this.friends.find(f => f.id === id);
        if (friend) friend.connection = "unavailable";
        this.announce();
      }).finally(() => this.warmChannels());
    }
  }

  /** Wait only for the selected friendship, never the rest of lobby warmup. */
  async ensureChannel(friendId: string, signal?: AbortSignal): Promise<PairChannel> {
    signal?.throwIfAborted();
    if (this.closing) throw new Error("Lobby closed");
    const match = this.strangers.has(friendId) ? this.channels.get(friendId) : undefined;
    if (match) return match;
    if (!this.friends.some(f => f.id === friendId && f.status === "accepted")) await this.cancelWait(this.refresh(), signal);
    signal?.throwIfAborted();
    if (this.closing) throw new Error("Lobby closed");
    if (!this.friends.some(f => f.id === friendId && f.status === "accepted")) throw new Error("that friend is not connected");
    if (!this.wanted.has(friendId)) {
      this.prioritized = friendId;
      await this.cancelWait(this.refreshAfterChange(), signal);
      signal?.throwIfAborted();
      if (this.closing || !this.wanted.has(friendId)) throw new Error("that friend is not connected");
    }
    const connected = this.channels.get(friendId);
    if (connected) return connected;
    this.warmQueue = this.warmQueue.filter(id => id !== friendId);
    while (this.opening.size >= OPEN_LANES && !this.opening.has(friendId)) {
      await this.cancelWait(Promise.race([...this.opening.values()].map(p => p.catch(() => null))), signal);
    }
    const channel = await this.cancelWait(this.openChannel(friendId), signal);
    if (this.closing || !this.wanted.has(friendId)) { await channel.close(); throw new Error("Lobby closed"); }
    this.channels.set(friendId, channel);
    const friend = this.friends.find(f => f.id === friendId);
    if (friend) friend.connection = "connected";
    this.announce();
    return channel;
  }

  private cancelWait<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(new Error("cancelled"));
      signal.addEventListener("abort", aborted, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
  }

  private async openChannel(friendId: string): Promise<PairChannel> {
    const existing = this.opening.get(friendId);
    if (existing !== undefined) return existing;
    const opening = this.initializeChannel(friendId).then(async channel => {
      if (this.closing || !this.wanted.has(friendId)) { await channel.close(); throw new Error("Lobby closed"); }
      this.channels.set(friendId, channel);
      return channel;
    }).finally(() => this.opening.delete(friendId));
    this.opening.set(friendId,opening);
    return opening;
  }
  private async initializeChannel(friendId: string, topic?: string): Promise<PairChannel> {
    const channel = await PairChannel.open(friendId, this.me, this.abort.signal, topic);
    if (this.closing) { await channel.close(); throw new Error("Lobby closed"); }

    channel.onPresence((all) => {
      const them = all.find((p) => p.userId === friendId);
      if (them) this.activity.set(friendId, them.activity);
      else this.activity.delete(friendId);
      for (const f of this.friends) {
        if (f.id === friendId) f.activity = them?.activity ?? null;
      }
      this.announce();
    });

    channel.onInvite((invite) => {
      if (invite.from !== friendId || ![this.me.userId, friendId].includes(invite.fireboy)) return;
      const from = this.friends.find((f) => f.id === friendId);
      if (!from) return;
      for (const fn of this.inviteHandlers) fn(invite, from);
    });

    channel.onHandover((h) => {
      for (const fn of this.handoverHandlers) fn({ ...h, from: friendId });
    });

    channel.onSharing((x) => {
      for (const fn of this.sharingHandlers) fn({ ...x, from: friendId });
    });

    channel.onShowing((x) => {
      const from = this.friends.find((f) => f.id === friendId);
      if (!from) return;
      for (const fn of this.showingHandlers) fn(x, from);
    });

    channel.onResume((invite) => {
      const from = this.friends.find((f) => f.id === friendId);
      if (!from) return;
      for (const fn of this.resumeHandlers) fn(invite, from);
    });

    channel.onReply((reply) => {
      const waiting = this.outbound.get(reply.session);
      if (!waiting || waiting.friendId !== friendId || waiting.attempt !== reply.attempt) return;
      if (!reply.accepted) { waiting.failed(new Error("they said not now")); return; }
      waiting.accepted(reply.pathManager === true);
      if (reply.ready) waiting.ready();
    });
    channel.onStatus(status => {
      const friend = this.friends.find(f => f.id === friendId);
      // Two of these are not Realtime's, and treating them as if they were is
      // what made them bugs.
      //
      // PROTOCOL_ERROR means the peer tripped the message budget and the
      // channel closed ITSELF. Leaving it in the map left the friend reading
      // as connected against a channel nothing was listening to, with no way
      // back short of reloading the page -- so it is dropped here, and the
      // refresh that follows opens a new one.
      if (status === "PROTOCOL_ERROR") {
        if (this.channels.get(friendId) === channel) this.channels.delete(friendId);
        if (friend) { friend.connection = "connecting"; friend.activity = null; }
        this.activity.delete(friendId);
        this.announce();
        if (!this.closing) void this.refresh();
        return;
      }
      // CONTROL_TIMEOUT is one message going unacknowledged. It says something
      // about that message and nothing about whether the friend is reachable,
      // and marking them offline for it made a single slow round trip look
      // like somebody leaving.
      if (status === "CONTROL_TIMEOUT") return;
      if (friend) {
        friend.connection = status === "SUBSCRIBED" ? "connected" : "unavailable";
        if (status !== "SUBSCRIBED") { friend.activity = null; this.activity.delete(friendId); }
      }
      this.announce();
    });

    // A cancel can land on either side and at any point -- including in the
    // middle of the peer-connection handshake, where there is no reply to carry
    // it -- so it is broadcast to whoever is interested rather than posted to
    // one waiter. `invite` and `join` both listen, and so does the screen, which
    // has a banner to take down whether or not anybody had pressed anything.
    channel.onCancel((c: InviteCancel) => {
      const from = this.friends.find((f) => f.id === friendId);
      const waiting = this.outbound.get(c.session);
      if (c.from !== friendId) return;
      if (waiting && waiting.friendId === friendId && waiting.attempt === c.attempt) waiting.failed(new Error("they cancelled"));
      if (!from) return;
      for (const fn of this.cancelHandlers) fn(c.session, from, c.attempt);
    });

    return channel;
  }

  private announce(): void {
    const snapshot = this.friends.slice();
    for (const fn of this.changeHandlers) fn(snapshot);
  }

  // ---- what the screens use ----------------------------------------------

  get list(): FriendState[] { return this.friends.slice(); }

  onChange(fn: (f: FriendState[]) => void): () => void {
    this.changeHandlers.add(fn);
    fn(this.friends.slice());
    return () => this.changeHandlers.delete(fn);
  }

  onInvite(fn: (i: Invite, from: FriendState) => void): () => void {
    this.inviteHandlers.add(fn);
    return () => this.inviteHandlers.delete(fn);
  }

  /**
   * The other side is rebuilding the link for a match we are already in.
   *
   * Answered exactly like an invitation, by `join` -- but silently, because
   * nobody is being asked anything. They said yes before the connection broke.
   */
  onResume(fn: (i: Invite, from: FriendState) => void): () => void {
    this.resumeHandlers.add(fn);
    return () => this.resumeHandlers.delete(fn);
  }

  /** The other player has said who picks the levels from here on. */
  onHandover(fn: (h: Handover) => void): () => void {
    this.handoverHandlers.add(fn);
    return () => this.handoverHandlers.delete(fn);
  }

  /** Whether this match may be watched. Told to the other player. */
  onSharing(fn: (s: Sharing) => void): () => void {
    this.sharingHandlers.add(fn);
    return () => this.sharingHandlers.delete(fn);
  }

  sharing(friendId: string, s: Sharing): void {
    this.channels.get(friendId)?.sharing(s);
  }

  /** A friend's game has opened, or closed, to watchers. */
  onShowing(fn: (s: Showing, from: FriendState) => void): () => void {
    this.showingHandlers.add(fn);
    return () => this.showingHandlers.delete(fn);
  }

  /**
   * Tell everybody we could be watched by, who is in a position to hear it.
   *
   * Our own accepted friends, because those are the channels we are allowed to
   * speak on -- and between the two players that covers exactly the set the
   * watch topic's policy admits. A friend of both hears it twice and shows one
   * row, which is what the session id is for.
   *
   * `repeat` is the beat rather than the news, and only the beat is filtered
   * to friends who are online. That split is the whole difference between this
   * scaling and not. Turning sharing on or off happens twice a match and is
   * worth telling everyone -- including somebody whose presence has not
   * reached us yet, who would otherwise wait a whole beat for a row. The
   * repetition is the part that runs for the life of the match at one message
   * per friend per beat whether or not anybody is there: `players x friends`,
   * growing with the friend graph rather than with the number of games being
   * played, and four hundred messages a second at a hundred players with ten
   * friends each, against a limit of a hundred.
   *
   * Nothing is lost by leaving the absent out of the beat: a broadcast reaches
   * whoever is subscribed at that instant, so an offline friend was never
   * going to hear it, and they are told the moment they are worth telling.
   */
  announceShowing(s: Showing, repeat = false): void {
    for (const [id, channel] of this.channels) {
      if (!repeat || this.activity.get(id)) channel.showing(s);
    }
  }

  /** Say that somebody else picks the levels now. */
  handover(friendId: string, h: Handover): void {
    this.channels.get(friendId)?.handover(h);
  }

  /** An invitation was withdrawn, by whichever side had it in hand. */
  onCancel(fn: (session: string, from: FriendState, attempt?: string) => void): () => void {
    this.cancelHandlers.add(fn);
    return () => this.cancelHandlers.delete(fn);
  }

  /**
   * Say what this account is doing, on every channel it holds.
   *
   * Not awaited per channel, and no longer pretending to be: `PairChannel`
   * records the intention and spaces the actual presence calls out against the
   * server's budget, so there was never anything to wait for -- an `await` in
   * this loop only made the caller's `void lobby.setActivity(...)` look like it
   * meant something.
   */
  setActivity(activity: Activity): void {
    this.me.activity = activity;
    for (const c of this.channels.values()) c.setActivity(activity);
  }

  // ---- a Quick Match --------------------------------------------------------

  /** Join the pair topic the matcher handed out, and list the partner for the match. */
  async openMatch(m: { partner: string; username: string; topic: string }, signal?: AbortSignal): Promise<void> {
    // A friend Quick Match found is already in the lobby on this same topic.
    if (this.channels.has(m.partner) && this.friends.some(f => f.id === m.partner && !f.stranger)) return;
    const friend: FriendState = {
      id: m.partner, username: m.username, status: "accepted", theirMove: false, ourMove: false,
      blockedByMe: false, activity: null, connection: "connecting", stranger: true,
    };
    this.strangers.set(m.partner, friend);
    if (!this.friends.some(f => f.id === m.partner)) this.friends.push(friend);
    this.announce();
    try {
      const channel = await this.cancelWait(this.initializeChannel(m.partner, m.topic), signal);
      if (this.closing || !this.strangers.has(m.partner)) { await channel.close(); throw new Error("cancelled"); }
      this.channels.set(m.partner, channel);
      friend.connection = "connected";
      this.announce();
    } catch (e) {
      this.closeMatch(m.partner);
      throw e;
    }
  }

  /** Resolve once the partner's presence has arrived on the match topic. */
  present(id: string, signal: AbortSignal, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let off: (() => void) | null = null;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); off?.(); signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve();
      };
      const aborted = () => done(new Error("cancelled"));
      const timer = setTimeout(() => done(new Error("they did not arrive")), ms);
      signal.addEventListener("abort", aborted, { once: true });
      // `onChange` calls back at once, so it can settle before `off` exists.
      off = this.onChange(list => { if (list.some(f => f.id === id && f.activity !== null)) done(); });
      if (settled) off();
    });
  }

  /**
   * The match is over. A partner who is still a stranger leaves the lobby with
   * their channel; one who became a friend stays, on the topic they already had.
   */
  closeMatch(id: string): void {
    if (!this.strangers.delete(id)) return;
    const friend = this.friends.find(f => f.id === id);
    if (friend?.stranger) {
      this.friends = this.friends.filter(f => f !== friend);
      const channel = this.channels.get(id);
      this.channels.delete(id);
      this.activity.delete(id);
      void channel?.close();
    }
    this.announce();
  }

  // ---- starting a game ----------------------------------------------------

  /**
   * Invite a friend, wait for them to be ready, and come back connected.
   *
   * `iAmFireboy` is the whole role decision: whoever is Fireboy takes slot 0
   * and drives the first three input bits. Both peers read it from the same
   * broadcast, so there is nothing to agree on afterwards.
   */
  async invite(friendId: string, o: {
    mode: string; num: number; iAmFireboy: boolean;
    /** Start on the map with no level picked; mode and num are then a placeholder. */
    between?: boolean;
    onProgress?: (what: string) => void;
    /** Abort and withdraw the invitation, at any point up to the first frame. */
    signal?: AbortSignal;
    /** Pair ownership and critical art barrier, started alongside the handshake. */
    beforeReady?: (signal: AbortSignal) => Promise<void>;
  }): Promise<Ready> {
    return this.offer(friendId, {
      session: crypto.randomUUID(),
      mode: o.mode, num: o.num,
      fireboy: o.iAmFireboy ? this.me.userId : friendId,
      from: this.me.userId,
      ...(o.between ? { between: true } : {}),
    }, false, o);
  }

  /**
   * Build the link again for a match that already exists.
   *
   * The pair's Realtime channel is not the game's link and never was -- it is
   * presence and invitations, and it outlives any one session. So when the peer
   * connection dies, the thing that would have introduced the two of them in
   * the first place is still there, and reconnecting is the same handshake with
   * every question already answered: same session, same level, same roles.
   *
   * Only the peer who sent the original invitation calls this. It was the
   * caller then and is the caller now, so there is no role to re-agree and no
   * race between two peers both trying to offer.
   */
  async resume(friendId: string, invite: Invite, o: {
    onProgress?: (what: string) => void;
    signal?: AbortSignal;
  } = {}): Promise<Ready> {
    invite.attempt = crypto.randomUUID();
    return this.offer(friendId, invite, true, o);
  }

  /**
   * Ask the other side to rebuild the link, without offering one.
   *
   * The peer who did the inviting is the one who offers, so the other peer
   * noticing first has nothing to do -- and nothing to do is a deadlock, since
   * a peer connection can fail at one end and be perfectly happy at the other.
   * The same `resume` broadcast serves both directions: from the inviter it is
   * an offer, and from the other side it is a request for one.
   */
  askResume(friendId: string, invite: Invite): void {
    this.channels.get(friendId)?.resume(invite);
  }

  /**
   * The offering half of the handshake, for both a first invitation and a
   * reconnection. See `invite` for what each step is waiting on and why.
   */
  private async offer(friendId: string, invite: Invite, resuming: boolean, o: {
    onProgress?: (what: string) => void;
    signal?: AbortSignal;
    beforeReady?: (signal: AbortSignal) => Promise<void>;
  }): Promise<Ready> {
    // Credentials are shared cached reads; begin loading at intent, while only
    // this friendship joins and the other player decides whether to accept.
    const iceReady = runtimeIceServers(FALLBACK_ICE);
    const channel = await this.ensureChannel(friendId, o.signal);
    const friend = this.friends.find((f) => f.id === friendId);
    if (!channel || !friend) throw new Error("that friend is not connected");

    const { session, fireboy } = invite;
    invite.attempt ??= crypto.randomUUID();
    invite.pathManager = networkFlags.pathManager || undefined;
    const attempt = new AbortController();
    const abortLink = () => attempt.abort();
    o.signal?.addEventListener("abort", abortLink, { once: true });

    let onAccepted!: (managed: boolean) => void;
    let onReady!: () => void;
    let fail!: (e: Error) => void;
    const accepted = new Promise<boolean>((r) => { onAccepted = r; });
    const ready = new Promise<void>((r) => { onReady = r; });
    // One rejection for every way this can end badly -- a decline, a cancel,
    // and nobody answering at all. Raced against each step, so "not now" is
    // heard while we are still waiting to accept AND while we are already
    // negotiating a peer connection.
    const refused = new Promise<never>((_, reject) => { fail = reject; });
    // A reconnection is given far less rope than an invitation. Two minutes is
    // how long somebody might reasonably take to notice a banner; a peer that
    // is there at all answers a resume in seconds, and waiting longer only
    // delays the next attempt.
    const timer = setTimeout(
      () => fail(new Error(resuming ? "they did not come back"
                                    : "they did not answer")),
      resuming ? 15000 : 120000);

    // Withdrawing means telling them, or their banner sits there offering a
    // game nobody is on the other end of any more.
    const onAbort = () => {
      channel.cancel({ session, attempt: invite.attempt, from: this.me.userId });
      fail(new Error("cancelled"));
    };
    o.signal?.addEventListener("abort", onAbort);
    this.outbound.set(session, {
      friendId, attempt: invite.attempt,
      accepted: onAccepted, ready: onReady, failed: fail,
    });

    try {
      if (o.signal?.aborted) throw new Error("cancelled");
      const preparation = o.beforeReady?.(attempt.signal) ?? Promise.resolve();
      void preparation.catch(error => fail(error instanceof Error ? error : new Error("preparation failed")));
      o.onProgress?.(resuming ? "reconnecting…" : "waiting for them to accept…");
      if (resuming) channel.resume(invite);
      else channel.invite(invite);
      const peerManaged = await Promise.race([accepted, refused]);
      const managed = networkFlags.pathManager && peerManaged;
      invite.pathManager = managed || undefined;

      // Offering before this point would put the offer on a channel the other
      // side is not yet listening to, and lose it.
      o.onProgress?.("connecting…");
      const link = await Promise.race([
        this.link(channel, true, invite.attempt ?? invite.session, attempt.signal, invite.relay, managed, iceReady).then(link => {
          if (attempt.signal.aborted) { link.transport.close(); throw new Error("cancelled"); }
          return link;
        }), refused,
      ]);

      try {
        await Promise.race([Promise.all([ready, preparation]), refused]);
      } catch (e) {
        // The connection came up and then the game did not happen. Nothing
        // else is going to close it.
        link.transport.close();
        throw e;
      }
      return {
        ...link,
        slot: (fireboy === this.me.userId ? 0 : 1) as Slot,
        mode: invite.mode, num: invite.num, host: true, friend, invite,
      };
    } finally {
      attempt.abort();
      o.signal?.removeEventListener("abort", abortLink);
      // The timer used to be left running. It fired minutes into a game that
      // had started perfectly well and rejected a promise nobody was holding
      // any more, which is an unhandled rejection and nothing else.
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      this.outbound.delete(session);
    }
  }


  /**
   * Say no, without connecting.
   *
   * Separate from aborting a `join`, because the common case never started one:
   * the banner is up, the answer is no, and there is nothing in flight to
   * cancel -- only somebody on the other side who deserves to be told rather
   * than left watching a spinner for two minutes.
   */
  decline(invite: Invite): void {
    this.channels.get(invite.from)?.reply({
      session: invite.session, attempt: invite.attempt, accepted: false,
    });
  }

  /** Accept an invitation, connect, and tell them we are ready. */
  async join(invite: Invite, o: {
    onProgress?: (what: string) => void;
    /** Back out again, at any point up to the first frame. */
    signal?: AbortSignal;
    /** Do not announce playable readiness before pair projection and art exist. */
    beforeReady?: (signal: AbortSignal) => Promise<void>;
  } = {}): Promise<Ready> {
    const iceReady = runtimeIceServers(FALLBACK_ICE);
    const channel = await this.ensureChannel(invite.from, o.signal);
    const friend = this.friends.find((f) => f.id === invite.from);
    if (!channel || !friend) throw new Error("that friend is not connected");
    if (o.signal?.aborted) throw new Error("cancelled");
    const attempt = new AbortController();
    const abortLink = () => attempt.abort();
    o.signal?.addEventListener("abort", abortLink, { once: true });

    // The same endings as the other side, minus the timeout: whoever waits here
    // is waiting on a handshake, not on a person.
    let fail!: (e: Error) => void;
    const refused = new Promise<never>((_, reject) => { fail = reject; });
    const onAbort = () => {
      // Backing out after saying yes has to be said twice: the reply is what
      // stops them waiting, the cancel is what stops a handshake that may
      // already be in flight.
      channel.reply({ session: invite.session, attempt: invite.attempt, accepted: false });
      channel.cancel({ session: invite.session, attempt: invite.attempt, from: this.me.userId });
      fail(new Error("cancelled"));
    };
    o.signal?.addEventListener("abort", onAbort);
    const offCancel = this.onCancel((session, from, identity) => {
      if (session === invite.session && from.id === invite.from && identity === invite.attempt) fail(new Error("they cancelled"));
    });

    try {
      const preparation = o.beforeReady?.(attempt.signal) ?? Promise.resolve();
      void preparation.catch(error => fail(error instanceof Error ? error : new Error("preparation failed")));
      // Said FIRST, and listening started before the answer can arrive: the
      // inviter only offers once it has heard this.
      // Prefetch before acceptance, so a slow broker cannot leave the receiver
      // waiting for credentials while the caller sends its one-shot SDP.
      if (attempt.signal.aborted) throw new Error("cancelled");
      const managed = networkFlags.pathManager && invite.pathManager === true;
      invite.pathManager = managed || undefined;
      o.onProgress?.("connecting…");
      // Install the incoming signaling listener synchronously before acceptance.
      const connecting = this.link(channel, false, invite.attempt ?? invite.session, attempt.signal, invite.relay, managed, iceReady);
      channel.reply({ session: invite.session, attempt: invite.attempt, accepted: true, pathManager: managed || undefined });
      const link = await Promise.race([
        connecting.then(link => {
          if (attempt.signal.aborted) { link.transport.close(); throw new Error("cancelled"); }
          return link;
        }), refused,
      ]);

      if (o.signal?.aborted) {
        link.transport.close();
        throw new Error("cancelled");
      }
      try { await Promise.race([preparation, refused]); }
      catch (error) { link.transport.close(); throw error; }
      if (attempt.signal.aborted) { link.transport.close(); throw new Error("cancelled"); }

      // And only now the second half. The session is built from what this
      // returns, so telling them we are ready before it exists would invite a
      // Start we have nothing to hear it with.
      channel.reply({ session: invite.session, attempt: invite.attempt, accepted: true, ready: true, pathManager: managed || undefined });

      return {
        ...link,
        slot: (invite.fireboy === this.me.userId ? 0 : 1) as Slot,
        mode: invite.mode, num: invite.num, host: false, friend, invite,
      };
    } finally {
      attempt.abort();
      o.signal?.removeEventListener("abort", abortLink);
      o.signal?.removeEventListener("abort", onAbort);
      offCancel();
    }
  }

  /** Load runtime ICE, then select the mutually agreed connection owner. */
  private async link(channel: PairChannel, caller: boolean,
                     identity: string, signal?: AbortSignal, relayOnly?: boolean, managed = false,
                     iceReady = runtimeIceServers(FALLBACK_ICE)) {
    if (signal?.aborted) throw new Error("cancelled");
    const scoped = scopedChannel(channel, identity);
    // This query is compile-time excluded from production behavior.
    const iceTransportPolicy = import.meta.env.DEV && new URLSearchParams(location.search).get("forceTurn") === "1"
      ? "relay" as const : undefined;
    if (managed) {
      const manager = createPathManager(scoped, caller, {
        iceTransportPolicy, legacyBatching: networkFlags.legacyBatching,
        refreshIceServers: () => runtimeIceServers(FALLBACK_ICE),
      });
      // The attempt AbortSignal is released when setup completes. The stable
      // manager owns its own lifetime after this point.
      return { transport: boundedTransport(manager), kind: manager.kind };
    }
    const rendezvous = new RealtimeTransport(scoped, { legacyBatching: networkFlags.legacyBatching });
    const iceServers = await iceReady;
    if (signal?.aborted) { rendezvous.close(); throw new Error("cancelled"); }
    const link = await connect(rendezvous, caller,
                               { iceServers, iceTransportPolicy, signal, relayOnly });
    if (link.reason) console.info("using the relay path:", link.reason);
    return { transport: boundedTransport(link.transport), kind: link.kind };
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.refreshTimer);
    document.removeEventListener("visibilitychange", this.wake);
    window.removeEventListener("focus", this.wake);
    this.abort.abort();
    this.warmQueue = []; this.wanted.clear(); this.strangers.clear();
    for (const pending of this.outbound.values()) pending.failed(new Error("signed out"));
    this.outbound.clear();
    const closing = [...this.channels.values()].map((c) => c.close());
    this.channels.clear();
    this.changeHandlers.clear();
    this.inviteHandlers.clear();
    this.resumeHandlers.clear();
    this.cancelHandlers.clear();
    this.handoverHandlers.clear();
    this.sharingHandlers.clear();
    this.showingHandlers.clear();
    // Awaited, because leaving a topic is a message to the server and joining
    // the same topic again before it lands is a race the server resolves by
    // dropping one of them.
    await Promise.all([...closing, ...[...this.opening.values()].map(work => work.then(() => {}, () => {}))]);
  }
}

/**
 * The lobby belongs to the SESSION, not to a screen.
 *
 * It was per-screen first, and that was wrong twice over. Practically, it made
 * navigating to the friends list and back tear down every channel and rejoin
 * the same topics a moment later -- a join racing a leave, which the server
 * settles by dropping one, and which showed up as a friend who was plainly
 * online reading as offline about a third of the time.
 *
 * Conceptually it is worse: an invitation should reach you while you are
 * looking at your friends list, which is exactly where you are when somebody
 * decides to invite you.
 */
let current: Promise<Lobby> | null = null;
let currentOwner: string | null = null;

export function getLobby(): Promise<Lobby> {
  if (!current) {
    currentOwner = auth().user?.id ?? null;
    const opening = Lobby.open();
    current = opening;
    void opening.catch(() => { if (current === opening) current = null; });
  }
  return current;
}

/**
 * The lobby if there is one, and nothing if there is not.
 *
 * The friends screen uses this to tell an existing lobby that the friend list
 * has changed -- a newly accepted friendship needs a channel, and the lobby
 * only re-reads the list when something asks it to. It must not CREATE one:
 * opening a lobby subscribes a channel per friend and announces presence, which
 * is not what looking at a list should do.
 */
export function peekLobby(): Promise<Lobby> | null {
  return current;
}

// Registered once, at module scope: signing out must take the websocket and
// the presence announcement with it, whatever screen the button was on.
onBeforeSignOut(closeLobby);
onAuth(state => {
  if (current && (state.stage !== "in" || state.user?.id !== currentOwner)) void closeLobby().catch(() => {});
});

export async function closeLobby(): Promise<void> {
  const lobby = current;
  current = null;
  currentOwner = null;
  if (lobby) await (await lobby).close();
}
