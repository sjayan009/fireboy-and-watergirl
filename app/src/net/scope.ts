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
export function boundedTransport(inner: Transport): Transport {
  let window = Date.now(), messages = 0, bytes = 0;
  let ended = false;
  let lost: ((why: string) => void) | undefined;
  return {
    get rttMs() { return inner.rttMs; },
    get sent() { return inner.sent; },
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
