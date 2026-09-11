/**
 * Choosing a transport.
 *
 * Try a direct peer connection first; if it does not come up, keep using the
 * channel the two peers already found each other on. That fallback is the
 * reason this project needs no TURN server. Full input packets are 65 bytes,
 * normally 26 per second per player, before transport headers. Supabase relay
 * batching reduces message count but adds queue time and JSON/base64 overhead;
 * its finite Free quota is modelled in FREE_TIER_BUDGET.md.
 *
 * What they do not get is cam and mic, which need the direct connection. That
 * is the cost of the zero-dollar architecture; TURN is not a production
 * dependency. No provider is permitted to silently upgrade or bill overages.
 */
import { Transport } from "./transport.js";
import { connectWebRTC } from "./webrtc.js";

export type TransportKind = "webrtc" | "relay";

export interface Connection {
  transport: Transport;
  kind: TransportKind;
  /** Why the direct connection was not used, when it was not. */
  reason?: string;
}

/**
 * @param rendezvous the channel both peers are already on -- BroadcastChannel
 *   for two tabs, Supabase Realtime for two people. Used for signalling, and
 *   as the transport itself if the peer connection fails.
 * @param caller which peer offers. Slot 0, decided when they paired.
 */
export async function connect(
  rendezvous: Transport, caller: boolean,
  opts: {
    timeoutMs?: number; iceServers?: RTCIceServer[]; signal?: AbortSignal;
    /**
     * Do not try for a peer connection at all.
     *
     * Set when this pair already fell back once. Asking again costs the whole
     * timeout -- eight seconds during which `connectWebRTC` owns the
     * rendezvous's message handler, so the relay cannot carry the game either
     * -- to reach the answer it reached last time. A NAT that refuses does not
     * usually change its mind between one level and the next.
     *
     * BOTH peers must pass it or neither should. A one-sided skip is worse
     * than asking: this side would relay immediately while the other sat out
     * its timeout with the transport blocked. It travels on the invitation
     * precisely so there is nothing to agree.
     */
    relayOnly?: boolean;
  } = {},
): Promise<Connection> {
  if (opts.signal?.aborted) throw new Error("cancelled");
  if (opts.relayOnly) {
    return {
      transport: rendezvous, kind: "relay",
      reason: "the last link was a relay",
    };
  }
  if (typeof RTCPeerConnection === "undefined") {
    return { transport: rendezvous, kind: "relay", reason: "no WebRTC here" };
  }
  try {
    const transport = await connectWebRTC(rendezvous, caller, opts);
    // The rendezvous was only ever the introduction here: the game rides the
    // data channel from now on. Let go of it, or every connection a pair makes
    // leaves another subscriber on their channel reading signalling for a peer
    // connection that no longer exists -- which matters the moment reconnecting
    // exists, because that is when a pair makes more than one.
    //
    // After a pause, not at once. ICE trickles: the far side may still be
    // sending candidates for a second or two after the channel opens, and
    // hanging up on the introduction mid-sentence would drop them.
    setTimeout(() => rendezvous.close(), 5000);
    return { transport, kind: "webrtc" };
  } catch (e) {
    // Everything else here is a reason to fall back to the relay. Being
    // cancelled is not: somebody pressed Cancel, and quietly handing them a
    // working relay session instead is the opposite of what they asked for.
    if (opts.signal?.aborted) throw new Error("cancelled");
    return {
      transport: rendezvous,
      kind: "relay",
      reason: (e as Error).message,
    };
  }
}
