/**
 * Two peers whose clocks are not the same clock.
 *
 * Every other netcode test in this directory drives both sessions with an
 * identical `STEP` on every iteration, which quietly assumes the one thing
 * that is never true in the field: that two browsers on two machines advance
 * time together. They do not. One is a slower laptop, one has a 144 Hz display
 * and one has a 60 Hz, one gets throttled when its tab goes to the back, and --
 * the case that actually bit -- a peer that stalls DISCARDS the time it owed,
 * because `tick` clamps the backlog rather than fast-forwarding through it.
 *
 * Nothing reconciled that. The session computed how far ahead the peer was,
 * stored it in a field called `lead`, and no line of code ever read it. So the
 * two clocks wandered, and the stall gate -- `frame - confirmed < maxRollback`
 * -- meant the peer that wandered AHEAD was the one that hit the wall and sat
 * there saying "waiting for your friend", while the other side saw nothing
 * wrong at all.
 *
 * This file is the harness for that. It asserts three things:
 *
 *   * the two peers still agree on the input log, whatever their clocks did;
 *   * with time sync on, the gap between them stays bounded where it used to
 *     grow without limit;
 *   * and the correction never exceeds what a person could see.
 */
import { Link, STEP, STEP_MS, converge, pair, run, start, type Peer } from "./netlink.js";
import { Slot } from "./net/session.js";
import { Command } from "./net/protocol.js";

