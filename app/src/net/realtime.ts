/**
 * The netcode's `Transport`, over a pair's Realtime channel.
 *
 * This is the seam that lets two PEOPLE find each other rather than two tabs.
 * It implements the same one-method interface as `BroadcastTransport` and the
 * WebRTC data channel, so `connect()` takes it as the rendezvous without
 * knowing what it is, and **the engine never learns that Supabase exists**.
 *
 * It is used for two different jobs, and it is worth being clear which:
 *
 *  * **Always**, to carry the SDP and ICE of the peer-connection handshake.
 *    A handful of messages, then silence.
 *  * **Sometimes**, as the game transport itself, for the pairs whose NAT
 *    refuses a direct connection -- usually 10 to 20%. This is what removes the
 *    need for a TURN server: a session is about ten bytes a second, so relaying
 *    it costs a hop of latency and nothing else.
 *
 * ## Why sends are batched
 *
 * The free tier allows about two million Realtime messages a month. A relayed
 * session sending one packet per frame per peer is roughly 52 a second, which
 * would spend the entire month's allowance in about ten hours of play.
 *
 * Batching to one message every three frames costs almost nothing, because
 * every input packet already repeats the last sixteen frames and rollback
 * absorbs the later arrival by predicting -- and it takes the same allowance to
 * something like thirty hours. Nothing is dropped: a message carries every
 * packet queued since the last one, so a command still gets through.
 *
 * ## Except when it costs a great deal
 *
 * "Almost nothing" is true of the pairs the window fits. A peer stalls once the
 * other's input is delayed by more than the rollback window, and for a relayed
 * pair that delay is this wait PLUS a server hop each way -- so 230 ms of a
 * 539 ms window is spent before a packet has left the browser, and two people
 * far enough apart spend the evening watching each other freeze.
 *
 * `hurry` is the dial, and it is turned by the page rather than set here,
 * because the page is what can see a pair stalling and what pays for the
 * messages. A hurried session sends about twice as many -- the honest price --
 * and only the sessions that were stalling pay it. Nobody's ordinary evening
 * costs more than it did.
 *
 * Verify the quota against current pricing before relying on those numbers.
 */
import { Transport } from "@engine/net/transport.js";
import { encode } from "./pairchannel.js";

/**
 * The three things this needs from a channel, and nothing else.
 *
 * Named rather than taking a `PairChannel`, because a watcher rides the same
 * transport over a different topic -- and asking for the whole pair channel
 * would have meant handing a spectator an object that also carries the two
 * players' presence and invitations.
 */
export interface ByteChannel {
  onBytes(fn: (d: Uint8Array) => void): () => void;
  sendBytes(packets: string[]): void;
  onStatus(fn: (status: string) => void): () => void;
}

/**
 * How long packets may wait before going out, in milliseconds.
 *
 * Six frames at 26 Hz, and the single biggest lever on what a relayed pair
 * costs: doubling it halves the message rate, which is what decides how many
 * games this project can host at once. Fifty games with one in seven relaying
 * is about 260 messages a second at 115 ms and about 130 at 230.
 *
 * It is bounded, and not by taste. A peer stalls once the other's input is
 * delayed by more than the rollback window can reach back through, and that
 * delay is this number plus one-way latency. The window is
 * `maxRollback * 38.5 ms`, so at the netcode's old window of ten frames --
 * 385 ms -- this value would have started stalling pairs at 310 ms round trip,
 * which for a relayed pair paying a server hop each way is an ordinary evening
 * rather than a bad one. The window went to fourteen frames in the same change
 * for exactly that reason; see `maxRollback` in the session.
 *
 * Do NOT make sends change-triggered instead. Lockstep needs the peer's input
 * for every frame or `ready` stalls, so packets have to flow whether or not
 * anybody moved. This is the only lever here, and it moves with the window.
 */
const SLOW_MS = 230;
/**
 * The same lever, for a pair the slow one is failing.
 *
 * Three frames rather than six. It gives back 115 ms of a 539 ms window, which
 * is the difference between stalling at a 310 ms round trip and stalling at a
 * 540 ms one -- and 540 ms is further than two people in one country are from
 * each other, relay hop included. It is deliberately not lower than this: the
 * next halving buys 57 ms for another doubling of the bill, and `WatchMirror`
 * settled on the same 115 ms for the same reason.
 */
const FAST_MS = 115;

export class RealtimeTransport implements Transport {
  private queue: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private off: (() => void) | null = null;
  private offStatus: (() => void) | null = null;
  private closed = false;
  private gone = false;

