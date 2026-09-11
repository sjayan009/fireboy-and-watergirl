/**
 * Every kind of bad connection, against both modes, with four kinds of player.
 *
 * `nettest` and `rollbacktest` each pick a handful of conditions and assert
 * carefully against them. That is the right shape for testing the mechanisms.
 * It is the wrong shape for the question "is there a combination where this
 * falls over?", because a handful of samples cannot answer it.
 *
 * So this is a sweep. Round trip, jitter and loss across ranges that cover
 * everything from a LAN to a bad hotel connection; lockstep and rollback; and
 * four input patterns chosen to be awkward in different ways -- held keys,
 * keys flipping every other frame, deterministic noise, and everything mashed
 * down at once.
 *
 * Each cell asserts three things:
 *
 *   * the two peers settled on the SAME INPUT LOG, over the frames they have
 *     both simulated;
 *   * neither reported a desync;
 *   * and each peer's state is the state a straight re-simulation of its own
 *     log reaches -- so prediction changed the timing and nothing else.
 *
 * Note what is deliberately NOT asserted: that the two are on the same frame.
 * They are not, and need not be. A lockstep peer may legitimately sit up to
 * `delay + 1` frames ahead, because it already holds input for frames the other
 * has not consumed; a rollback peer's newest frames are predictions. Demanding
 * equality was the first version of this test and it failed at 300 ms in a way
 * that looked alarming and meant nothing. Identical logs plus faithful replay
 * is the real claim, and it holds at every latency.
 *
 * It also reports the COST per cell: corrections, snapshots and the deepest
 * rewind. A change that keeps the digests matching while doubling the work is
 * a regression that no assertion here would catch, and a number somebody can
 * look at will.
 */
import {
  Link, converge, held, mashing, noisy, pair, replay, run, start, twitchy,
} from "./netlink.js";
import { Slot } from "./net/session.js";

const QUICK = process.argv.includes("--quick");

const LATENCY = QUICK ? [0, 75] : [0, 20, 75, 150];
const JITTER = QUICK ? [0] : [0, 30];
const LOSS = QUICK ? [0, 0.05] : [0, 0.05, 0.2];
/**
 * How long the sender may sit on a packet before it goes.
 *
 * The relay batches, and for a relayed pair that wait is most of the delay
 * budget -- 230 ms out of what used to be a 538 ms window. The matrix modelled
 * network latency alone until now, so every cell it called healthy was
 * answering a question no relayed pair was asking.
 */
const BATCH = QUICK ? [0] : [0, 230];
/**
 * Clock ratios between the two peers.
 *
 * Two browsers on two machines do not advance time together, and until the
 * harness could say so this was not merely untested but inexpressible. See
 * `drifttest.ts` for the dedicated version; here it is one more axis, so that
 * every OTHER thing the matrix sweeps is also swept against a pair whose
 * clocks disagree.
 */
const CLOCKS: [number, number][] = QUICK ? [[1, 1]] : [[1, 1], [1, 1.03]];
const MODES: [string, boolean][] = [["lockstep", false], ["rollback", true]];
const PATTERNS: [string, (s: Slot, f: number) => number][] = QUICK
  ? [["held", held], ["twitchy", twitchy]]
  : [["held", held], ["twitchy", twitchy], ["noisy", noisy], ["mashing", mashing]];

const FRAMES = QUICK ? 400 : 900;

let failures = 0;
let cells = 0;
let worstDepth = 0;
let seed = 1;

console.log(`${LATENCY.length * JITTER.length * LOSS.length * MODES.length *
  PATTERNS.length * BATCH.length * CLOCKS.length} combinations, ${FRAMES} frames each`);

for (const [modeName, rollback] of MODES) {
  console.log(`\n${modeName}`);
  for (const latency of LATENCY) {
    for (const jitter of JITTER) {
      for (const loss of LOSS) {
       for (const batch of BATCH) {
        for (const clocks of CLOCKS) {
        const notes: string[] = [];
        let bad = 0;
        let corrections = 0;
        let captures = 0;
        let deepest = 0;
        for (const [patternName, input] of PATTERNS) {
          const link = new Link(latency, jitter, loss, seed++);
          link.batchMs = batch;
          // Time sync is a rollback mechanism: under lockstep a peer cannot run
          // ahead in the first place, so there is no advantage to give back.
          const peers = pair(link, { rollback, timeSync: rollback });
          start(link, peers);
          run(link, peers, FRAMES, input, 0, { clocks });
          converge(link, peers);
          cells++;

          const a = peers[0];
          const b = peers[1];
          const shared = Math.min(a.session.frame, b.session.frame);
          let split = -1;
          for (let f = 0; f < shared; f++) {
            if (a.session.log[f] !== b.session.log[f]) { split = f; break; }
          }
          const desyncs = a.session.desyncs + b.session.desyncs;
          const faithful =
            a.host.hash() === replay("adventure", 1,
              a.session.log.slice(0, a.session.frame)).hash() &&
            b.host.hash() === replay("adventure", 1,
              b.session.log.slice(0, b.session.frame)).hash();
          // Only meaningful when they happen to be level, which is why it is a
          // bonus check rather than the check.
          const agree = a.session.frame !== b.session.frame ||
                        a.host.hash() === b.host.hash();

          corrections += a.session.rollbacks;
          captures += a.session.captures;
          deepest = Math.max(deepest, a.session.deepestRollback);
          worstDepth = Math.max(worstDepth, deepest);
          if (split >= 0 || !agree || desyncs || !faithful) {
            bad++;
            failures++;
            notes.push(`${patternName}: ` +
              (split >= 0 ? `logs diverge at frame ${split} ` : "") +
              (!agree ? "same frame, different worlds " : "") +
              (desyncs ? `${desyncs} desync(s) ` : "") +
              (!faithful ? "does not match a replay of its own log" : ""));
          }
        }

        // The cost, alongside the verdict. A change that keeps every digest
        // matching while doubling the corrections is a regression no assertion
        // here would catch, and a number somebody reads will.
        const label = `rtt ${String(latency * 2).padStart(3)}ms ` +
                      `jitter ${String(jitter).padStart(2)} ` +
                      `loss ${String(Math.round(loss * 100)).padStart(2)}% ` +
                      `batch ${String(batch).padStart(3)} ` +
                      `clock ${clocks[1].toFixed(2)}`;
        const cost = rollback
          ? `  ${corrections} corrections, ${captures} snapshots, deepest ${deepest}`
          : "";
        console.log(`  ${bad === 0 ? "ok  " : "FAIL"} ${label}${cost}` +
                    (notes.length ? "\n       " + notes.join("\n       ") : ""));
        }
       }
      }
    }
  }
}

console.log(`\n${cells} combinations, deepest rewind ${worstDepth} frames`);
console.log(failures === 0
  ? "NET MATRIX PASSED"
  : `NET MATRIX FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
