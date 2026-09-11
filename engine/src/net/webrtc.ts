/**
 * A direct peer connection, over an RTCDataChannel.
 *
 * The channel is deliberately **unreliable and unordered**. Retransmission is
 * the wrong tool here: every input packet already repeats the last 32 frames,
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
import { Transport, transportStats } from "./transport.js";

/** Marks a signalling message on the shared channel, so it is never mistaken
 *  for a game packet. protocol.ts only ever emits 1 and 2. */
export const SIGNAL = 0xfd;

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

export interface Signal {
  sdp?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit;
}

export function encodeSignal(s: Signal): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(s));
  const out = new Uint8Array(body.length + 1);
  out[0] = SIGNAL;
  out.set(body, 1);
  return out;
}

/**
 * How many candidates may wait for a remote description.
 *
 * A real negotiation produces single figures. The queue had no bound and is
 * filled from the signalling channel, which for two people is the pair's own
 * Realtime topic -- so a peer who never sends an answer and keeps sending
 * candidates grew an array in the other browser for as long as it cared to.
 * Fifty is far above any honest handshake and far below anything that matters.
 */
const MAX_PENDING_ICE = 50;

/** The longest an SDP or a candidate may be. Real ones are a few kilobytes. */
const MAX_SIGNAL_CHARS = 64 * 1024;

/**
 * A signalling message, or null.
 *
 * The shape is checked rather than assumed. The message arrives from the peer
 * over a channel they are authorized to publish on, and `setRemoteDescription`
 * and `addIceCandidate` are the two places where what they say becomes an
 * argument to a browser API: a non-object, a missing `type`, or an SDP the size
 * of a video file all used to be handed straight over.
 */
export function decodeSignal(d: Uint8Array): Signal | null {
  if (d.length < 2 || d[0] !== SIGNAL) return null;
  if (d.length > MAX_SIGNAL_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(d.subarray(1)));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const s = parsed as Record<string, unknown>;

  if (s.sdp !== undefined) {
    const sdp = s.sdp as Record<string, unknown> | null;
    if (!sdp || typeof sdp !== "object") return null;
    const type = sdp.type;
    if (type !== "offer" && type !== "answer" && type !== "pranswer" &&
        type !== "rollback") {
      return null;
    }
    if (sdp.sdp !== undefined &&
        (typeof sdp.sdp !== "string" || sdp.sdp.length > MAX_SIGNAL_CHARS)) {
      return null;
    }
    return { sdp: { type, sdp: sdp.sdp as string | undefined } };
  }

  if (s.ice !== undefined) {
    const ice = s.ice as Record<string, unknown> | null;
    if (!ice || typeof ice !== "object") return null;
    if (typeof ice.candidate !== "string" ||
        ice.candidate.length > MAX_SIGNAL_CHARS) {
      return null;
    }
    return {
      ice: {
        candidate: ice.candidate,
        sdpMid: typeof ice.sdpMid === "string" ? ice.sdpMid : undefined,
        sdpMLineIndex: typeof ice.sdpMLineIndex === "number"
          ? ice.sdpMLineIndex : undefined,
        usernameFragment: typeof ice.usernameFragment === "string"
          ? ice.usernameFragment : undefined,
      },
    };
  }
  return null;
}

class DataChannelTransport implements Transport {
  readonly stats = transportStats();
  get sent(): number { return this.stats.sentPackets; }
  private handler: ((d: Uint8Array) => void) | null = null;
  private _rtt: number | null = null;

  private rttTimer: ReturnType<typeof setInterval> | null = null;
  private closedHandler: ((why: string) => void) | null = null;
  private gone = false;

