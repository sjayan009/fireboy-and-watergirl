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
 *
 * Losing a PACKET and losing the LINK are different things, and the interface
 * has to be able to say which. Silence means "nothing arrived", and a session
 * treats that as the peer being slow, because for a lost packet it is. A link
 * that has actually gone never breaks that silence, so without `onClosed` a
 * dead connection and a laggy one are the same event forever -- which is what
 * the game did until this existed: a character that stopped moving, and no way
 * to tell a crash from a hiccup.
 */
export interface Transport {
  /** Fire and forget. May silently drop. */
  send(data: Uint8Array): void;
  /** Register the receiver. Called once, before the session starts. */
  onMessage(fn: (data: Uint8Array) => void): void;
  /**
   * Be told when the link is gone and nothing more will arrive.
   *
   * Optional: a BroadcastChannel between two tabs and a null transport have no
   * such state, and every netcode test drives a link that cannot fail. Fired at
   * most once, and never as a result of `close()` -- a caller that hung up
   * already knows.
   */
  onClosed?(fn: (why: string) => void): void;
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
