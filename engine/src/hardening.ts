/**
 * The boundaries, tested as boundaries.
 *
 * Every other netcode test in this repository asks whether two honest peers
 * agree. This one asks what happens when one of them is not honest, or when the
 * data on disk is not what was written there, and it exists because an audit
 * found four places where the answer was "an exception, in the frame loop, on
 * the other person's machine".
 *
 * None of these are network conditions. Loss, jitter and corruption are already
 * covered -- `nethostile` damages packets in flight and the decoder's checksum
 * catches them. The gap was the packet that is PERFECTLY well formed and means
 * something impossible: a valid checksum over a Start command naming adventure
 * 240, a signalling message whose SDP is a number, a save whose `stats` is
 * null. A peer on an accepted friendship is authorized to send all of those.
 */
import { BroadcastTransport } from "./net/broadcast.js";
import { decodeSignal, encodeSignal, SIGNAL } from "./net/webrtc.js";
import { Command, Kind, encodeCommand } from "./net/protocol.js";
import { MODES, MODE_LEVELS, NetSession, startsSomething } from "./net/session.js";
import { LevelHost } from "./net/levelhost.js";
import { normaliseSave } from "./game/save.js";
import { assetUrl } from "./asseturl.js";
import { Transport } from "./net/transport.js";

let failures = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` +
              (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

// ---- a Start that names a level nobody has --------------------------------

console.log("a peer cannot start a level that does not exist");
{
  check("the three modes have the levels the map has",
        MODE_LEVELS, [17, 9, 6]);
  const impossible: [number, number][] = [
    [0, 0], [0, 18], [0, 255], [1, 10], [2, 7], [3, 1], [255, 1], [-1, 1],
    [0, 1.5], [0, NaN],
  ];
  check("none of these name anything",
        impossible.filter(([m, n]) => startsSomething(m, n)), []);
  check("and every real level does",
        MODES.flatMap((_, m) =>
          Array.from({ length: MODE_LEVELS[m] }, (_, i) => [m, i + 1]))
          .filter(([m, n]) => !startsSomething(m, n)), []);

  /** A transport that only ever hands the session what a test writes. */
  const inbox: ((d: Uint8Array) => void)[] = [];
  const silent: Transport = {
    rttMs: 0,
    send() { /* nothing is listening */ },
    onMessage(fn) { inbox.push(fn); },
    close() {},
  };

  const host = new LevelHost();
  const session = new NetSession({ slot: 0, host, transport: silent });
  // A well-formed Command packet, correct checksum and all, from the other
  // slot -- exactly what a peer running a modified client sends. Before
  // `startsSomething`, `MODES[240] ?? "adventure"` turned this into a request
  // to build adventure 240 and `level` dereferenced data that is not there.
  const hostile = encodeCommand({
    kind: Kind.Command, slot: 1, epoch: 0, frame: 0,
    command: Command.Start, a: 240, b: 240,
  });
  let threw: string | null = null;
  try {
    for (const fn of inbox) fn(hostile);
  } catch (e) {
    threw = (e as Error).message;
  }
  check("it is ignored rather than thrown on", threw, null);
  check("and no level was built", host.lv, null);
  check("so the session is not running", session.running, false);

  // And the same packet naming a real level still works, so the check is a
  // filter and not a wall.
  const honest = encodeCommand({
    kind: Kind.Command, slot: 1, epoch: 0, frame: 0,
    command: Command.Start, a: 1, b: 3,
  });
  for (const fn of inbox) fn(honest);
  check("a real one starts the level", session.running, true);
  check("the one it named", [host.lv?.CurrentMode, host.lv?.CurrentLevel],
        ["puzzle", 3]);
}

// ---- signalling that is the right shape and nothing else ------------------

console.log("\nsignalling messages are parsed, not cast");
{
  const wrap = (json: string): Uint8Array => {
    const body = new TextEncoder().encode(json);
    const out = new Uint8Array(body.length + 1);
    out[0] = SIGNAL;
    out.set(body, 1);
    return out;
  };

  const rubbish = [
    "null", "7", '"a string"', "[]", "[1,2,3]", "{}",
    '{"sdp":null}', '{"sdp":7}', '{"sdp":{}}', '{"sdp":{"type":"nonsense"}}',
    '{"sdp":{"type":"offer","sdp":42}}',
    '{"ice":null}', '{"ice":{}}', '{"ice":{"candidate":9}}',
    "not json at all",
  ];
  check("none of it decodes", rubbish.filter((j) => decodeSignal(wrap(j)) !== null),
        []);

  // Size, which is the other half: the queue and the browser API both take
  // whatever they are handed.
  const huge = wrap(JSON.stringify({
    sdp: { type: "offer", sdp: "v=0\r\n".repeat(20000) },
  }));
  check("an SDP the size of a video file does not decode",
        decodeSignal(huge), null);

  // And the two real shapes still round-trip.
  const offer = decodeSignal(encodeSignal({
    sdp: { type: "offer", sdp: "v=0" },
  }));
  check("a real offer survives", offer?.sdp?.type, "offer");
  const ice = decodeSignal(encodeSignal({
    ice: { candidate: "candidate:1 1 udp 1 1.2.3.4 1 typ host", sdpMLineIndex: 0 },
  }));
  check("and a real candidate", ice?.ice?.sdpMLineIndex, 0);
  // Nothing the sender added travels: the object is rebuilt from checked
  // fields, so a payload with an extra key arrives without it.
  const extra = decodeSignal(wrap(JSON.stringify({
    ice: { candidate: "candidate:1", evil: { toString() { return "x"; } } },
  })));
  check("and nothing else does", Object.keys(extra?.ice ?? {}).includes("evil"),
        false);
}

// ---- two tabs that drew the same number -----------------------------------

console.log("\ntwo tabs that draw the same id do not both become player two");
{
  // One in 16,777,215 per pairing, and a complete protocol failure when it
  // happens: `id < theirs` is false on both sides, both take slot 1, and the
  // session then drops every incoming packet as its own. Forced here rather
  // than waited for.
  const real = Math.random;
  const drawn: number[] = [];
  // The first two draws collide; everything after is distinct. Both tabs
  // re-draw on the tie, so this is the shortest run that settles.
  const sequence = [0.5, 0.5, 0.25, 0.75];
  let at = 0;
  Math.random = () => {
    const v = sequence[Math.min(at++, sequence.length - 1)];
    drawn.push(v);
    return v;
  };

  let slots: number[];
  try {
    const a = new BroadcastTransport("fbwg-hardening");
    const b = new BroadcastTransport("fbwg-hardening");
    slots = await Promise.all([a.pair(4000), b.pair(4000)]);
    a.close();
    b.close();
  } finally {
    Math.random = real;
  }

  check("they end up as different players", [...slots].sort(), [0, 1]);
}

// ---- a save that is not what was written -----------------------------------

console.log("\na corrupt save loads as a playable one");
{
  const cases: [string, unknown][] = [
    ["null", null],
    ["a number", 7],
    ["a string", "hello"],
    ["an array", [1, 2, 3]],
    ["stats: null", { stats: null }],
    ["stats: a string", { stats: "xxx" }],
    ["short arrays", { stats: [3, 2], times: [1], timesString: [""] }],
    ["long arrays", { stats: new Array(64).fill(3) }],
    ["holes", { stats: [3, undefined, null, "2", NaN, Infinity] }],
    ["out of range", { stats: [9, -9], times: [-5, 999999] }],
  ];
  const bad: string[] = [];
  for (const [name, value] of cases) {
    const { data } = normaliseSave(value);
    const ok = Array.isArray(data.stats) && data.stats.length === 32 &&
      Array.isArray(data.times) && data.times.length === 32 &&
      Array.isArray(data.timesString) && data.timesString.length === 32 &&
      data.stats.every((s: number) => Number.isInteger(s) && s >= -1 && s <= 3) &&
      data.times.every((t: number) => Number.isInteger(t) && t >= 0 && t <= 5999) &&
      data.timesString.every((s: string) => typeof s === "string") &&
      data.stats[0] >= 0;
    if (!ok) bad.push(name);
  }
  check("every one of them comes back usable", bad, []);

  // And a good save is not "repaired" into something else.
  const good = {
    submited: false,
    stats: [3, 0, ...new Array(30).fill(-1)],
    times: [41, 0, ...new Array(30).fill(0)],
    timesString: ["00:41", "", ...new Array(30).fill("")],
  };
  const kept = normaliseSave(good);
  check("a valid save is left alone", kept.repaired, false);
  check("with its medals intact", kept.data.stats.slice(0, 3), [3, 0, -1]);
  check("and its times", kept.data.times[0], 41);

  // The specific crash: `{"stats":null}` used to reach `stats.slice(...)`.
  check("the one that used to stop the game starting",
        normaliseSave({ stats: null }).data.stats[0], 0);
}

// ---- an asset base that carries a release marker ---------------------------

console.log("\nthe asset base can carry a release without breaking a path");
{
  check("a bare base joins as it always did",
        assetUrl("/extracted/assets", "sprites.json"),
        "/extracted/assets/sprites.json");
  check("a versioned one keeps the query on the end",
        assetUrl("/extracted/assets?v=abc123", "sprites.json"),
        "/extracted/assets/sprites.json?v=abc123");
  check("and does so for a nested path",
        assetUrl("/extracted/assets?v=abc123", "sprites/42/1.webp"),
        "/extracted/assets/sprites/42/1.webp?v=abc123");
  check("a trailing slash on the base is not doubled",
        assetUrl("/extracted/assets/?v=x", "/sounds.json"),
        "/extracted/assets/sounds.json?v=x");
}

console.log("\n" + (failures === 0 ? "HARDENING PASSED"
                                   : `HARDENING FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
