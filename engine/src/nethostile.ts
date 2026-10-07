/**
 * What happens when the network is not merely bad but actively wrong.
 *
 * The matrix covers latency, jitter and loss -- the things a connection does by
 * accident. This covers the things a protocol has to survive on purpose:
 * packets that arrive truncated, packets with their bytes changed, a whole
 * class of message dropped for a while, and packets from a level the peer has
 * already left.
 *
 * Each of these has a specific claim attached, and each claim is one the design
 * rests on somewhere:
 *
 *   * `decode` returns null rather than throwing, so a malformed packet is
 *     ignored and not a crash in the middle of a game.
 *   * input needs no retransmission, because every packet repeats the last
 *     sixteen frames.
 *   * commands DO need it, because they have no such redundancy -- a dropped
 *     Pause would leave one peer paused and the other running, forever.
 *   * frame numbers are ambiguous across a Retry, which is what the epoch byte
 *     exists to disambiguate.
 */
import {
  Link, converge, held, pair, replay, run, start, type Peer,
} from "./netlink.js";
import { BODY_HISTORY, Command, Kind, decode, encodeInput } from "./net/protocol.js";
import { Rng } from "./net/rng.js";

let failures = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` +
              (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

/**
 * Whether the two peers are in the same place, and if not, which way.
 *
 * An assertion that can fail two ways should say which: "they are on different
 * frames" and "they are on the same frame and disagree about it" are completely
 * different problems, and the first is usually the test's fault.
 */
function agreed(peers: [Peer, Peer]): string {
  const [a, b] = peers;
  if (a.session.frame !== b.session.frame) {
    return `different frames: ${a.session.frame} vs ${b.session.frame}`;
  }
  if (a.host.hash() !== b.host.hash()) {
    return `same frame, different worlds: ${a.host.hash()} vs ${b.host.hash()}`;
  }
  return "";
}

// ---------------------------------------------------------------------------

console.log("packets that arrive damaged are ignored, not obeyed");
{
  const rng = new Rng(7);
  const link = new Link(40, 10, 0, 3);
  // A fifth of everything is mangled: bytes flipped, or the packet cut short.
  link.damage = (d) => {
    if (rng.next() > 0.2) return d;
    if (rng.next() < 0.5) return d.slice(0, Math.floor(rng.next() * d.length));
    const copy = d.slice();
    copy[Math.floor(rng.next() * copy.length)] ^= 0xff;
    return copy;
  };

  const peers = pair(link, { rollback: true });
  start(link, peers);
  run(link, peers, 900, held);
  converge(link, peers);

  check("the session survived it", peers[0].session.frame > 800, true);
  check("the peers still agree", agreed(peers), "");
  check("and it still matches a replay of its own log",
        peers[0].host.hash() === replay("adventure", 1,
          peers[0].session.log.slice(0, peers[0].session.frame)).hash(), true);
}

console.log("\na client from before the trailer can still read the body");
{
  // The compatibility promise, checked rather than asserted.
  //
  // The trailer was put AFTER the body checksum for exactly one reason: a
  // browser that has not reloaded since the deploy has to keep playing. If
  // that is wrong, the failure is not subtle -- a stale peer drops every
  // packet and the pair simply cannot connect, mid-match, with no way back.
  //
  // So this is the OLD decoder, transcribed from the release before this one,
  // pointed at a packet the NEW encoder produced. It knows nothing about
  // magic bytes, advantage, or thirty-two frames of history.
  const oldFletcher = (d: Uint8Array, len: number): number => {
    let a = 0, b = 0;
    for (let i = 0; i < len; i++) { a = (a + d[i]) % 255; b = (b + a) % 255; }
    return (b << 8) | a;
  };
  const oldDecode = (data: Uint8Array) => {
    if (data.length < 18) return null;
    const n = data[15];
    // The release before this one bounded `n` against a HISTORY of 16.
    if (data.length < 18 + n || n > 16) return null;
    if (oldFletcher(data, 16 + n) !== (data[16 + n] | (data[17 + n] << 8))) return null;
    if (data[1] > 1) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const bits: number[] = [];
    for (let i = 0; i < n; i++) bits.push(data[16 + i] & 7);
    return { slot: data[1], epoch: data[14], frame: view.getUint32(2),
             hashFrame: view.getUint32(6), hash: view.getUint32(10), bits };
  };

  const bits = Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 7);
  const packet = encodeInput({
    kind: Kind.Input, slot: 1, epoch: 9, frame: 1234, bits,
    hashFrame: 1200, hash: 0xdeadbeef,
    timing: { advantage: -7, sent: 123456, echo: 123000, held: 40 },
  });
  const old = oldDecode(packet);
  check("the old decoder accepts it", old !== null, true);
  check("and reads the frame", old?.frame, 1234);
  check("and the slot, epoch and digest",
        [old?.slot, old?.epoch, old?.hash], [1, 9, 0xdeadbeef]);
  check("and gets the newest sixteen frames of input, correctly",
        old?.bits, bits.slice(0, BODY_HISTORY));
  check("while a current client gets all thirty-two",
        (decode(packet) as { bits: number[] }).bits, bits);

  // And the reverse direction: a packet from a stale client has no trailer,
  // which the current decoder has to read as "no sample" rather than as zeros.
  const legacy = encodeInput({
    kind: Kind.Input, slot: 0, epoch: 3, frame: 77, bits: bits.slice(0, 16),
    hashFrame: 70, hash: 1,
  });
  const fresh = decode(legacy) as { bits: number[]; timing?: unknown };
  check("a packet with no trailer still decodes", fresh !== null, true);
  check("and carries no timing rather than empty timing",
        fresh.timing === undefined, true);
  check("with its input intact", fresh.bits, bits.slice(0, 16));
}

console.log("\na damaged trailer costs a clock sample, not the level");
{
  // The trailer carries timing and the back half of the input history, and it
  // rides OUTSIDE the body's checksum so that a client built before it existed
  // can still read the body. That is a deliberate trade and this is the test
  // that it was a safe one: the trailer has a checksum of its own, and a
  // trailer that fails it must be dropped on its own rather than taking a
  // perfectly good packet with it.
  //
  // The other half of the same worry is the advantage byte. It is a number the
  // PEER chooses, and it paces our clock -- so a peer that lies about it must
  // be able to make its partner run slightly slow and nothing worse. `decode`
  // clamps it; this proves the session survives the attempt.
  const rng = new Rng(13);
  const link = new Link(50, 10, 0, 17);
  let mangled = 0;
  link.damage = (d) => {
    // Input packets only: a command packet has no trailer to damage.
    if (d[0] !== 1 || d.length < 19) return d;
    const n = d[15];
    const body = 18 + n;
    if (d.length <= body) return d;
    if (rng.next() > 0.4) return d;
    mangled++;
    const copy = d.slice();
    // Somewhere in the trailer, including the advantage byte and the length.
    const at = body + Math.floor(rng.next() * (copy.length - body));
    copy[at] ^= 0xff;
    return copy;
  };

  const peers = pair(link, { rollback: true, timeSync: true });
  start(link, peers);
  run(link, peers, 900, held);
  converge(link, peers);

  check("trailers were actually damaged", mangled > 50, true);
  check("the session survived it", peers[0].session.frame > 800, true);
  check("the peers still agree", agreed(peers), "");
  check("no desyncs",
        peers[0].session.desyncs + peers[1].session.desyncs, 0);
  // A clamped advantage can still ask for a correction; what it must never do
  // is ask for one outside the band a person cannot see.
  check("and the clock was never driven outside its band",
        peers[0].session.dilation >= 0.95 && peers[0].session.dilation <= 1, true);
}

console.log("\nduplicated and reordered packets change nothing");
{
  const link = new Link(60, 80, 0, 11);      // jitter > latency reorders freely
  // Everything delivered twice. The receiver must treat the second copy as
  // news it already has, not as a second frame of input -- which is why
  // received input only ever fills gaps and never overwrites.
  link.duplicate = true;
  const peers = pair(link, { rollback: true });
  start(link, peers);
  run(link, peers, 700, held);
  converge(link, peers);
  check("the peers agree", agreed(peers), "");
  check("no desyncs",
        peers[0].session.desyncs + peers[1].session.desyncs, 0);
}

console.log("\ninput needs no retransmission; commands do");
{
  // Every COMMAND packet dropped for the first stretch of the game. Input is
  // untouched, because input heals itself -- this is about the messages that
  // do not.
  const link = new Link(60, 20, 0, 13);
  let dropping = true;
  link.blackhole = (d) => dropping && d[0] === Kind.Command;

  const peers = pair(link, { rollback: true });
  start(link, peers);
  // Start is a command too, so it has to get through for anything to begin.
  dropping = false;
  run(link, peers, 60, held);
  dropping = true;

  peers[0].session.send(Command.Pause);
  // Long enough that the first several resends are all eaten.
  run(link, peers, 8, held, 60);
  dropping = false;
  run(link, peers, 90, held, 68);
  converge(link, peers);

  check("both peers paused anyway",
        [peers[0].host.lv.pause, peers[1].host.lv.pause], [true, true]);
  check("and stayed in step", agreed(peers), "");
  console.log(`  ${link.dropped} of ${link.sent} packets dropped`);
}

console.log("\na command lost entirely still cannot half-apply");
{
  // Every command dropped forever after the start. The peer that pressed it
  // applies it; the other does not; and the digest check is what notices.
  const link = new Link(60, 0, 0, 17);
  const peers = pair(link, { rollback: true });
  start(link, peers);
  run(link, peers, 60, held);
  link.blackhole = (d) => d[0] === Kind.Command;

  peers[0].session.send(Command.Pause);
  run(link, peers, 200, held, 60);

  const split = peers[0].host.lv.pause !== peers[1].host.lv.pause;
  const noticed = peers[0].session.desyncs + peers[1].session.desyncs > 0;
  // Either they never split -- the command was applied on both sides before
  // anything could diverge -- or they split and the safety net saw it. What
  // must not happen is a silent, permanent disagreement.
  check("a permanently lost command does not go unnoticed",
        !split || noticed, true);
  console.log(`  split: ${split}, desyncs seen: ${noticed}`);
}

console.log("\na retry makes frame numbers ambiguous; the epoch settles it");
{
  // The case the epoch byte was added for. A long round trip means packets for
  // frames 190-200 of the OLD level are still in flight when the new one starts
  // at frame 0, and without an epoch they are filed as the new level's.
  const link = new Link(150, 40, 0.05, 19);
  const peers = pair(link, { rollback: true });
  start(link, peers);
  run(link, peers, 200, held);

  const before = peers[0].host.lv;
  peers[0].session.send(Command.Retry);
  run(link, peers, 120, held, 200);
  converge(link, peers);

  check("a new level was built", peers[0].host.lv !== before, true);
  check("both restarted", peers[0].session.frame < 150 &&
        peers[1].session.frame < 150, true);
  check("and they agree in it", agreed(peers), "");
  check("with no desyncs",
        peers[0].session.desyncs + peers[1].session.desyncs, 0);
  check("and no peer needed a full replay to recover",
        peers[0].session.rebuilds + peers[1].session.rebuilds, 0);
}

console.log("\nmemory does not grow with the length of a session");
{
  const link = new Link(75, 20, 0.05, 23);
  const peers = pair(link, { rollback: true });
  start(link, peers);
  run(link, peers, 400, held);
  const early = peers[0].session.snapshotBytes;
  run(link, peers, 3000, held, 400);
  const late = peers[0].session.snapshotBytes;
  console.log(`  ${(early / 1e6).toFixed(2)} MB after 400 frames, ` +
              `${(late / 1e6).toFixed(2)} MB after 3400`);
  // One snapshot, not a ring: the figure should be flat, not growing with the
  // frame count.
  check("the snapshot did not grow with the session", late <= early * 1.5, true);
}

console.log("\n" + (failures === 0
  ? "HOSTILE NETWORK PASSED"
  : `HOSTILE NETWORK FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
