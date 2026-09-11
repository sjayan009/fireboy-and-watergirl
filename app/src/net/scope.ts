import type { Transport } from "@engine/net/transport.js";
import type { ByteChannel } from "./realtime.js";
import { encode, decode } from "./pairchannel.js";

/** Reject bytes from any previous connection attempt, including delayed SDP. */
export function scopedChannel(channel: ByteChannel, identity: string): ByteChannel {
  const prefix = new TextEncoder().encode(identity + ":");
  return {
    onStatus: fn => channel.onStatus(fn),
    onBytes: fn => channel.onBytes(data => {
      if (data.length <= prefix.length || !prefix.every((b,i) => b === data[i])) return;
      fn(data.slice(prefix.length));
    }),
    sendBytes(packets) {
      channel.sendBytes(packets.map(packet => {
        const bytes = decode(packet);
        const result = new Uint8Array(prefix.length + bytes.length);
        result.set(prefix); result.set(bytes,prefix.length);
        return encode(result);
      }));
    },
  };
}

/** A direct link already belongs to one attempt; cap work before decoding. */
export function boundedTransport(inner: Transport): Transport & { inner: Transport } {
  let window = Date.now(), messages = 0, bytes = 0;
  let ended = false;
  let lost: ((why: string) => void) | undefined;
  return {
    // The transport underneath, kept reachable rather than sealed in this
    // closure. `WatchMirror` already holds its inner one under this name, so
    // between the two the chain from `session.transport` down to the thing
    // actually on the network can be walked.
    //
    // It is walked. `twopeople` breaks the link to prove the pair rebuilds it,
    // and the only honest way to break a link is to break the real one. When
    // this wrapper was added it went on top of a test that reached straight for
    // the peer connection, and the test began failing on EVERY path -- not
    // because a peer connection was missing but because a plain object literal
    // was in the way. A wrapper that hides what it wraps makes that failure
    // look like a machine problem for as long as anybody is willing to believe
    // it.
    inner,
    get rttMs() { return inner.rttMs; },
    get sent() { return inner.sent; },
    get pacingMs() { return inner.pacingMs; },
    hurry: on => inner.hurry?.(on),
    send: data => { if (!ended) inner.send(data); },
    onClosed(fn) { lost = fn; inner.onClosed?.(fn); },
    onMessage(fn) {
      inner.onMessage(data => {
        if (ended) return;
        const now = Date.now();
        if (now - window > 1000) { window = now; messages = 0; bytes = 0; }
        messages++; bytes += data.byteLength;
        if (messages > 256 || bytes > 128 * 1024 || data.byteLength > 64 * 1024) {
          ended = true; inner.close(); lost?.("The connection exceeded its message budget"); return;
        }
        fn(data);
      });
    },
    close() { ended = true; inner.close(); },
  };
}