let failures = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` +
              (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

const held = (slot: Slot) => (slot === 0 ? 2 : 8);
/** Deterministic, and awkward on purpose: prediction is wrong often. */
function noisy(slot: Slot, frame: number): number {
  const n = (frame * 2654435761 + slot * 40503) >>> 0;
  return (n >>> 13) & 7;
}

function begin(link: Link, o: { timeSync?: boolean; adaptiveDelay?: boolean } = {}): [Peer, Peer] {
  const peers = pair(link, { rollback: true, ...o });
  start(link, peers);
  return peers;
}

/**
 * Back to the map, then into another level.
 *
 * `requestStart` refuses while a level is running -- the guard that stops a map
 * click mid-level starting a second one -- so a pair changing levels quits
 * first. This is also the only moment `chooseDelay` runs.
 */
function nextLevel(link: Link, peers: [Peer, Peer], num: number): void {
  peers[0].session.send(Command.Quit, 0);
  run(link, peers, 60, () => 0);
  peers[0].session.requestStart("adventure", num);
  link.advance(STEP_MS);
  run(link, peers, 30, () => 0);
}

/** How far apart the two peers' simulations are, in frames. */
const gap = (peers: [Peer, Peer]) =>
  Math.abs(peers[0].session.frame - peers[1].session.frame);

// ---------------------------------------------------------------------------

console.log("a link that batches is a link with more delay than its latency");
{
  // The relay holds packets before sending them, and until the harness could
  // model that, every figure about whether a relayed pair could play was
  // arithmetic rather than measurement.
  const plain = new Link(75, 0, 0, 5);
  const batched = new Link(75, 0, 0, 5);
  batched.batchMs = 230;
  const a = begin(plain);
  const b = begin(batched);
  run(plain, a, 300, noisy);
  run(batched, b, 300, noisy);
  // The claim is about the DELAY BUDGET, not about stalls: with the window at
  // thirty frames both of these pairs play perfectly well, which is the point
  // of having widened it. What matters is that the session can now see where
  // its budget is going, and most of a relayed pair's goes here.
  const extra = b[0].session.inputAgeMs - a[0].session.inputAgeMs;
  check("the batch shows up in the input age", extra > 100, true);
  console.log(`       age ${a[0].session.inputAgeMs.toFixed(0)} ms unbatched, ` +
              `${b[0].session.inputAgeMs.toFixed(0)} ms at 230 ms batching ` +
              `(+${extra.toFixed(0)} ms)`);
  converge(plain, a); converge(batched, b);
  check("and both pairs still agree on the world",
        [a[0].host.hash() === a[1].host.hash(),
         b[0].host.hash() === b[1].host.hash()], [true, true]);
}

console.log("\nclocks that differ by 5% do not split the input log");
{
  for (const ratio of [1.01, 1.05, 0.95]) {
    const link = new Link(75, 20, 0.02, 11);
    const peers = begin(link, { timeSync: true });
    run(link, peers, 600, noisy, 0, { clocks: [1, ratio] });
    converge(link, peers);
    const shared = Math.min(peers[0].session.frame, peers[1].session.frame);
    let split = -1;
    for (let f = 0; f < shared; f++) {
      if (peers[0].session.log[f] !== peers[1].session.log[f]) { split = f; break; }
    }
    check(`ratio ${ratio}: one log`, split, -1);
    check(`ratio ${ratio}: no desync`,
          peers[0].session.desyncs + peers[1].session.desyncs, 0);
  }
}

console.log("\ntime sync keeps the gap bounded where it used to grow");
{
  // The same 5% mismatch, with and without the regulator. Without it the fast
  // peer simply pulls away until the window stops it, and then stalls on every
  // frame for the rest of the level; with it, it gives the time back.
  const measure = (timeSync: boolean): { gap: number; stalls: number } => {
    const link = new Link(60, 10, 0, 23);
    link.batchMs = 115;
    const peers = begin(link, { timeSync });
    run(link, peers, 900, held, 0, { clocks: [1, 1.05] });
    return { gap: gap(peers), stalls: peers[1].session.stalls };
  };
  const off = measure(false);
  const on = measure(true);
  console.log(`       without: ${off.gap} frames apart, ${off.stalls} stalls`);
  console.log(`       with   : ${on.gap} frames apart, ${on.stalls} stalls`);
  check("the fast peer is pulled back", on.gap < off.gap, true);
  check("and it stops living on the edge of the window",
        on.stalls <= off.stalls, true);
}

console.log("\nthe correction stays under what anyone could see");
{
  // Five per cent is the cap, and it is the cap because it sits under every
  // measured threshold for noticing a speed change. A regulator that reached
  // for more would be trading a stall for something equally visible.
  const link = new Link(60, 10, 0, 29);
  const peers = begin(link, { timeSync: true });
  let worst = 1;
  for (let i = 0; i < 900; i++) {
    for (const s of [0, 1] as Slot[]) peers[s].session.setLocalInput(held(s));
    link.advance(STEP_MS);
    peers[0].session.tick(STEP);
    peers[1].session.tick(STEP * 1.08);
    worst = Math.min(worst, peers[0].session.dilation, peers[1].session.dilation);
  }
  check("never slower than 0.95", worst >= 0.95, true);
  check("and it did engage", worst < 1, true);
  console.log(`       deepest dilation ${worst.toFixed(4)}`);
}

console.log("\na peer that stops for a moment is caught up with, not lost");
{
  // A backgrounded tab, a long garbage collection, a laptop lid. The other
  // peer keeps running and has to be able to come back from it.
  const link = new Link(75, 0, 0, 31);
  const peers = begin(link, { timeSync: true });
  run(link, peers, 200, held);
  run(link, peers, 300, held, 200, { hitch: (s, i) => s === 1 && i < 40 });
  run(link, peers, 300, held, 500);
  converge(link, peers);
  check("the world is the same on both sides",
        peers[0].host.hash() === peers[1].host.hash(), true);
  check("neither reported a desync",
        peers[0].session.desyncs + peers[1].session.desyncs, 0);
}

console.log("\nthe link is measurable, which it was not");
{
  const link = new Link(90, 15, 0, 37);
  link.batchMs = 115;
  const peers = begin(link, { timeSync: true });
  run(link, peers, 400, noisy);
  const s = peers[0].session;
  // 180 ms of round trip, plus whatever the batch held. The estimate is
  // smoothed and the batch is a leading edge, so this is a range rather than
  // an equality -- but it has to be in the right part of the map.
  check("a round trip was measured at all", s.rttMs !== null, true);
  check("and it is in the right range",
        s.rttMs !== null && s.rttMs > 120 && s.rttMs < 500, true);
  check("jitter is not zero on a jittery link", s.jitterMs > 0, true);
  check("and input age accounts for the batching",
        s.inputAgeMs > 115, true);
  console.log(`       rtt ${s.rttMs?.toFixed(0)} ms, jitter ${s.jitterMs.toFixed(1)} ms, ` +
              `age ${s.inputAgeMs.toFixed(0)} ms, pressure ${s.pressure.toFixed(2)}`);
}

console.log("\na healthy pair is never given input delay it did not need");
{
  const link = new Link(20, 5, 0, 41);
  const peers = begin(link, { timeSync: true, adaptiveDelay: true });
  run(link, peers, 300, noisy);
  // Between levels is when the delay is re-chosen -- and `requestStart` refuses
  // while a level is running, so the pair has to go back to the map first, the
  // same way a real one does.
  nextLevel(link, peers, 2);
  run(link, peers, 120, noisy);
  check("still answering on the very next frame",
        peers[0].session.inputDelay, 0);
  console.log(`       age ${peers[0].session.inputAgeMs.toFixed(0)} ms against a ` +
              `${(peers[0].session.windowMs).toFixed(0)} ms window`);
}

console.log("\nand a pair that cannot fit the window is given some");
{
  // Far enough apart that the window genuinely does not cover the delay, which
  // after the widening takes a frankly absurd link: a second and a half of
  // round trip on top of the batching. That is the honest shape of the result
  // -- thirty frames of window is enough for any pair that can play at all, and
  // the delay is there for the ones that cannot.
  const link = new Link(800, 50, 0, 43);
  link.batchMs = 230;
  const peers = begin(link, { timeSync: true, adaptiveDelay: true });
  run(link, peers, 400, noisy);
  nextLevel(link, peers, 2);
  run(link, peers, 200, noisy);
  check("the delay was raised", peers[0].session.inputDelay > 0, true);
  check("but never past two frames", peers[0].session.inputDelay <= 2, true);
  console.log(`       delay ${peers[0].session.inputDelay} frames at ` +
              `${peers[0].session.inputAgeMs.toFixed(0)} ms of input age`);
  converge(link, peers);
  check("and the pair still agrees",
        peers[0].host.hash() === peers[1].host.hash(), true);
}

console.log("\n" + (failures === 0 ? "DRIFT PASSED"
                                   : `DRIFT FAILED (${failures})`));
if (failures > 0) process.exit(1);
