/**
 * Two peers, one process, a hostile link.
 *
 * This is the test that has to pass before anyone debugs a real network. It
 * runs two complete NetSessions against the real engine over an in-memory link
 * with injectable latency, jitter and packet loss, on a virtual clock, so a
 * five-thousand-frame session over a bad connection takes a second and is
 * exactly reproducible.
 *
 * What it is really asserting is that the whole design holds: that two
 * simulations fed the same three bits per player per frame stay bit-identical,
 * that losing packets does not matter because every packet repeats recent
 * history, that pause and retry are safe because they travel the same channel
 * as input, and that a deliberately corrupted peer notices and repairs itself
 * by replaying rather than by exchanging state.
 */
import { NetSession, Slot } from "./net/session.js";
import { Transport } from "./net/transport.js";
import { Command } from "./net/protocol.js";
import { LevelHost } from "./net/levelhost.js";
import { Rng } from "./net/rng.js";

let failures = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` +
              (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

/**
 * A two-ended link on a virtual clock.
 *
 * Packets are queued with a delivery time and released by `advance`, so the
 * whole test is deterministic: the same seed always drops the same packets.
 */
class Link {
  private queue: { at: number; to: 0 | 1; data: Uint8Array }[] = [];
  private handlers: [((d: Uint8Array) => void)?, ((d: Uint8Array) => void)?] = [];
  private now = 0;
  get nowMs(): number { return this.now; }
  private rng: Rng;
  /** Packets sent, and of those, dropped. */
  sent = 0;
  dropped = 0;

  constructor(private latencyMs: number, private jitterMs: number,
              private loss: number, seed = 1) {
    this.rng = new Rng(seed);
  }

  /**
   * Everything that crosses the link, for somebody who is not on either end.
   *
   * A watcher does not sit between the two peers -- it is handed a copy of what
   * they said to each other. This is the in-memory version of the mirror the
   * app puts on the pair's channel, and it delivers on the same schedule as the
   * real traffic so a test cannot accidentally depend on being ahead of it.
   */
  private watchers: ((d: Uint8Array) => void)[] = [];

  watch(fn: (d: Uint8Array) => void): void { this.watchers.push(fn); }

  endpoint(side: 0 | 1): Transport {
    const other = (side === 0 ? 1 : 0) as 0 | 1;
    const link = this;
    return {
      get rttMs() { return link.latencyMs * 2; },
      send(data: Uint8Array) {
        link.sent++;
        // Copied before the loss roll: a watcher is on a different wire, and a
        // packet the peers dropped between themselves is not one the watcher
        // is obliged to lose too.
        for (const w of link.watchers) w(data.slice());
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

  /** Cut the wire, or mend it. A blackout is not the same as steady loss. */
  setLoss(loss: number): void { this.loss = loss; }

  advance(ms: number): void {
    this.now += ms;
    const due = this.queue.filter((p) => p.at <= this.now);
    this.queue = this.queue.filter((p) => p.at > this.now);
    // Deliver in send order among those due; jitter already reordered them.
    for (const p of due) this.handlers[p.to]?.(p.data);
  }
}

interface Peer { session: NetSession; host: LevelHost; }

function pair(link: Link, delay: number,
              onDesync?: (s: Slot) => void,
              onQuit?: (heardBy: Slot, by: Slot, forGood: boolean) => void,
): [Peer, Peer] {
  const make = (slot: Slot): Peer => {
    const host = new LevelHost();
    const session = new NetSession({
      slot, host, transport: link.endpoint(slot), now: () => link.nowMs, workNow: () => 0, delay,
      onDesync: () => onDesync?.(slot),
      onQuit: (by, forGood) => onQuit?.(slot, by, forGood),
    });
    return { session, host };
  };
  return [make(0), make(1)];
}

const STEP = 1 / 26;
const STEP_MS = STEP * 1000;

/** Run both peers for `frames` of wall time, feeding them scripted input. */
function run(link: Link, peers: [Peer, Peer], frames: number,
             input?: (slot: Slot, frame: number) => number): void {
  for (let i = 0; i < frames; i++) {
    for (const s of [0, 1] as Slot[]) {
      peers[s].session.setLocalInput(input ? input(s, i) : 0);
    }
    link.advance(STEP_MS);
    peers[0].session.tick(STEP);
    peers[1].session.tick(STEP);
  }
}

/** A repeatable but non-trivial input pattern, different for each player. */
function scripted(slot: Slot, frame: number): number {
  const t = frame + slot * 37;
  return ((t >> 3) & 1 ? 2 : 0) | ((t >> 5) & 1 ? 1 : 0) | ((t % 41) === 0 ? 4 : 0);
}

// ---------------------------------------------------------------------------

console.log("a clean link");
{
  const link = new Link(0, 0, 0);
  const peers = pair(link, 3);
  peers[0].session.requestStart("adventure", 1);
  link.advance(STEP_MS);
  run(link, peers, 2000, scripted);
  check("both peers reached the same frame",
        peers[0].session.frame === peers[1].session.frame, true);
  check("frames simulated", peers[0].session.frame > 1900, true);
  check("digests match", peers[0].host.hash() === peers[1].host.hash(), true);
  check("no desyncs", peers[0].session.desyncs + peers[1].session.desyncs, 0);
}

console.log("\n150 ms round trip, 5% packet loss, 20 ms jitter");
{
  const link = new Link(75, 20, 0.05, 12345);
  const peers = pair(link, 4);
  peers[0].session.requestStart("adventure", 8);
  link.advance(200);
  run(link, peers, 5000, scripted);
  console.log(`  ${link.sent} packets sent, ${link.dropped} dropped, ` +
              `${peers[0].session.stalls} stalls`);
  check("both peers reached the same frame",
        peers[0].session.frame === peers[1].session.frame, true);
  check("digests match after 5000 frames",
        peers[0].host.hash() === peers[1].host.hash(), true);
  check("no desyncs", peers[0].session.desyncs + peers[1].session.desyncs, 0);
  check("the session kept up", peers[0].session.frame > 4500, true);
}

console.log("\nheavy loss (25%) still heals, because every packet repeats history");
{
  const link = new Link(60, 15, 0.25, 999);
  const peers = pair(link, 4);
  peers[0].session.requestStart("puzzle", 5);
  link.advance(200);
  run(link, peers, 3000, scripted);
  console.log(`  ${link.dropped} of ${link.sent} packets dropped`);
  check("digests match", peers[0].host.hash() === peers[1].host.hash(), true);
  check("no desyncs", peers[0].session.desyncs + peers[1].session.desyncs, 0);
}

console.log("\npause travels the channel, so both peers pause on the same frame");
{
  const link = new Link(40, 0, 0);
  const peers = pair(link, 3);
  peers[0].session.requestStart("adventure", 1);
  link.advance(STEP_MS);
  // Neutral input here, deliberately: `level.Update` latches `pause` true for
  // good once a level ENDS, and the scripted pattern walks Fireboy into water
  // within a few hundred frames. That is the original's own behaviour --
  // Game.keyPressed guards the tray with `if (m_level.ended == false)` -- so a
  // pause test that let someone die would be testing the wrong thing.
  run(link, peers, 200);
  check("nobody died, so pause is ours to control", peers[0].host.lv.ended,
        false);
  peers[1].session.send(Command.Pause);      // the OTHER peer presses P
  run(link, peers, 200);
  check("both are paused", [peers[0].host.lv.pause, peers[1].host.lv.pause],
        [true, true]);
  check("and still in step", peers[0].host.hash() === peers[1].host.hash(), true);
  peers[0].session.send(Command.Pause);
  run(link, peers, 200);
  check("both resumed", [peers[0].host.lv.pause, peers[1].host.lv.pause],
        [false, false]);
  check("still in step", peers[0].host.hash() === peers[1].host.hash(), true);
}

console.log("\nretry restarts both peers together");
{
  const link = new Link(40, 0, 0);
  const peers = pair(link, 3);
  peers[0].session.requestStart("adventure", 1);
  link.advance(STEP_MS);
  run(link, peers, 500, scripted);
  const before = peers[0].host.lv;
  peers[0].session.send(Command.Retry);
  run(link, peers, 300, scripted);
  check("a new level was built", peers[0].host.lv !== before, true);
  check("both restarted their frame counter",
        peers[0].session.frame === peers[1].session.frame, true);
  check("digests match after the retry",
        peers[0].host.hash() === peers[1].host.hash(), true);
}

console.log("\nquitting to the map, then starting another level");
{
  // The flow that used to strand a pair. Quit stops the session running, and
  // for a while that also stopped the whole world: the page handed its clock to
  // a session that returned immediately, so the map never drew a frame and the
  // level a click built never advanced one.
  const heard: [Slot, Slot, boolean][] = [];
  const link = new Link(40, 0, 0);
  const peers = pair(link, 3, undefined,
                     (heardBy, by, forGood) => heard.push([heardBy, by, forGood]));
  peers[0].session.requestStart("adventure", 1);
  link.advance(STEP_MS);
  run(link, peers, 300, scripted);
  check("both are running a level",
        [peers[0].session.running, peers[1].session.running], [true, true]);

  peers[1].session.send(Command.Quit, 1);
  run(link, peers, 60, scripted);
  check("both left it",
        [peers[0].session.running, peers[1].session.running], [false, false]);
  check("and both were told who by, and that it was not for good",
        heard.map((h) => [h[1], h[2]]), [[1, false], [1, false]]);

  // Only one of them chooses levels, and this is that one.
  peers[0].session.requestStart("puzzle", 3);
  link.advance(STEP_MS);
  run(link, peers, 400, scripted);
  check("both started the new one",
        [peers[0].session.running, peers[1].session.running], [true, true]);
  check("and it is the same one",
        [peers[0].host.lv.CurrentMode, peers[0].host.lv.CurrentLevel,
         peers[1].host.lv.CurrentMode, peers[1].host.lv.CurrentLevel],
        ["puzzle", 3, "puzzle", 3]);
  check("on the same generation of it",
        peers[0].session.generation === peers[1].session.generation, true);
  check("in step", peers[0].host.hash() === peers[1].host.hash(), true);
  check("with no desyncs",
        peers[0].session.desyncs + peers[1].session.desyncs, 0);
}

console.log("\nboth players hitting retry at once");
{
  // Either player may retry, so both pressing at the same moment is ordinary,
  // not exotic. They schedule on different frames; whichever is earlier applies
  // on both, the epoch moves, and the later one is dropped as stale rather than
  // retrying a second time -- which would leave the two on different builds of
  // the same level with matching digests and no way to notice.
  const link = new Link(40, 0, 0);
  const peers = pair(link, 3);
  peers[0].session.requestStart("adventure", 1);
  link.advance(STEP_MS);
  run(link, peers, 300, scripted);
  const was = [peers[0].host.lv, peers[1].host.lv];
  const generation = peers[0].session.generation;

  peers[0].session.send(Command.Retry);
  peers[1].session.send(Command.Retry);
  run(link, peers, 400, scripted);

  check("both rebuilt the level",
        [peers[0].host.lv !== was[0], peers[1].host.lv !== was[1]],
        [true, true]);
  check("once each, not twice",
        [peers[0].session.generation - generation,
         peers[1].session.generation - generation], [1, 1]);
  check("both are on the same frame",
        peers[0].session.frame === peers[1].session.frame, true);
  check("digests match", peers[0].host.hash() === peers[1].host.hash(), true);
  check("with no desyncs",
        peers[0].session.desyncs + peers[1].session.desyncs, 0);
}

console.log("\nsomebody watching sees the same game");
{
  // The whole of spectating, and it is nearly free: the simulation is a pure
  // function of (mode, level, input log), so a third session fed the two
  // players' input reaches the same world without either of them doing
  // anything for it.
  //
  // The observer is neither slot. It takes both players' input off the wire,
  // sends nothing, and never predicts -- prediction hides the delay between
  // pressing a key and seeing your own character move, and a watcher has no
  // key to press.
  const link = new Link(40, 0, 0);
  const peers = pair(link, 3);

  // The pair play a level and retry it BEFORE anybody is watching, so their
  // generation counter has moved on. That is the ordinary case -- somebody
  // decides to watch a game that is already happening -- and it is the one that
  // catches the mistake: the epoch is a number two peers keep in step by
  // applying the same Starts and Retries, and a watcher has applied none of
  // them. Filtering on it would drop every packet forever.
  peers[0].session.requestStart("adventure", 1);
  link.advance(STEP_MS);
  run(link, peers, 120, scripted);
  peers[0].session.send(Command.Retry);
  run(link, peers, 120, scripted);
  check("the pair have moved on before anybody looks",
        peers[0].session.generation > 1, true);

  const seat = new LevelHost();
  const eyes = new NetSession({
    slot: 0, observer: true, host: seat,
    transport: {
      rttMs: null,
      send() { /* a watcher says nothing */ },
      onMessage(fn) { link.watch(fn); },
      close() {},
    },
  });

  // Nothing to see until they start something: a watcher joins the next level,
  // not the middle of this one.
  run(link, peers, 60, scripted);
  check("nothing to watch in the middle of a level", eyes.running, false);

  peers[0].session.send(Command.Quit, 0);
  run(link, peers, 40, scripted);
  peers[0].session.requestStart("adventure", 1);
  link.advance(STEP_MS);
  for (let i = 0; i < 600; i++) {
    for (const s of [0, 1] as Slot[]) {
      peers[s].session.setLocalInput(scripted(s, i));
    }
    link.advance(STEP_MS);
    peers[0].session.tick(STEP);
    peers[1].session.tick(STEP);
    eyes.tick(STEP);
  }

  check("the watcher started the level the pair started", eyes.running, true);
  check("and is on the same generation of it",
        eyes.generation === peers[0].session.generation, true);
  // Behind, not wrong. A watcher runs a frame or two back because it waits for
  // both players rather than guessing at either.
  check("running a little behind, as watching does",
        eyes.frame > 0 && eyes.frame <= peers[0].session.frame, true);
  console.log(`  the pair are on frame ${peers[0].session.frame}, ` +
              `the watcher on ${eyes.frame}`);

  // Compared at the same frame, not at the same moment. Two sessions sampled
  // at one instant legitimately differ; the question is whether the watcher
  // ever simulated a different game, and the log is what answers it.
  let sameLog = true;
  for (let f = 0; f < eyes.frame; f++) {
    if (eyes.log[f] !== peers[0].session.log[f]) { sameLog = false; break; }
  }
  check("every frame it ran was the frame the players ran", sameLog, true);

  // And it follows them through a retry without being told anything special:
  // the command carries the frame it lands on and the generation it belongs to.
  const before = eyes.generation;
  peers[1].session.send(Command.Retry);
  for (let i = 0; i < 400; i++) {
    for (const s of [0, 1] as Slot[]) {
      peers[s].session.setLocalInput(scripted(s, i));
    }
    link.advance(STEP_MS);
    peers[0].session.tick(STEP);
    peers[1].session.tick(STEP);
    eyes.tick(STEP);
  }
  check("a retry takes the watcher with it", eyes.generation - before, 1);
  check("onto the same generation the players are on",
        eyes.generation === peers[0].session.generation, true);
  check("and it is still the same game",
        eyes.log.slice(0, eyes.frame).join() ===
        peers[0].session.log.slice(0, eyes.frame).join(), true);
  check("with nobody desyncing", eyes.desyncs, 0);
}

console.log("\na Start that is lost completely still gets there");
{
  // The one command a fixed number of attempts is not good enough for. Thirteen
  // copies is a very good bet; the time it loses, the two peers sit on
  // different generations of the level and every later packet is filtered by
  // the epoch they no longer share, so nothing can even notice. Here the wire
  // is cut for long enough to swallow every copy.
  const link = new Link(40, 0, 1);
  const peers = pair(link, 3);
  peers[0].session.requestStart("adventure", 1);
  link.advance(STEP_MS);
  run(link, peers, 60, scripted);
  check("nothing got through, so the second peer never started",
        [peers[0].session.running, peers[1].session.running], [true, false]);

  link.setLoss(0);
  run(link, peers, 300, scripted);
  check("once the wire is back, the Start is still being offered",
        peers[1].session.running, true);
  check("on the same generation",
        peers[0].session.generation === peers[1].session.generation, true);
  check("and they converge",
        peers[0].host.hash() === peers[1].host.hash(), true);
  check("with no desyncs",
        peers[0].session.desyncs + peers[1].session.desyncs, 0);
}

console.log("\na peer that closes its tab is heard, not merely missed");
{
  // The one command that cannot be scheduled on a future frame. An ordinary
  // command is applied a rollback window ahead, which works because both peers
  // keep sending the input that carries each other there. Somebody who has gone
  // sends nothing more, so a scheduled Quit sits one frame past the edge of the
  // prediction window and the peer stalls in front of the very message that
  // would have released it -- forever, and looking exactly like a crash.
  const heard: [Slot, Slot, boolean][] = [];
  const link = new Link(40, 0, 0);
  const peers = pair(link, 3, undefined,
                     (heardBy, by, forGood) => heard.push([heardBy, by, forGood]));
  peers[0].session.requestStart("adventure", 1);
  link.advance(STEP_MS);
  run(link, peers, 300, scripted);
  check("both were playing", peers[0].session.running, true);

  // Peer 1 leaves and never ticks again, which is what a closed tab looks like.
  peers[1].session.depart();
  for (let i = 0; i < 200; i++) {
    peers[0].session.setLocalInput(scripted(0, i));
    link.advance(STEP_MS);
    peers[0].session.tick(STEP);
  }
  check("the one still there was told, and told that it was for good",
        heard, [[0, 1, true]]);
  check("and is out of the level rather than stalled in front of it",
        peers[0].session.running, false);
}

console.log("\na corrupted peer notices, and repairs itself by replaying");
{
  const seen: Slot[] = [];
  const link = new Link(40, 0, 0);
  const peers = pair(link, 3, (s) => seen.push(s));
  peers[0].session.requestStart("adventure", 1);
  link.advance(STEP_MS);
  run(link, peers, 400, scripted);
  check("in step before the damage",
        peers[0].host.hash() === peers[1].host.hash(), true);

  // Reach into peer 1's world and shove a body. Nothing in the protocol can
  // cause this -- it stands in for an engine bug, which is the only thing that
  // could actually desync two peers running identical inputs.
  const body = peers[1].host.lv.pers1;
  body.SetXForm(body.GetPosition(), body.GetAngle() + 0.05);
  check("the damage took", peers[0].host.hash() !== peers[1].host.hash(), true);

  run(link, peers, 400, scripted);
  check("the desync was detected", seen.length > 0, true);
  check("and repaired", peers[0].host.hash() === peers[1].host.hash(), true);
  console.log(`  detected by peer ${seen[0]}, ` +
              `${peers[0].session.desyncs + peers[1].session.desyncs} report(s)`);
}

console.log("\na stall is a duration, not a tally");
{
  // The page waits two seconds of continuous silence before it says "waiting
  // for your friend", so that a jittery moment does not flash a warning at
  // somebody whose game is about to carry on perfectly well. That threshold is
  // only a threshold if the counter it reads is the length of the CURRENT
  // stall: as a lifetime tally it is crossed once, early -- a relayed pair
  // crosses it in the first seconds, because batching means the session runs to
  // the edge of its prediction window and waits on every burst -- and from then
  // on the message tracked `stalled` exactly, which flips every frame or two.
  // On screen that was a banner strobing at frame rate, and a page whose height
  // changed with it.
  const link = new Link(0, 0, 0);
  const peers = pair(link, 3);
  peers[0].session.requestStart("adventure", 1);
  link.advance(STEP_MS);
  run(link, peers, 60, scripted);
  check("nobody is stalled on a healthy link",
        [peers[0].session.stalled, peers[0].session.stalledFrames],
        [false, 0]);

  // One peer goes quiet: the other predicts to the edge of its window and waits.
  for (let i = 0; i < 120; i++) {
    peers[0].session.setLocalInput(scripted(0, i));
    link.advance(STEP_MS);
    peers[0].session.tick(STEP);
  }
  const stalled = peers[0].session.stalledFrames;
  check("a silent peer stalls the other one", peers[0].session.stalled, true);
  check("for as long as the silence lasts", stalled > 52, true);

  // And back: the counter has to return to zero, or the threshold above is
  // satisfied for the rest of the level.
  run(link, peers, 120, scripted);
  // Not "exactly zero": a lockstep peer waits a tick for its partner's packet
  // now and then, and one such frame is what a healthy link looks like. What
  // matters is that the count came back DOWN -- far under the threshold the
  // page reads -- rather than staying above it for the rest of the level.
  check("the count comes back down once the peer is heard from",
        peers[0].session.stalledFrames < 52, true);
  check("while the tally remembers it happened",
        peers[0].session.stalls >= stalled, true);
  check("and they caught each other up",
        Math.abs(peers[0].session.frame - peers[1].session.frame) < 5, true);
  check("and are still in step",
        peers[0].host.hash() === peers[1].host.hash(), true);
}

console.log("\na repair after a retry stays on one generation");
{
  // `resync` rebuilds the level and replays the whole input log, and the log it
  // replays holds every command the session applied. All of them are safe to
  // apply twice except the two that rebuild the level, because `begin` and
  // `retryLevel` each bump the epoch -- and a second bump on one side alone
  // puts the two peers on generations that can never agree again: every later
  // packet is filtered as stale, in both directions, with nothing left that
  // could notice. `resetLog` clearing the command table is what makes it
  // unreachable; this is the test that says so out loud.
  const link = new Link(30, 0, 0);
  const peers = pair(link, 0);
  peers[0].session.requestStart("adventure", 1);
  link.advance(200);
  run(link, peers, 100, scripted);
  peers[0].session.send(Command.Retry);
  run(link, peers, 200, scripted);
  const gen = peers[0].session.generation;
  check("both peers are on the generation the retry made",
        [gen, peers[1].session.generation], [gen, gen]);

  peers[0].session.resync();
  run(link, peers, 100, scripted);
  check("a replay does not move either of them off it",
        [peers[0].session.generation, peers[1].session.generation], [gen, gen]);
  check("and they still agree",
        peers[0].host.hash() === peers[1].host.hash(), true);
  check("with no desyncs",
        peers[0].session.desyncs + peers[1].session.desyncs, 0);
}

console.log("\na stall is not paid back as a fast-forward");
{
  // The bug this is here for was reported as "a jump of frames, and then the
  // connection is lost". Every tick of a stall added its `dt` to the clock and
  // returned without spending any of it, so ten seconds of silence left ten
  // seconds in the accumulator -- and the tick that finally had the input ran
  // frames until its budget or the input ran out, and the tick after it did it
  // again. To the other player that is a character standing still and then
  // crossing the level in a blink.
  // Rollback, because that is what the game ships and it is what makes the
  // burst big: a peer may run ten frames ahead of what the other has
  // confirmed, so a tick with a backlog to spend buys ten frames rather than
  // one. Under lockstep the input delay bounds it to the delay and the bug
  // cannot show.
  const link = new Link(0, 0, 0);
  const make = (slot: Slot): Peer => {
    const host = new LevelHost();
    return {
      host,
      session: new NetSession({
        // Pinned rather than taking the default: what is under test is the
        // clamp on the backlog, and the window is a number that moves for
        // reasons of its own -- it went from ten to fourteen when the relay's
        // batching doubled. A test of one should not fail for the other.
        slot, host, transport: link.endpoint(slot), now: () => link.nowMs, workNow: () => 0, rollback: true,
        maxRollback: 10,
      }),
    };
  };
  const peers: [Peer, Peer] = [make(0), make(1)];

  peers[0].session.requestStart("adventure", 1);
  link.advance(200);
  run(link, peers, 60, scripted);
  const before = peers[0].session.frame;

  // The link stops delivering. Both peers keep being ticked -- two browsers go
  // on painting whatever the network is doing -- so both predict as far as a
  // correction can reach and then stall, spending ten seconds of wall time
  // doing it.
  const WAITED = 260;
  for (let i = 0; i < WAITED; i++) {
    for (const s of [0, 1] as Slot[]) {
      peers[s].session.setLocalInput(scripted(s, before + i));
    }
    peers[0].session.tick(STEP);
    peers[1].session.tick(STEP);
  }
  check("both stalled rather than guessing on",
        [peers[0].session.stalled, peers[1].session.stalled], [true, true]);
  const waited = peers[0].session.frame - before;
  check("and neither ran further than a correction could reach",
        waited <= 10, true);

  // Everything either of them said arrives at once, which is what a channel
  // coming back looks like. From here the pair should resume at the speed the
  // game runs at, not replay the ten seconds they sat through.
  link.advance(WAITED * STEP_MS);
  const TICKS = 30;
  const resumed = peers[0].session.frame;
  for (let i = 0; i < TICKS; i++) {
    for (const s of [0, 1] as Slot[]) peers[s].session.setLocalInput(0);
    link.advance(STEP_MS);
    peers[0].session.tick(STEP);
    peers[1].session.tick(STEP);
  }
  const ran = peers[0].session.frame - resumed;
  console.log(`       ${ran} frames over ${TICKS} ticks after it came back`);
  // One frame per tick is the game running. The allowance on top is
  // CATCHUP_FRAMES, which is there so an ordinary hiccup still catches up
  // promptly; without the clamp this is several times TICKS.
  check("it resumes rather than fast-forwards", ran <= TICKS + 10, true);
  check("and they agree on what did run",
        peers[0].host.hash() === peers[1].host.hash(), true);
  check("with no desyncs",
        peers[0].session.desyncs + peers[1].session.desyncs, 0);
}

console.log("\nsolo runs through the same session, with no peer");
{
  const link = new Link(0, 0, 0);
  const host = new LevelHost();
  const session = new NetSession({
    slot: 0, host, transport: link.endpoint(0), delay: 3, solo: true,
  });
  session.begin("adventure", 1);
  for (let i = 0; i < 600; i++) {
    session.setLocalInput(scripted(0, i));
    session.tick(STEP);
  }
  check("it never stalled", session.stalls, 0);
  check("and simulated the frames", session.frame > 550, true);
}

console.log("\n" + (failures === 0 ? "NETCODE PASSED"
                                   : `NETCODE FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
