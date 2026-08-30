/**
 * How two peers exchange bytes. Deliberately the smallest interface that can
 * carry a lockstep session, so the netcode never learns which one it is on.
 *
 * There will be three: a BroadcastChannel for two tabs on one machine, an
 * RTCDataChannel for a direct peer connection, and Supabase Realtime for the
 * pairs whose NAT refuses one. The session behaves identically on all three --
 * the only thing that changes is latency, which it measures rather than
 * assumes.
 *
 * A transport is allowed to lose, duplicate and reorder packets. Every input
 * packet carries a window of recent frames, so loss heals on the next packet
 * and neither this interface nor its implementations need retransmission,
 * ordering or acknowledgement.
 */
export interface Transport {
  /** Fire and forget. May silently drop. */
  send(data: Uint8Array): void;
  /** Register the receiver. Called once, before the session starts. */
  onMessage(fn: (data: Uint8Array) => void): void;
  /** Best-effort round-trip estimate in ms, or null while unknown. */
  readonly rttMs: number | null;
  close(): void;
}

/**
 * A transport that goes nowhere, for a solo session.
 *
 * Solo play runs through exactly the same session as netplay -- one code path
 * for stepping, input and commands -- so that a bug in the netcode shows up in
 * single-player testing too rather than waiting for two people to be online.
 */
export class NullTransport implements Transport {
  readonly rttMs = 0;
  send(): void {}
  onMessage(): void {}
  close(): void {}
}
