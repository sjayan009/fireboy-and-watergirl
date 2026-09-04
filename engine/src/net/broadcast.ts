/**
 * A transport between two tabs of the same browser, over BroadcastChannel.
 *
 * This exists to develop and test netplay without any network, account or
 * signalling server in the way: open the page twice and the two tabs are
 * playing co-op. It is the same Transport the WebRTC and Supabase Realtime
 * implementations satisfy, so everything above it -- the whole of session.ts --
 * is exercised for real long before either of those exists.
 *
 * It also handles the one thing a real lobby will do differently: deciding who
 * drives Fireboy. Here the two tabs draw random numbers and the lower one takes
 * slot 0; online, the invite says so.
 */
import { Transport } from "./transport.js";
import { Slot } from "./session.js";

const HELLO = 0xfe;

export class BroadcastTransport implements Transport {
  readonly rttMs = 0;
  private ch: BroadcastChannel;
  private handler: ((d: Uint8Array) => void) | null = null;
  /** Not readonly: a collision is settled by drawing again. See `onHello`. */
  private id: number;

  constructor(name = "fbwg-netplay") {
    this.ch = new BroadcastChannel(name);
    this.id = Math.floor(Math.random() * 0xffffff);
    this.ch.onmessage = (e) => {
      const d = new Uint8Array(e.data as ArrayBuffer);
      if (d[0] === HELLO) { this.onHello(d); return; }
      this.handler?.(d);
    };
  }

  send(data: Uint8Array): void {
    // BroadcastChannel does not deliver to the sender, so there is no echo to
    // filter -- but session.ts drops its own slot anyway, so both are safe.
    this.ch.postMessage(data.buffer.slice(data.byteOffset,
                                          data.byteOffset + data.byteLength));
  }

  onMessage(fn: (d: Uint8Array) => void): void { this.handler = fn; }
  close(): void { this.ch.close(); }

  // ---- pairing ----------------------------------------------------------

  private peerId: number | null = null;
  private resolve: ((slot: Slot) => void) | null = null;

  /**
   * Wait for the other tab and agree who is who.
   *
   * Both sides announce a random id repeatedly until they have heard the
   * other's; the lower id takes slot 0. Repeating matters because whichever
   * tab opens first would otherwise shout into an empty channel.
   *
   * ## And when the two ids are the same
   *
   * `this.id < theirs` is false on both sides of a collision, so both tabs
   * assigned themselves slot 1 -- and the session drops incoming packets whose
   * slot equals its own, so the two tabs paired successfully and then never
   * exchanged a single input. One chance in 16,777,215 per pairing, and the
   * symptom is a complete protocol failure that reproduces on nothing.
   *
   * A tie is now answered rather than assumed away: draw again and say hello
   * again. Both sides do it, both draw independently, and the handshake settles
   * the moment two different numbers meet.
   */
  pair(timeoutMs = 30000): Promise<Slot> {
    return new Promise((resolve, reject) => {
      const hello = () => {
        const d = new Uint8Array(5);
        d[0] = HELLO;
        new DataView(d.buffer).setUint32(1, this.id);
        this.send(d);
      };
      this.sayHello = hello;
      hello();
      const beat = setInterval(hello, 250);
      const stop = setTimeout(() => {
        clearInterval(beat);
        reject(new Error("no second tab appeared"));
      }, timeoutMs);
      this.resolve = (slot) => {
        clearInterval(beat);
        clearTimeout(stop);
        hello();              // so the late tab hears us before we go quiet
        resolve(slot);
      };
    });
  }

  /** Set while pairing, so a collision can re-announce a fresh id. */
  private sayHello: (() => void) | null = null;

  private onHello(d: Uint8Array): void {
    const theirs = new DataView(d.buffer, d.byteOffset).getUint32(1);
    if (this.peerId !== null) return;
    if (theirs === this.id) {
      // A tie decides nothing, so nothing is decided: a new id, announced at
      // once. The peer is doing the same, and two fresh draws agreeing again is
      // the same one-in-sixteen-million on a handshake that now retries.
      this.id = Math.floor(Math.random() * 0xffffff);
      this.sayHello?.();
      return;
    }
    this.peerId = theirs;
    const slot: Slot = this.id < theirs ? 0 : 1;
    this.resolve?.(slot);
    this.resolve = null;
  }
}
