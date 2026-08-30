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
 * Verify the quota against current pricing before relying on those numbers.
 */
import { Transport } from "@engine/net/transport.js";
import { PairChannel, encode } from "./pairchannel.js";

/**
 * How long packets may wait before going out, in milliseconds.
 *
 * Three frames at 26 Hz. Larger would save more messages and cost more
 * prediction; smaller spends the month's allowance faster for latency the
 * rollback session was going to hide anyway.
 */
const FLUSH_MS = 115;

export class RealtimeTransport implements Transport {
  private queue: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private off: (() => void) | null = null;
  private closed = false;

  /** Messages actually put on the wire, so the cost is observable. */
  sent = 0;

  constructor(private readonly pair: PairChannel) {}

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
    this.queue.push(encode(data));

    const since = Date.now() - this.lastSent;
    if (since >= FLUSH_MS) { this.flush(); return; }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_MS - since);
  }

  private flush(): void {
    if (this.closed || this.queue.length === 0) return;
    const packets = this.queue;
    this.queue = [];
    this.sent++;
    this.lastSent = Date.now();
    this.pair.sendBytes(packets);
  }

  onMessage(fn: (data: Uint8Array) => void): void {
    this.off?.();
    this.off = this.pair.onBytes(fn);
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
    // The channel itself is NOT closed here. It outlives any one game: it is
    // also the pair's presence and their invitations, and hanging up on those
    // because a level ended would take the pair offline to each other.
  }
}