  /** Messages actually put on the wire, so the cost is observable. */
  sent = 0;

  /** How long a queued packet may wait. See `hurry`. */
  private flushMs = SLOW_MS;

  constructor(private readonly pair: ByteChannel) {}

  /**
   * Spend more messages to stop stalling, or stop spending them.
   *
   * A timer already running keeps the deadline it was given: it is at most one
   * interval away and rescheduling it would delay the very packets this exists
   * to hurry. Everything queued after this call uses the new one.
   */
  hurry(on: boolean): void {
    this.flushMs = on ? FAST_MS : SLOW_MS;
  }

  /** What a queued packet is currently waiting, in ms. Read by the readout. */
  get waitMs(): number { return this.flushMs; }

  /**
   * The same number, under the name the session asks for it by.
   *
   * This is most of a relayed pair's delay budget and nothing above the
   * transport used to know it existed: the session reasoned about round trips
   * and the page reasoned about stalls, while 230 ms of a 538 ms window was
   * being spent in a queue neither could see.
   */
  get pacingMs(): number { return this.flushMs; }

  /**
   * Realtime gives no round-trip figure, and measuring one would mean sending
   * pings that cost messages for a number nothing depends on. The session's
   * prediction window is fixed, and the UI can say "relay" without a millisecond
   * count it would have had to pay for.
   */
  readonly rttMs = null;

  private lastSent = 0;

  /**
   * Leading edge, then batched.
   *
   * The first packet after a quiet moment goes out at once and only the stream
   * behind it waits. That matters because this same transport carries the SDP
   * and ICE of the peer-connection handshake: a few messages, each one blocking
   * the next, where a flat delay would put 115 ms into every step of a
   * negotiation the pair is sitting and waiting on.
   */
  send(data: Uint8Array): void {
    if (this.closed) return;
    // Commands and negotiation unblock the next action. They must not wait for input batching.
    if (data[0] !== 1 || data.length < 18) {
      this.flush();
      this.pair.sendBytes([encode(data)]);
      this.sent++;
      return;
    }
    // An input packet carries a window of history ending at `frame`, so two
    // packets queued for the SAME frame, slot and epoch say the same thing
    // twice and only the newer one is worth sending. That is the whole rule:
    // strictly the same frame, never an overlap.
    //
    // Dropping packets whose window a later one merely covers would save more,
    // and is deliberately not done here -- it is a change to what goes on the
    // wire, and the netcode matrix is what would have to say it is safe.
    const previous = this.lastInput;
    const frame = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(2);
    if (previous && data[1] === previous.slot && data[14] === previous.epoch && frame === previous.frame) {
      this.queue.pop();
    }
    this.queue.push(encode(data));
    this.lastInput = { frame, slot: data[1], epoch: data[14] };
    if (this.queue.length >= 32) { this.flush(); return; }

    const since = Date.now() - this.lastSent;
    if (since >= this.flushMs) { this.flush(); return; }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs - since);
  }
  private lastInput: { frame: number; slot: number; epoch: number } | null = null;

  private flush(): void {
    if (this.closed || this.queue.length === 0) return;
    const packets = this.queue;
    this.queue = [];
    this.lastInput = null;
    this.sent++;
    this.lastSent = Date.now();
    this.pair.sendBytes(packets);
  }

  onMessage(fn: (data: Uint8Array) => void): void {
    this.off?.();
    this.off = this.pair.onBytes(fn);
  }

  /**
   * The channel's own status, for a pair whose game is riding on it.
   *
   * A relayed session has no peer connection to lose, so the only way this link
   * dies is the websocket underneath it -- which the Supabase client will try
   * to bring back on its own. Saying so anyway is right: the page can tell
   * somebody why their game stopped, and a reconnect that succeeds clears the
   * message it put up.
   */
  onClosed(fn: (why: string) => void): void {
    this.offStatus?.();
    this.offStatus = this.pair.onStatus((status) => {
      if (this.closed || this.gone) return;
      if (status === "SUBSCRIBED") return;
      this.gone = true;
      fn("the channel went " + status.toLowerCase());
    });
  }

  close(): void {
    // Flushed FIRST. Whatever is still queued is the last thing this session
    // had to say, and the one message that is reliably in there is the Quit
    // that tells the other person their partner has gone -- dropping it on the
    // floor turns leaving into a peer who simply stops responding forever.
    this.flush();
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
    this.offStatus?.();
    this.offStatus = null;
    // The channel itself is NOT closed here. It outlives any one game: it is
    // also the pair's presence and their invitations, and hanging up on those
    // because a level ended would take the pair offline to each other.
  }
}
