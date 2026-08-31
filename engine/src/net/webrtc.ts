/**
 * A direct peer connection, over an RTCDataChannel.
 *
 * The channel is deliberately **unreliable and unordered**. Retransmission is
 * the wrong tool here: every input packet already repeats the last 16 frames,
 * so a lost packet is repaired by the next one to arrive, whereas SCTP's
 * retransmission would hold newer input behind older input that no longer
 * matters. Head-of-line blocking is exactly what a lockstep session cannot
 * afford.
 *
 * Signalling runs over whatever channel the two peers already share -- the
 * BroadcastChannel for two tabs, Supabase Realtime for two people. That same
 * channel is also the fallback transport if this never connects, so a session
 * needs exactly one rendezvous and no dedicated signalling server.
 */
import { Transport } from "./transport.js";

/** Marks a signalling message on the shared channel, so it is never mistaken
 *  for a game packet. protocol.ts only ever emits 1 and 2. */
export const SIGNAL = 0xfd;

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

interface Signal {
  sdp?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit;
}

function encodeSignal(s: Signal): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(s));
  const out = new Uint8Array(body.length + 1);
  out[0] = SIGNAL;
  out.set(body, 1);
  return out;
}

function decodeSignal(d: Uint8Array): Signal | null {
  if (d.length < 2 || d[0] !== SIGNAL) return null;
  try {
    return JSON.parse(new TextDecoder().decode(d.subarray(1)));
  } catch {
    return null;
  }
}

class DataChannelTransport implements Transport {
  private handler: ((d: Uint8Array) => void) | null = null;
  private _rtt: number | null = null;

  private rttTimer: ReturnType<typeof setInterval> | null = null;
  private closedHandler: ((why: string) => void) | null = null;
  private gone = false;

  constructor(private pc: RTCPeerConnection, private dc: RTCDataChannel) {
    dc.binaryType = "arraybuffer";
    dc.onmessage = (e) => this.handler?.(new Uint8Array(e.data as ArrayBuffer));
    // WebRTC reports round trip time in its stats; the session uses it to size
    // the input delay rather than guessing.
    this.rttTimer = setInterval(() => void this.sampleRtt(), 2000);

    // The same signal `connectWebRTC` watches during the handshake, kept live
    // afterwards -- where it used to be set and then never consulted again,
    // because the promise it belonged to had already settled.
    //
    // `disconnected` is included deliberately, even though ICE sometimes
    // recovers from it on its own. A pair whose link comes back finds a page
    // that reconnects them anyway, and the cost of saying so early is a banner
    // that clears itself; the cost of waiting for `failed` is up to thirty
    // seconds of a game that has already stopped.
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "failed" || state === "disconnected" || state === "closed") {
        this.linkGone("the peer connection " + state);
      }
    };
    dc.onclose = () => this.linkGone("the data channel closed");
    dc.onerror = () => this.linkGone("the data channel failed");
  }

  private linkGone(why: string): void {
    if (this.gone) return;
    this.gone = true;
    this.closedHandler?.(why);
  }

  private async sampleRtt(): Promise<void> {
    try {
      const stats = await this.pc.getStats();
      stats.forEach((r: any) => {
        if (r.type === "candidate-pair" && r.state === "succeeded" &&
            typeof r.currentRoundTripTime === "number") {
          this._rtt = r.currentRoundTripTime * 1000;
        }
      });
    } catch { /* stats are a nicety, never a requirement */ }
  }

  get rttMs(): number | null { return this._rtt; }

  send(data: Uint8Array): void {
    if (this.dc.readyState !== "open") return;
    // Copy into a plain ArrayBuffer: the caller's view may be a slice of a
    // larger buffer, and RTCDataChannel.send would put the whole thing on the
    // wire.
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    try { this.dc.send(buf); } catch { /* closing; the peer will notice */ }
  }

  onMessage(fn: (d: Uint8Array) => void): void { this.handler = fn; }
  onClosed(fn: (why: string) => void): void { this.closedHandler = fn; }

  close(): void {
    // Hanging up is not losing the link. Whoever called this knows, and firing
    // at them would turn every deliberate departure into a lost connection.
    this.gone = true;
    // The stats poll has to be stopped by hand. It never mattered while a page
    // built one connection and kept it until reload; now a pair connects,
    // cancels, and connects again, and every abandoned attempt would otherwise
    // leave a timer asking a closed peer connection for statistics forever.
    if (this.rttTimer !== null) clearInterval(this.rttTimer);
    this.rttTimer = null;
    try { this.dc.close(); } catch { /* already gone */ }
    try { this.pc.close(); } catch { /* already gone */ }
  }
}

/**
 * Bring up a peer connection, using `sig` to exchange SDP and ICE.
 *
 * `caller` decides who offers. The lobby has already agreed which peer is
 * which, so there is no negotiation collision to resolve and none of the
 * perfect-negotiation machinery is needed.
 *
 * Rejects on timeout; the caller falls back to the signalling channel itself.
 * Rejects at once if `signal` aborts, so somebody who changes their mind
 * halfway through a handshake is not made to sit out the timeout first.
 */
export function connectWebRTC(
  sig: Transport, caller: boolean,
  opts: {
    timeoutMs?: number; iceServers?: RTCIceServer[]; signal?: AbortSignal;
  } = {},
): Promise<Transport> {
  const timeoutMs = opts.timeoutMs ?? 8000;

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const pc = new RTCPeerConnection({
      iceServers: opts.iceServers ?? DEFAULT_ICE,
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => finish(() => {
      pc.close();
      reject(new Error("no peer connection within " + timeoutMs + "ms"));
    }), timeoutMs);
    const onAbort = () => finish(() => {
      pc.close();
      reject(new Error("cancelled"));
    });
    opts.signal?.addEventListener("abort", onAbort);

    pc.onicecandidate = (e) => {
      if (e.candidate) sig.send(encodeSignal({ ice: e.candidate.toJSON() }));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        finish(() => { pc.close(); reject(new Error("peer connection failed")); });
      }
    };

    const ready = (dc: RTCDataChannel) => {
      if (dc.readyState === "open") {
        finish(() => resolve(new DataChannelTransport(pc, dc)));
      } else {
        dc.onopen = () => finish(() => resolve(new DataChannelTransport(pc, dc)));
      }
    };

    if (caller) {
      // Unreliable and unordered: see the note at the top of this file.
      const dc = pc.createDataChannel("input", {
        ordered: false, maxRetransmits: 0,
      });
      ready(dc);
      void (async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sig.send(encodeSignal({ sdp: pc.localDescription!.toJSON() }));
      })();
    } else {
      pc.ondatachannel = (e) => ready(e.channel);
    }

    // Candidates can arrive before the remote description is set; SCTP will
    // not have them until it is, so they wait here rather than being dropped.
    const pendingIce: RTCIceCandidateInit[] = [];
    const flush = async () => {
      while (pendingIce.length) {
        try { await pc.addIceCandidate(pendingIce.shift()!); } catch { /* stale */ }
      }
    };

    sig.onMessage((d) => {
      const s = decodeSignal(d);
      if (!s) return;
      void (async () => {
        if (s.sdp) {
          await pc.setRemoteDescription(s.sdp);
          if (s.sdp.type === "offer") {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sig.send(encodeSignal({ sdp: pc.localDescription!.toJSON() }));
          }
          await flush();
          return;
        }
        if (s.ice) {
          if (pc.remoteDescription) {
            try { await pc.addIceCandidate(s.ice); } catch { /* stale */ }
          } else {
            pendingIce.push(s.ice);
          }
        }
      })();
    });
  });
}
