/** Emergency gameplay and signaling over the existing private pair channel.
 * NetSession still generates 26 Hz inputs. Changed bits and boundaries publish
 * immediately; unchanged inputs publish the newest redundant history at 115 ms.
 * legacyBatching retains the original 230/115 ms queue for rollout rollback.
 */
import { Transport, transportStats } from "@engine/net/transport.js";
import { decode, type InputPacket } from "@engine/net/protocol.js";
import { encode } from "./base64.js";

/**
 * The three things this needs from a channel, and nothing else.
 *
 * Named rather than taking a `PairChannel`, because a watcher rides the same
 * transport over a different topic -- and asking for the whole pair channel
 * would have meant handing a spectator an object that also carries the two
 * players' presence and invitations.
 */
export type ByteLane = "gameplay" | "signaling" | "control";
export interface ByteChannel {
  onBytes(fn: (d: Uint8Array) => void): () => void;
  /** Local buffering metadata; scoping carries the corresponding on-wire lane. */
  sendBytes(packets: string[], lane?: ByteLane): void;
  onStatus(fn: (status: string) => void): () => void;
}

const SLOW_MS = 230;
const FAST_MS = 115;

export class RealtimeTransport implements Transport {
  readonly kind = "relay" as const;
  readonly activePath = "relay" as const;
  readonly stats = { ...transportStats(), queueRecentMs: [] as number[] };
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

  constructor(private readonly pair: ByteChannel, private readonly options: {
    /** Temporary rollout rollback switch: original 230/115 ms batching. */
    legacyBatching?: boolean;
    /** Monotonic sample clock; tests supply a virtual timestamp. */
    now?: () => number;
  } = {}) {}

  private now(): number { return this.options.now?.() ?? performance.now(); }

  /**
   * Spend more messages to stop stalling, or stop spending them.
   *
   * A timer already running keeps the deadline it was given: it is at most one
   * interval away and rescheduling it would delay the very packets this exists
   * to hurry. Everything queued after this call uses the new one.
   */
  hurry(on: boolean): void {
    this.flushMs = this.options.legacyBatching && !on ? SLOW_MS : FAST_MS;
  }

  /** What a queued packet is currently waiting, in ms. Read by the readout. */
  get waitMs(): number { return this.options.legacyBatching ? this.flushMs : FAST_MS; }

  /**
   * The same number, under the name the session asks for it by.
   *
   * This is most of a relayed pair's delay budget and nothing above the
   * transport used to know it existed: the session reasoned about round trips
   * and the page reasoned about stalls, while 230 ms of a 538 ms window was
   * being spent in a queue neither could see.
   */
  get pacingMs(): number { return this.waitMs; }

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
    const input = decode(data);
    // Commands and negotiation unblock the next action. They must not wait for input batching.
    if (!input || input.kind !== 1 || input.bits.length === 0) {
      this.flush();
      this.pair.sendBytes([encode(data)]);
      this.sent++;
      this.stats.sentPackets++;
      this.stats.sentBytes += data.byteLength;
      return;
    }
    if (!this.options.legacyBatching) { this.sendEdge(data, input); return; }
    // An input packet carries a window of history ending at `frame`, so two
    // packets queued for the SAME frame, slot and epoch say the same thing
    // twice and only the newer one is worth sending. That is the whole rule:
    // strictly the same frame, never an overlap.
    //
    // Dropping packets whose window a later one merely covers would save more,
    // and is deliberately not done here -- it is a change to what goes on the
    // wire, and the netcode matrix is what would have to say it is safe.
    const previous = this.lastInput;
    const frame = input.frame;
    if (previous && input.slot === previous.slot && input.epoch === previous.epoch && frame === previous.frame) {
      this.queue.pop();
      this.queuedAt.pop();
      this.stats.bufferedBytes -= this.queuedBytes.pop()!;
    }
    this.queue.push(encode(data));
    this.queuedAt.push(this.now());
    this.queuedBytes.push(data.byteLength);
    this.stats.bufferedBytes += data.byteLength;
    this.lastInput = { frame, slot: input.slot, epoch: input.epoch };
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

  private observed: InputPacket | null = null;

  /** Per-frame logical inputs still come from NetSession. Only publication is
   * coalesced: the newest packet carries the skipped frames in its history. */
  private sendEdge(data: Uint8Array, input: InputPacket): void {
    const previous = this.observed;
    const boundary = !previous || input.slot !== previous.slot || input.epoch !== previous.epoch ||
      input.frame < previous.frame;
    const edge = boundary || input.bits[0] !== previous.bits[0];
    // Never discard a packet outside the replacement's redundant history.
    const covers = previous && !boundary && input.frame >= previous.frame &&
      input.frame - previous.frame < input.bits.length;
    if (covers) this.discardPending();
    else this.flush();
    this.observed = input;
    this.queue.push(encode(data));
    this.queuedAt.push(this.now());
    this.queuedBytes.push(data.byteLength);
    this.stats.bufferedBytes += data.byteLength;
    const since = Date.now() - this.lastSent;
    if (edge || since >= FAST_MS) { this.flush(); return; }
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, FAST_MS - since);
  }

  /** Promotion stops pending emergency gameplay while retaining its receiver. */
  discardPending(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queue = []; this.queuedAt = []; this.queuedBytes = [];
    this.stats.bufferedBytes = 0;
    this.lastInput = null;
  }

  private flush(): void {
    // Keep the original timer semantics verbatim behind the rollback switch.
    if (!this.options.legacyBatching) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.closed || this.queue.length === 0) return;
    const packets = this.queue;
    const now = this.now();
    for (let i = 0; i < this.queuedAt.length; i++) {
      const wait = Math.max(0, now - this.queuedAt[i]);
      this.stats.queueSamples++;
      this.stats.queueTotalMs += wait;
      this.stats.queueMaxMs = Math.max(this.stats.queueMaxMs, wait);
      const samples = this.stats.queueRecentMs ??= [];
      samples.push(wait);
      if (samples.length > 512) samples.shift();
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
