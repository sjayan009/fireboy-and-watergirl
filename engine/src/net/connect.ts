/**
 * Choosing a transport.
 *
 * Try a direct peer connection first; if it does not come up, keep using the
 * channel the two peers already found each other on. That fallback is the
 * reason this project needs no TURN server: a lockstep session is about ten
 * bytes a second, so relaying it through the rendezvous channel costs a hop of
 * latency and nothing else. The pairs whose NAT refuses a peer connection --
 * usually 10-20% -- still get to play.
 *
 * What they do not get is cam and mic, which need the direct connection. That
 * is the honest cost of not renting a relay, and adding TURN later fixes it
 * without touching anything above this file.
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
  } = {},
): Promise<Connection> {
  if (opts.signal?.aborted) throw new Error("cancelled");
  if (typeof RTCPeerConnection === "undefined") {
    return { transport: rendezvous, kind: "relay", reason: "no WebRTC here" };
  }
  try {
    const transport = await connectWebRTC(rendezvous, caller, opts);
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
