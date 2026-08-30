/**
 * Rollback: the same game, without the wait.
 *
 * Lockstep's cost is a constant delay between pressing a key and seeing your
 * own character move. Rollback removes it by guessing what the other player is
 * doing, simulating immediately, and re-simulating the moment the guess is
 * shown to be wrong. All of that is a bet on determinism, so these tests are
 * about proving the bet:
 *
 *  1. **Prediction changes the timing, not the game.** Whatever a session
 *     predicted and corrected its way through, it must end exactly where a
 *     straight re-simulation of the input it settled on ends.
 *  2. **Your own input is immediate.** The property the whole milestone exists
 *     for, measured rather than assumed.
 *  3. **It survives a bad link.** 150 ms round trip, jitter and loss, with
 *     input that flips every other frame so the guess is wrong constantly.
 *  4. **Nothing is heard twice.** A re-simulated frame must not replay its
 *     sounds, which is the classic rollback bug.
 */
import { NetSession, Slot } from "./net/session.js";
import { Transport } from "./net/transport.js";
import { LevelHost } from "./net/levelhost.js";
import { Command } from "./net/protocol.js";
import { Rng } from "./net/rng.js";
import { SoundBus } from "./flash/flash.js";
import { verify } from "./net/snapshot.js";

// The snapshotter keeps each object's field list on the object. Tests are where
// that gets cross-checked, on every object of every capture.
verify(true);

