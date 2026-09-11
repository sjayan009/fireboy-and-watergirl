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
 *  * **Sometimes**, as the game transport itself when direct connection fails.
 *    This removes the TURN dependency. A full input packet is 65 bytes; two
 *    players normally send 52 packets/s before batching and JSON/base64.
 *
 * ## Why sends are batched
 *
 * The free tier allows about two million Realtime messages a month. A relayed
 * session sending one packet per frame per peer is roughly 52 publishes/s.
 * Supabase meters BOTH publishes and deliveries: at one recipient this spends
 * two million messages in about 5.34 pair-hours, before other Realtime uses.
 *
 * The default 230ms batch has a theoretical pair rate of 8.70 publishes/s
 * (17.39 metered messages/s with one recipient), or about 31.94 pair-hours per
 * 2M-message allowance. The 115ms hurried mode halves that capacity. Commands,
 * signalling, spectators, social traffic and framing need additional budget.
 *
 * ## Except when it costs a great deal
 *
 * A peer stalls once the other's input is delayed by more than the rollback
 * window, and for a relayed
 * pair that delay is this wait PLUS a server hop each way -- so 230 ms of a
 * 1154 ms window is spent before a packet has left the browser, and two people
 * far enough apart spend the evening watching each other freeze.
 *
 * `hurry` is the dial, and it is turned by the page rather than set here,
 * because the page is what can see a pair stalling and what pays for the
 * messages. A hurried session consumes about twice as much message quota;
 * it is not a different billing plan. On Free, exceeding limits stops service.
 *
 * Verify the quota against current pricing before relying on those numbers.
 */
import { Transport, transportStats } from "@engine/net/transport.js";
import { encode } from "./base64.js";

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
 * A peer stalls once delayed input exceeds the rollback window. The current
 * default is 30 frames, about 1154ms; queue time, network latency, jitter and
 * a burst of loss all consume that window. The network benchmark measures
 * these together rather than treating a regional RTT as a queue-inclusive RTT.
 *
 * Do NOT make sends change-triggered instead. Lockstep needs the peer's input
 * for every frame or `ready` stalls, so packets have to flow whether or not
 * anybody moved. This is the only lever here, and it moves with the window.
 */
const SLOW_MS = 230;
/**
 * The same lever, for a pair the slow one is failing.
 *
 * Three frames rather than six. It returns 115ms of queue budget at roughly
 * twice the message consumption. The 600ms RTT + jitter/loss benchmark shows
 * why the existing explicit choice is useful; making it universal would halve
 * the finite Free relay capacity.
 */
const FAST_MS = 115;

export class RealtimeTransport implements Transport {
  readonly stats = transportStats();
  private queue: string[] = [];
  private queuedAt: number[] = [];
  private queuedBytes: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private off: (() => void) | null = null;
  private offStatus: (() => void) | null = null;
  private closed = false;
  private gone = false;

  /** Batch dispatches; PairChannel may hold/retry these during reconnection. */
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
   * The transport itself adds no paid-quota ping messages. NetSession estimates
   * RTT/jitter from timing trailers already attached to normal input packets.
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
      this.stats.sentPackets++;
      this.stats.sentBytes += data.byteLength;
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
      this.queuedAt.pop();
      this.stats.bufferedBytes -= this.queuedBytes.pop()!;
    }
    this.queue.push(encode(data));
    this.queuedAt.push(performance.now());
    this.queuedBytes.push(data.byteLength);
    this.stats.bufferedBytes += data.byteLength;
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
    const now = performance.now();
    for (let i = 0; i < this.queuedAt.length; i++) {
      const wait = Math.max(0, now - this.queuedAt[i]);
      this.stats.queueSamples++;
      this.stats.queueTotalMs += wait;
      this.stats.queueMaxMs = Math.max(this.stats.queueMaxMs, wait);
      this.stats.sentPackets++;
      this.stats.sentBytes += this.queuedBytes[i];
    }
    this.queue = [];
    this.queuedAt = [];
    this.queuedBytes = [];
    this.stats.bufferedBytes = 0;
    this.lastInput = null;
    this.sent++;
    this.lastSent = Date.now();
    this.pair.sendBytes(packets);
  }

  onMessage(fn: (data: Uint8Array) => void): void {
    this.off?.();
    this.off = this.pair.onBytes(data => {
      this.stats.receivedPackets++;
      this.stats.receivedBytes += data.byteLength;
      fn(data);
    });
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
