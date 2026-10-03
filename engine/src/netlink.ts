/**
 * A two-ended network on a virtual clock.
 *
 * Latency, jitter and loss are injected, and time only moves when a test says
 * so, which is what makes a five-thousand-frame session over a terrible
 * connection take a second and come out the same every run. The randomness is
 * the engine's own `Rng`, so a given seed always drops exactly the same
 * packets.
 *
 * Shared because three different tests need it and three copies of a network
 * simulator is three places for the simulation to differ.
 */
import { Transport } from "./net/transport.js";
import { NetSession, Slot } from "./net/session.js";
import { LevelHost } from "./net/levelhost.js";
import { Rng } from "./net/rng.js";

export class Link {
  private queue: { at: number; to: 0 | 1; data: Uint8Array }[] = [];
  private handlers: [((d: Uint8Array) => void)?, ((d: Uint8Array) => void)?] = [];
  private now = 0;
  private rng: Rng;
  /**
   * How long a packet may wait at the sender before it goes, in ms.
   *
   * The relay batches, and until this existed the matrix measured network
   * latency alone -- so a pair modelled as healthy at 300 ms round trip was in
   * fact spending another 230 ms in a queue the test could not see. Batching
   * is where most of a relayed pair's delay budget actually goes, so it is
   * modelled here rather than reasoned about.
   */
  batchMs = 0;
  /** When each side's current batch will be released. */
  private batchDue: [number, number] = [0, 0];
  /** The virtual clock, for a session that wants to measure a round trip. */
  get nowMs(): number { return this.now; }
  /** Packets handed over, and of those, thrown away. */
  sent = 0;
  dropped = 0;
  /** Set to drop every packet of a kind, for tests about redundancy. */
  blackhole: ((data: Uint8Array) => boolean) | null = null;
  /** Set to damage packets in flight, for tests about the decoder. */
  damage: ((data: Uint8Array) => Uint8Array | null) | null = null;
  /** Deliver everything twice, for tests about idempotence. */
  duplicate = false;

  constructor(readonly latencyMs: number, readonly jitterMs: number,
              readonly loss: number, seed = 1) {
    this.rng = new Rng(seed);
  }

  endpoint(side: 0 | 1): Transport {
    const other = (side === 0 ? 1 : 0) as 0 | 1;
    const link = this;
    return {
      get rttMs() { return link.latencyMs * 2; },
      get pacingMs() { return link.batchMs; },
      send(data: Uint8Array) {
        link.sent++;
        if (link.blackhole?.(data)) { link.dropped++; return; }
        if (link.rng.next() < link.loss) { link.dropped++; return; }
        let payload: Uint8Array | null = data.slice();
        if (link.damage) payload = link.damage(payload);
        if (!payload) { link.dropped++; return; }
        // Leading edge, then batched -- the same rule `RealtimeTransport` uses,
        // so the first packet after a quiet moment is not delayed and only the
        // stream behind it waits.
        let held = 0;
        if (link.batchMs > 0) {
          if (link.now >= link.batchDue[side]) {
            link.batchDue[side] = link.now + link.batchMs;
          } else {
            held = link.batchDue[side] - link.now;
          }
        }
        const copies = link.duplicate ? 2 : 1;
        for (let i = 0; i < copies; i++) {
          const jitter = (link.rng.next() * 2 - 1) * link.jitterMs;
          link.queue.push({
            at: link.now + held + Math.max(0, link.latencyMs + jitter),
            to: other,
            data: payload.slice(),
          });
        }
      },
      onMessage(fn) { link.handlers[side] = fn; },
      close() {},
    };
  }

  advance(ms: number): void {
    this.now += ms;
    const due = this.queue.filter((p) => p.at <= this.now);
    this.queue = this.queue.filter((p) => p.at > this.now);
    // Deliver by arrival deadline, not insertion order. A coarse advance can
    // make several differently delayed packets due at once; insertion order
    // accidentally erased that reordering from the old test harness.
    due.sort((a, b) => a.at - b.at);
    for (const p of due) this.handlers[p.to]?.(p.data);
  }
}

export interface Peer { session: NetSession; host: LevelHost; }

export const STEP = 1 / 26;
export const STEP_MS = STEP * 1000;

export function pair(link: Link, o: {
  rollback?: boolean; delay?: number;
  timeSync?: boolean; adaptiveDelay?: boolean;
  onDesync?: (slot: Slot) => void;
} = {}): [Peer, Peer] {
  const make = (slot: Slot): Peer => {
    const host = new LevelHost();
    const session = new NetSession({
      slot, host, transport: link.endpoint(slot),
      rollback: o.rollback ?? false,
      delay: o.delay,
      timeSync: o.timeSync,
      adaptiveDelay: o.adaptiveDelay,
      // The link's clock, not the wall clock. A test advances time in fixed
      // steps and never sleeps, so a session reading `performance.now` would
      // measure how fast the test ran rather than the link it is modelling.
      now: () => link.nowMs,
      // The work budget too: on the wall clock, how much catch-up fits in a
      // tick depended on the machine running the test, and results with it.
      workNow: () => link.nowMs,
      onDesync: () => o.onDesync?.(slot),
    });
    return { session, host };
  };
  return [make(0), make(1)];
}