let failures = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` +
              (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

/** A two-ended link on a virtual clock, as in nettest. */
class Link {
  private queue: { at: number; to: 0 | 1; data: Uint8Array }[] = [];
  private handlers: [((d: Uint8Array) => void)?, ((d: Uint8Array) => void)?] = [];
  private now = 0;
  private rng: Rng;
  sent = 0;
  dropped = 0;

  constructor(private latencyMs: number, private jitterMs: number,
              private loss: number, seed = 1) {
    this.rng = new Rng(seed);
  }

  endpoint(side: 0 | 1): Transport {
    const other = (side === 0 ? 1 : 0) as 0 | 1;
    const link = this;
    return {
      get rttMs() { return link.latencyMs * 2; },
      send(data: Uint8Array) {
        link.sent++;
        if (link.rng.next() < link.loss) { link.dropped++; return; }
        const jitter = (link.rng.next() * 2 - 1) * link.jitterMs;
        link.queue.push({
          at: link.now + Math.max(0, link.latencyMs + jitter),
          to: other,
          data: data.slice(),
        });
      },
      onMessage(fn) { link.handlers[side] = fn; },
      close() {},
    };
  }

  advance(ms: number): void {
    this.now += ms;
    const due = this.queue.filter((p) => p.at <= this.now);
    this.queue = this.queue.filter((p) => p.at > this.now);
    for (const p of due) this.handlers[p.to]?.(p.data);
  }
}

interface Peer { session: NetSession; host: LevelHost; }

function pair(link: Link, rollback: boolean): [Peer, Peer] {
  const make = (slot: Slot): Peer => {
    const host = new LevelHost();
    const session = new NetSession({
      slot, host, transport: link.endpoint(slot), rollback,
    });
    return { session, host };
  };
  return [make(0), make(1)];
}

const STEP = 1 / 26;
const STEP_MS = STEP * 1000;

function run(link: Link, peers: [Peer, Peer], frames: number,
             input: (slot: Slot, frame: number) => number, from = 0): void {
  for (let i = 0; i < frames; i++) {
    for (const s of [0, 1] as Slot[]) {
      peers[s].session.setLocalInput(input(s, from + i));
    }
    link.advance(STEP_MS);
    peers[0].session.tick(STEP);
    peers[1].session.tick(STEP);
  }
}

function start(link: Link, rollback: boolean): [Peer, Peer] {
  const peers = pair(link, rollback);
  peers[0].session.requestStart("adventure", 1);
  link.advance(STEP_MS);
  return peers;
}

/**
 * Let the two peers catch up with each other.
 *
 * At any instant a rollback peer's newest frame or two are PREDICTIONS, so two
 * peers comparing their live state mid-flight legitimately disagree -- that is
 * the mechanism working, not a desync. They converge when the truth arrives.
 *
 * So: a few frames of unchanging input, which every guess gets right, then a
 * generous delivery of everything still on the wire and a settle with no time
 * on the clock, which corrects without simulating anything new. After this the
 * two are on the same frame with no outstanding guesses, and comparing them
 * means something.
 */
function converge(link: Link, peers: [Peer, Peer]): void {
  run(link, peers, 12, () => 0);
  link.advance(1000);
  peers[0].session.tick(0);
  peers[1].session.tick(0);
}

/**
 * Re-simulate an input log from scratch, with no netcode anywhere near it.
 *
 * This is the reference every rollback claim is measured against. A session
 * that predicted, mispredicted and corrected its way through a level has to
 * land in exactly the state a straight replay of the input it settled on lands
 * in. If it does not, prediction changed the game and not just the timing.
 */
function replay(mode: string, num: number, log: number[]): LevelHost {
  const host = new LevelHost();
  host.start(mode, num);
  for (let f = 0; f < log.length; f++) host.step(log[f] ?? 0, f, false);
  return host;
}

/**
 * Input that changes as often as a person's could, and then some.
 *
 * "Repeat their last input" is a good guess precisely because real players hold
 * keys. Flipping every other frame is the worst case for that guess, which is
 * the case worth testing.
 */
function twitchy(slot: Slot, frame: number): number {
  const t = frame + slot * 37;
  return ((t >> 1) & 1 ? 2 : 0) | ((t >> 2) & 1 ? 1 : 0) | ((t % 17) === 0 ? 4 : 0);
}

/** A realistic one: keys held for a while at a time. */
function held(slot: Slot, frame: number): number {
  const t = frame + slot * 37;
  return ((t >> 3) & 1 ? 2 : 0) | ((t >> 5) & 1 ? 1 : 0) | ((t % 41) === 0 ? 4 : 0);
}

// ---------------------------------------------------------------------------

console.log("prediction changes the timing, not the game");
{
  // The two modes are NOT expected to reach the same digest as each other:
  // lockstep decides a frame's input three frames earlier than rollback does,
  // so the players are literally playing different logs. What has to hold is
  // that each mode ends where a plain re-simulation of its own log ends.
  for (const rollback of [false, true]) {
    const link = new Link(60, 0, 0, 7);
    const peers = start(link, rollback);
    run(link, peers, 400, held);
    converge(link, peers);

    const name = rollback ? "rollback" : "lockstep";
    const s = peers[0].session;
    check(`${name}: the peers agree`,
          peers[0].host.hash() === peers[1].host.hash(), true);
    const ref = replay("adventure", 1, s.log.slice(0, s.frame));
    check(`${name}: and agree with a straight replay of the log`,
          peers[0].host.hash() === ref.hash(), true);
    console.log(`       ${ref.hash()} over ${s.frame} frames` +
                (rollback ? `, after ${s.rollbacks} corrections` : ""));
  }
}

console.log("\nyour own input lands on the very next frame");
{
  // The whole point of the milestone, measured rather than argued.
  const measure = (rollback: boolean): number => {
    const link = new Link(120, 0, 0, 3);
    const peers = start(link, rollback);
    run(link, peers, 40, () => 0);

    const before = peers[0].host.lv.pers1.GetLinearVelocity().x;
    // Press right, and count the frames until this peer's own character has
    // responded to it.
    for (let i = 0; i < 12; i++) {
      peers[0].session.setLocalInput(2);
      peers[1].session.setLocalInput(0);
      link.advance(STEP_MS);
      peers[0].session.tick(STEP);
      peers[1].session.tick(STEP);
      if (peers[0].host.lv.pers1.GetLinearVelocity().x !== before) return i + 1;
    }
    return -1;
  };
  const fast = measure(true);
  const slow = measure(false);
  check("rollback answers on the next frame", fast, 1);
  check("lockstep cannot, by construction", slow >= 4, true);
  console.log(`       ${fast} frame vs ${slow}: ` +
              `${Math.round((slow - fast) * STEP_MS)} ms of input lag removed`);
}

console.log("\n150 ms round trip, 20 ms jitter, 5% loss, input flipping " +
            "every other frame");
{
  const link = new Link(75, 20, 0.05, 11);
  const peers = start(link, true);
  run(link, peers, 1200, twitchy);
  converge(link, peers);
  const s = peers[0].session;

  console.log(`  ${link.sent} packets sent, ${link.dropped} dropped`);
  console.log(`  ${s.rollbacks} corrections, deepest ${s.deepestRollback} ` +
              `frames, ${s.captures} snapshots over ${s.frame} frames`);
  check("digests match", peers[0].host.hash() === peers[1].host.hash(), true);
  check("no desyncs", s.desyncs + peers[1].session.desyncs, 0);
  check("the session kept up", s.frame > 1050, true);
  check("and it really was predicting", s.rollbacks > 50, true);
  check("corrections stayed inside the window", s.deepestRollback <= 20, true);
  check("and never had to fall back to a full replay",
        s.rebuilds + peers[1].session.rebuilds, 0);
  check("and it still matches a straight replay",
        peers[0].host.hash() === replay("adventure", 1,
                                        s.log.slice(0, s.frame)).hash(), true);
}

console.log("\nheavy loss (25%) heals, because every packet repeats history");
{
  const link = new Link(75, 20, 0.25, 5);
  const peers = start(link, true);
  run(link, peers, 600, held);
  converge(link, peers);
  console.log(`  ${link.dropped} of ${link.sent} packets dropped`);
  check("digests match", peers[0].host.hash() === peers[1].host.hash(), true);
  check("no desyncs",
        peers[0].session.desyncs + peers[1].session.desyncs, 0);
}

console.log("\na re-simulated frame makes no sound");
{
  // The classic rollback bug: every correction re-runs frames that already
  // played their sounds, so without suppression a lossy link is a machine gun.
  //
  // The invariant is sharper than a count. Sound must never go BACKWARDS in
  // time: every queued event carries the simulation frame that produced it, so
  // a replayed frame slipping through shows up as a frame number below one
  // already heard, which is exactly what a doubled sound is.
  const link = new Link(75, 20, 0.05, 13);
  const peers = start(link, true);
  SoundBus.drain();
  run(link, peers, 300, twitchy);
  const heard = SoundBus.drain();

  let backwards = 0;
  let high = -1;
  for (const e of heard) {
    if (e.frame < high) backwards++;
    else high = e.frame;
  }
  console.log(`  ${peers[0].session.rollbacks} corrections re-ran frames ` +
              `already heard, across ${heard.length} sounds`);
  check("nothing is heard for a frame already played", backwards, 0);
  check("and something was actually played", heard.length > 100, true);
}

console.log("\npause and retry still travel the channel");
{
  const link = new Link(75, 10, 0.02, 17);
  const peers = start(link, true);
  run(link, peers, 60, held);
  // `level.Update` latches pause once the level has ended, so this only means
  // anything while both characters are alive.
  check("nobody has died, so pause is ours to control",
        peers[0].host.lv.ended, false);

  peers[0].session.send(Command.Pause);
  run(link, peers, 30, held, 60);
  converge(link, peers);
  check("both are paused",
        [peers[0].host.lv.pause, peers[1].host.lv.pause], [true, true]);
  check("and still in step",
        peers[0].host.hash() === peers[1].host.hash(), true);

  peers[1].session.send(Command.Pause);
  run(link, peers, 30, held, 90);
  converge(link, peers);
  check("both resumed",
        [peers[0].host.lv.pause, peers[1].host.lv.pause], [false, false]);
  check("still in step",
        peers[0].host.hash() === peers[1].host.hash(), true);

  const before = peers[0].host.lv;
  peers[0].session.send(Command.Retry);
  run(link, peers, 60, held, 120);
  converge(link, peers);
  check("a new level was built", peers[0].host.lv !== before, true);
  check("both restarted their frame counter",
        peers[0].session.frame < 100 && peers[1].session.frame < 100, true);
  check("both are on the same frame",
        peers[0].session.frame === peers[1].session.frame, true);
  check("digests match after the retry",
        peers[0].host.hash() === peers[1].host.hash(), true);
  check("and neither needed a full replay",
        peers[0].session.rebuilds + peers[1].session.rebuilds, 0);
}

console.log("\na peer that runs too far ahead waits rather than guessing wildly");
{
  // A one-way stall: peer 1 stops ticking, so peer 0 keeps predicting until a
  // correction could no longer reach back, and then has to wait.
  const link = new Link(75, 0, 0, 19);
  const peers = start(link, true);
  run(link, peers, 100, held);
  const at = peers[0].session.frame;

  for (let i = 0; i < 60; i++) {
    peers[0].session.setLocalInput(held(0, 100 + i));
    link.advance(STEP_MS);
    peers[0].session.tick(STEP);          // peer 1 does not tick
  }
  const ahead = peers[0].session.frame - at;
  check("it ran ahead, but only as far as the window allows", ahead <= 14, true);
  check("and it says so", peers[0].session.stalled, true);
  console.log(`       ran ${ahead} frames ahead, then waited`);

  run(link, peers, 200, held, 160);
  converge(link, peers);
  check("digests match once both are ticking again",
        peers[0].host.hash() === peers[1].host.hash(), true);
}

console.log("\n" + (failures === 0
  ? "ROLLBACK PASSED"
  : `ROLLBACK FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
