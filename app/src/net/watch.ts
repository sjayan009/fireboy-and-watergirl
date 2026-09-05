/**
 * A copy of the game, for people who are only looking.
 *
 * Determinism is what makes spectating nearly free: the simulation is a pure
 * function of `(mode, level, input log)`, so a watcher fed the two players'
 * input reaches the same world without either of them computing anything for
 * it. All that is needed is a copy of what already crosses the link.
 *
 * ## Why it wraps the transport
 *
 * The pair may be on a direct peer connection, where their packets never touch
 * a server at all -- so there is nothing for a watcher to subscribe to unless
 * somebody puts it there. `WatchMirror` sits in front of whichever transport
 * the pair ended up with and copies both directions: what this peer sends, and
 * what it receives. One mirror therefore carries both players.
 *
 * Only the peer who sent the invitation mirrors. Two mirrors would double the
 * message count for packets a watcher already has -- received input only ever
 * fills gaps -- and Realtime messages are the budget that matters here.
 *
 * ## Why it batches
 *
 * The same reason `RealtimeTransport` batches, and the same numbers: a message
 * per packet is roughly 52 a second, which spends a month's allowance in about
 * ten hours. Every input packet already repeats the last sixteen frames, so a
 * watcher that hears from us every three frames has missed nothing.
 *
 * Nothing is published until the pair turns watching on. A game nobody has
 * asked to share costs exactly zero.
 */
import { Transport } from "@engine/net/transport.js";
import { encode } from "./pairchannel.js";
import { WatchChannel } from "./watchchannel.js";
import type { NetSession } from "@engine/net/session.js";
import { canonicalReplay } from "@engine/verified.js";

/** Three frames at 26 Hz, as the relay uses. */
const FLUSH_MS = 115;

export class WatchMirror implements Transport {
  private queue: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private on = false;
  private closed = false;
  private wantsCatchup = false;
  private lastCatchup = 0;
  catchUp(session: NetSession | null): void { if (session?.running) this.wantsCatchup = true; }
  confirmed(session: NetSession, frame: number): void {
    if (!this.wantsCatchup || !this.on || Date.now() - this.lastCatchup < 3000) return;
    const replay = session.replay(frame);
    if (!replay) return;
    this.wantsCatchup = false; this.lastCatchup = Date.now();
    this.room()?.snapshot(canonicalReplay(replay),session.generation);
  }

  /** Messages actually put on the wire, so the cost is observable. */
  sent = 0;

  /**
   * `room` is asked for rather than handed over, because the two arrive in the
   * wrong order. The transport has to be wrapped at the moment the session is
   * built -- there is no wrapping it afterwards -- and joining the watch topic
   * is a round trip that has not finished by then. Holding a getter instead of
   * a channel means the mirror exists from the first frame and simply publishes
   * nothing until there is somewhere to publish to.
   */
  constructor(private readonly inner: Transport,
              private readonly room: () => WatchChannel | null) {}

  /** Start or stop publishing. Off until the pair says otherwise. */
  setSharing(on: boolean): void {
    this.on = on;
    if (!on) {
      this.queue = [];
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get sharing(): boolean { return this.on; }

  // ---- the transport, unchanged in every way that matters ----------------

  get rttMs(): number | null { return this.inner.rttMs; }

  send(data: Uint8Array): void {
    this.inner.send(data);
    this.copy(data);
  }

  onMessage(fn: (data: Uint8Array) => void): void {
    this.inner.onMessage((d) => {
      // Copied before it is handed on, so a handler that throws cannot silently
      // stop the feed while the game carries on.
      this.copy(d);
      fn(d);
    });
  }

  onClosed(fn: (why: string) => void): void {
    this.inner.onClosed?.(fn);
  }

  close(): void {
    this.closed = true;
    this.setSharing(false);
    this.inner.close();
  }

  // ---- the copy ----------------------------------------------------------

  private copy(data: Uint8Array): void {
    if (!this.on || this.closed || !this.room()?.viewers) return;
    this.queue.push(encode(data));
    if (this.queue.length >= 64) { this.flush(); return; }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_MS);
  }

  private flush(): void {
    if (this.closed || !this.on || this.queue.length === 0) return;
    const packets = this.queue;
    this.queue = [];
    const room = this.room();
    if (!room) return;
    this.sent++;
    room.feed(packets);
  }
}
