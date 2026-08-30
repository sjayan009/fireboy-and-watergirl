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
import { Activity, Invite, PairChannel, Presence } from "./net/pairchannel.js";
import { RealtimeTransport } from "./net/realtime.js";
import { auth, onBeforeSignOut } from "./auth.js";
import { Friend, listFriends } from "./friends.js";

export interface FriendState extends Friend {
  /** What they are doing, or null when they are not online. */
  activity: Activity | null;
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
}

const STUN: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export class Lobby {
  private channels = new Map<string, PairChannel>();
  private activity = new Map<string, Activity>();
  private friends: FriendState[] = [];
  private changeHandlers = new Set<(f: FriendState[]) => void>();
  private inviteHandlers = new Set<(i: Invite, from: FriendState) => void>();
  /**
   * Invitations sent and not yet answered, by session id.
   *
   * Two waiters, not one: the inviter needs to know when the other side has
   * agreed to negotiate (so it can offer) and, separately, when their session
   * exists (so it can start the level).
   */
  private outbound = new Map<string, {
    accepted: () => void;
    ready: () => void;
  }>();

  private constructor(private readonly me: Presence) {}

  /** The signed-in user, as the other side sees them. */
  get self(): Presence { return this.me; }

  static async open(): Promise<Lobby> {
    const profile = auth().profile;
    const user = auth().user;
    if (!profile || !user) throw new Error("not signed in");
    const lobby = new Lobby({
      userId: user.id, username: profile.username, activity: "online",
    });
    await lobby.refresh();
    return lobby;
  }

  /**
   * Re-read the friends list and open a channel for each accepted friend.
   *
   * Only accepted ones: the database refuses a channel for a pending
   * friendship, so opening one would be a guaranteed error rather than an
   * optimistic try.
   */
  async refresh(): Promise<void> {
    const list = await listFriends();
    this.friends = list.map((f) => ({
      ...f, activity: this.activity.get(f.id) ?? null,
    }));

    const wanted = new Set(
      list.filter((f) => f.status === "accepted").map((f) => f.id));

    for (const [id, channel] of this.channels) {
      if (!wanted.has(id)) { channel.close(); this.channels.delete(id); }
    }
    for (const id of wanted) {
      if (this.channels.has(id)) continue;
      try {
        this.channels.set(id, await this.openChannel(id));
      } catch (e) {
        // A channel that will not open is not a reason to have no lobby: the
        // friend simply reads as offline until it does.
        console.warn("could not open the channel for a friend:", e);
      }
    }
    this.announce();
  }

  private async openChannel(friendId: string): Promise<PairChannel> {
    const channel = await PairChannel.open(friendId, this.me);

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
      const from = this.friends.find((f) => f.id === friendId);
      if (!from) return;
      for (const fn of this.inviteHandlers) fn(invite, from);
    });

    channel.onReply((reply) => {
      const waiting = this.outbound.get(reply.session);
      if (!waiting) return;
      if (reply.accepted) waiting.accepted();
      if (reply.ready) waiting.ready();
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

  async setActivity(activity: Activity): Promise<void> {
    this.me.activity = activity;
    for (const c of this.channels.values()) await c.setActivity(activity);
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
    onProgress?: (what: string) => void;
  }): Promise<Ready> {
    const channel = this.channels.get(friendId);
    const friend = this.friends.find((f) => f.id === friendId);
    if (!channel || !friend) throw new Error("that friend is not connected");

    const session = crypto.randomUUID();
    const fireboy = o.iAmFireboy ? this.me.userId : friendId;

    let onAccepted!: () => void;
    let onReady!: () => void;
    const accepted = new Promise<void>((r) => { onAccepted = r; });
    const ready = new Promise<void>((r) => { onReady = r; });
    const refused = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("they did not answer")), 120000);
    });
    this.outbound.set(session, { accepted: onAccepted, ready: onReady });

    try {
      o.onProgress?.("waiting for them to accept…");
      channel.invite({
        session, mode: o.mode, num: o.num, fireboy, from: this.me.userId,
      });
      await Promise.race([accepted, refused]);

      // Offering before this point would put the offer on a channel the other
      // side is not yet listening to, and lose it.
      o.onProgress?.("connecting…");
      const link = await this.link(channel, true);

      await Promise.race([ready, refused]);
      return {
        ...link,
        slot: (fireboy === this.me.userId ? 0 : 1) as Slot,
        mode: o.mode, num: o.num, host: true, friend,
      };
    } finally {
      this.outbound.delete(session);
    }
  }


  /** Accept an invitation, connect, and tell them we are ready. */
  async join(invite: Invite, onProgress?: (what: string) => void): Promise<Ready> {
    const channel = this.channels.get(invite.from);
    const friend = this.friends.find((f) => f.id === invite.from);
    if (!channel || !friend) throw new Error("that friend is not connected");

    // Said FIRST, and listening started before the answer can arrive: the
    // inviter only offers once it has heard this.
    channel.reply({ session: invite.session, accepted: true });

    onProgress?.("connecting…");
    const link = await this.link(channel, false);

    // And only now the second half. The session is built from what this
    // returns, so telling them we are ready before it exists would invite a
    // Start we have nothing to hear it with.
    channel.reply({ session: invite.session, accepted: true, ready: true });

    return {
      ...link,
      slot: (invite.fireboy === this.me.userId ? 0 : 1) as Slot,
      mode: invite.mode, num: invite.num, host: false, friend,
    };
  }

  /**
   * A direct peer connection if one can be had, and the pair's own channel if
   * not. The fallback is why this needs no TURN server -- and also why a pair
   * on it gets the game but not video.
   */
  private async link(channel: PairChannel, caller: boolean) {
    const rendezvous = new RealtimeTransport(channel);
    const link = await connect(rendezvous, caller, { iceServers: STUN });
    if (link.reason) console.info("using the relay path:", link.reason);
    return { transport: link.transport, kind: link.kind };
  }

  async close(): Promise<void> {
    const closing = [...this.channels.values()].map((c) => c.close());
    this.channels.clear();
    this.changeHandlers.clear();
    this.inviteHandlers.clear();
    // Awaited, because leaving a topic is a message to the server and joining
    // the same topic again before it lands is a race the server resolves by
    // dropping one of them.
    await Promise.all(closing);
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

export function getLobby(): Promise<Lobby> {
  if (!current) current = Lobby.open();
  return current;
}

// Registered once, at module scope: signing out must take the websocket and
// the presence announcement with it, whatever screen the button was on.
onBeforeSignOut(closeLobby);

export async function closeLobby(): Promise<void> {
  const lobby = current;
  current = null;
  if (lobby) await (await lobby).close();
}