export function start(link: Link, peers: [Peer, Peer],
                      mode = "adventure", num = 1): void {
  peers[0].session.requestStart(mode, num);
  link.advance(STEP_MS);
}

/**
 * Drive both peers for a while.
 *
 * `clocks` is what makes drift expressible at all. Until it existed both peers
 * were ticked with an identical `STEP` on every iteration, so two machines
 * running at different speeds -- a slower laptop, a 144 Hz display, a tab the
 * browser throttled, a peer that stalled and discarded the time it owed -- were
 * not merely untested but impossible to write a test for. Every one of the
 * matrix's cells passed because the one thing that goes wrong in the field
 * could not happen in the harness.
 *
 * `hitch` is the other half: a peer that simply stops for a while, which is
 * what a backgrounded tab or a long garbage collection looks like from the
 * other end.
 */
export function run(link: Link, peers: [Peer, Peer], frames: number,
                    input: (slot: Slot, frame: number) => number,
                    from = 0,
                    o: {
                      clocks?: [number, number];
                      hitch?: (slot: Slot, i: number) => boolean;
                    } = {}): void {
  const clocks = o.clocks ?? [1, 1];
  for (let i = 0; i < frames; i++) {
    for (const s of [0, 1] as Slot[]) {
      peers[s].session.setLocalInput(input(s, from + i));
    }
    link.advance(STEP_MS);
    for (const s of [0, 1] as Slot[]) {
      if (o.hitch?.(s, i)) continue;
      peers[s].session.tick(STEP * clocks[s]);
    }
  }
}

/**
 * Let the two peers catch up with each other.
 *
 * At any instant a rollback peer's newest frame or two are PREDICTIONS, so two
 * peers compared mid-flight legitimately disagree -- that is the mechanism
 * working. A few frames of unchanging input, which every guess gets right, then
 * everything on the wire delivered and a settle with no time on the clock,
 * which corrects without simulating anything new.
 */
export function converge(link: Link, peers: [Peer, Peer]): void {
  run(link, peers, 12, () => 0);
  // A peer that stalled -- waiting on input a lossy link ate -- is BEHIND, and
  // catching up means running frames, which needs time on the clock. An earlier
  // version delivered everything and then settled with `tick(0)`, which gave
  // the laggard nothing to catch up with: at 20% loss the two ended three
  // frames apart and the comparison was meaningless. They had not diverged;
  // one of them had simply not got there yet.
  // The laggard, and the leader only when the laggard is stuck.
  //
  // Three versions of this were wrong before this one. Ticking only the peer
  // that is behind deadlocks whenever it is waiting on input that was lost: the
  // peer holding that input re-sends as it runs, and it is not running. Ticking
  // both never converges, because they advance together and stay the same
  // distance apart. Ticking the leader on a fixed cadence has the same problem
  // in miniature -- at a gap of one frame the two take turns and oscillate
  // forever.
  //
  // So the leader is only nudged when the laggard has failed to move, which is
  // exactly the situation where a resend is what it is waiting for.
  for (let i = 0; i < 400; i++) {
    const [a, b] = [peers[0].session.frame, peers[1].session.frame];
    if (a === b) break;
    const behind = a < b ? 0 : 1;
    const was = peers[behind].session.frame;
    link.advance(STEP_MS);
    peers[behind].session.tick(STEP);
    if (peers[behind].session.frame === was) {
      peers[behind === 0 ? 1 : 0].session.tick(STEP);
    }
  }
  link.advance(2000);
  peers[0].session.tick(0);
  peers[1].session.tick(0);
}

/** Re-simulate an input log from scratch, with no netcode anywhere near it. */
export function replay(mode: string, num: number, log: number[]): LevelHost {
  const host = new LevelHost();
  host.start(mode, num);
  for (let f = 0; f < log.length; f++) host.step(log[f] ?? 0, f, false);
  return host;
}

// ---- input patterns -------------------------------------------------------

/** Keys held for a while at a time, which is what people actually do. */
export function held(slot: Slot, frame: number): number {
  const t = frame + slot * 37;
  return ((t >> 3) & 1 ? 2 : 0) | ((t >> 5) & 1 ? 1 : 0) | ((t % 41) === 0 ? 4 : 0);
}

/** Flipping every other frame: the worst case for "they are still holding it". */
export function twitchy(slot: Slot, frame: number): number {
  const t = frame + slot * 37;
  return ((t >> 1) & 1 ? 2 : 0) | ((t >> 2) & 1 ? 1 : 0) | ((t % 17) === 0 ? 4 : 0);
}

/** Deterministic noise, from the engine's own generator so it is reproducible. */
export function noisy(slot: Slot, frame: number): number {
  let x = (frame * 2654435761 + slot * 40503) >>> 0;
  x ^= x >>> 13; x = (x * 1274126177) >>> 0; x ^= x >>> 16;
  return x & 7;
}

/** Everything down, forever. Nothing to predict wrong, and a lot of contact. */
export function mashing(): number { return 7; }