  constructor(private pc: RTCPeerConnection, private dc: RTCDataChannel) {
    dc.binaryType = "arraybuffer";
    dc.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer) || e.data.byteLength > MAX_SIGNAL_CHARS) {
        this.stats.droppedPackets++; return;
      }
      this.stats.receivedPackets++;
      this.stats.receivedBytes += e.data.byteLength;
      this.handler?.(new Uint8Array(e.data));
    };
    // WebRTC reports round trip time in its stats; the session uses it to size
    // the input delay rather than guessing.
    this.rttTimer = setInterval(() => void this.sampleRtt(), 2000);

    // The same signal `connectWebRTC` watches during the handshake, kept live
    // afterwards -- where it used to be set and then never consulted again,
    // because the promise it belonged to had already settled.
    //
    // `failed` and `closed` only. `disconnected` is the state ICE passes
    // THROUGH and usually recovers from on its own -- two browser contexts on
    // one busy machine produce it regularly -- and treating it as the end of
    // the link tore down connections that were about to be fine, which is a
    // more disruptive bug than the one this was written to fix.
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "failed" || state === "closed") {
        this.linkGone("the peer connection " + state);
      }
    };
    dc.onclose = () => this.linkGone("the data channel closed");
    dc.onerror = () => this.linkGone("the data channel failed");
  }

  private linkGone(why: string): void {
    if (this.gone) return;
    this.gone = true;
    if (this.rttTimer !== null) clearInterval(this.rttTimer);
    this.rttTimer = null;
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
    this.stats.bufferedBytes = this.dc.bufferedAmount;
    if (this.dc.readyState !== "open") { this.stats.droppedPackets++; return; }
    // An owned plain ArrayBuffer supports all caller buffer types and preserves
    // the exact byte range of a subarray. The caller keeps its buffer.
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    try {
      this.dc.send(buf);
      this.stats.sentPackets++;
      this.stats.sentBytes += data.byteLength;
      this.stats.bufferedBytes = this.dc.bufferedAmount;
    } catch { this.stats.droppedPackets++; /* closing; the peer will notice */ }
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

    /**
     * Give up, with a reason, from inside an async task.
     *
     * Both negotiation tasks below are async and neither used to have a
     * terminal `catch`. An invalid offer, a browser that refuses
     * `createOffer`, an SDP the peer garbled: each became an unhandled promise
     * rejection in the console while the outer promise sat unresolved until its
     * eight-second timeout, so every negotiation failure was reported as
     * "no peer connection within 8000ms" whatever it actually was. That is the
     * difference between a diagnosable bug and a pair who "sometimes get the
     * relay".
     */
    const abandon = (why: string, e?: unknown) => finish(() => {
      pc.close();
      reject(new Error(e ? `${why}: ${(e as Error).message}` : why));
    });

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
      })().catch((e) => abandon("could not offer a peer connection", e));
    } else {
      pc.ondatachannel = (e) => ready(e.channel);
    }

    // Candidates can arrive before the remote description is set; SCTP will
    // not have them until it is, so they wait here rather than being dropped.
    //
    // Keyed, so the same candidate arriving twice -- which a peer repeating
    // itself across a reconnection does -- costs one entry rather than two.
    const pendingIce = new Map<string, RTCIceCandidateInit>();
    const flush = async () => {
      const waiting = [...pendingIce.values()];
      pendingIce.clear();
      for (const c of waiting) {
        try { await pc.addIceCandidate(c); } catch { /* stale */ }
      }
    };

    sig.onMessage((d) => {
      const s = decodeSignal(d);
      if (!s) return;
      // A handshake that is over must not keep answering. The rendezvous is the
      // pair's own channel and outlives any one connection, so when a link dies
      // and the two of them negotiate another, THIS handler is still subscribed
      // to it -- and hands the new offer to a peer connection that closed with
      // the old link. The browser's complaint is loud and unhandled: "the
      // RTCPeerConnection's signalingState is 'closed'".
      if (pc.signalingState === "closed") return;
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
          } else if (pendingIce.size < MAX_PENDING_ICE) {
            pendingIce.set(s.ice.candidate ?? String(pendingIce.size), s.ice);
          } else {
            // More candidates than any handshake produces, and still no remote
            // description. Whatever is on the other end is not negotiating.
            abandon("the peer sent candidates and never an answer");
          }
        }
      })().catch((e) => abandon("the peer connection handshake failed", e));
    });
  });
}
