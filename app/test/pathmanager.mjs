/** Deterministic path-control/loss tests; no account, browser or wall-clock sleeps. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { NetSession } from "../../engine/dist/net/session.js";
import { LevelHost } from "../../engine/dist/net/levelhost.js";
import { decode as decodePacket } from "../../engine/dist/net/protocol.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bundle = await build({ stdin: { resolveDir: root, sourcefile: "pathmanager-test-entry.ts", contents:
  'export * from "./app/src/net/pathmanager.ts"; export { PairChannel } from "./app/src/net/pairchannel.ts"; export { scopedChannel } from "./app/src/net/scope.ts";' },
  bundle: true, write: false, platform: "node", format: "esm",
  alias: { "@engine": resolve(root, "engine/src") }, plugins: [{ name: "local-pair-channel", setup(builder) {
    builder.onResolve({ filter: /^\.\.\/supabase\.js$/ }, () => ({ path: "supabase-stub", namespace: "pair-test" }));
    builder.onLoad({ filter: /.*/, namespace: "pair-test" }, () => ({ contents: "export const supabase = { removeChannel: async () => {} };" }));
  } }] });
const { PathManager, PairChannel, scopedChannel } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const encode = bytes => Buffer.from(bytes).toString("base64");
const decode = bytes => new Uint8Array(Buffer.from(bytes, "base64"));
const json = bytes => { try { return JSON.parse(new TextDecoder().decode(bytes.subarray(bytes.indexOf(0xfc) + 1))); } catch { return null; } };
const stats = () => ({ sentPackets: 0, receivedPackets: 0, sentBytes: 0, receivedBytes: 0,
  droppedPackets: 0, queueSamples: 0, queueTotalMs: 0, queueMaxMs: 0, bufferedBytes: 0 });

class Clock {
  at = 0; serial = 0; jobs = new Map();
  now = () => this.at;
  setTimeout = (fn, ms) => { const id = ++this.serial; this.jobs.set(id, { at: this.at + Math.max(0, ms), fn }); return id; };
  clearTimeout = id => this.jobs.delete(id);
  async microtasks() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
  async advance(ms) {
    const until = this.at + ms;
    for (let count = 0; count < 100000; count++) {
      await this.microtasks();
      const next = [...this.jobs].filter(([, j]) => j.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) { this.at = until; await this.microtasks(); return; }
      this.at = next[1].at; this.jobs.delete(next[0]); next[1].fn();
    }
    throw new Error("unbounded timer/control loop");
  }
  async until(check, limit = 10000) {
    for (let i = 0; i <= limit; i += 50) { await this.advance(50); if (check()) return; }
    assert.ok(check(), "condition did not become true within simulated time");
  }
}
function channels(time) {
  const pair = [0, 1].map(side => ({ handlers: new Set(), statuses: new Set(), sent: [], up: true,
    onBytes(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); },
    onStatus(fn) { this.statuses.add(fn); return () => this.statuses.delete(fn); },
    sendBytes(packets) {
      for (const packet of packets) {
        const bytes = decode(packet); this.sent.push(bytes);
        if (!this.up || !pair[1 - side].up || pair.drop?.(side, bytes)) continue;
        time.setTimeout(() => { for (const fn of pair[1 - side].handlers) fn(bytes.slice()); }, 1);
      }
    },
    status(value) { this.up = value === "SUBSCRIBED"; for (const fn of [...this.statuses]) fn(value); },
  }));
  return pair;
}
function transports(time, label, delay = 1) {
  const pair = [0, 1].map(side => ({ name: `${label}:${side}`, stats: stats(), rttMs: delay * 2, pacingMs: 0,
    open: true, closed: 0, message: null, lost: null, data: [], discarded: 0,
    send(bytes) {
      this.stats.sentPackets++; this.stats.sentBytes += bytes.length; this.data.push(bytes.slice());
      if (!this.open || !pair[1 - side].open || pair.drop?.(side, bytes)) return;
      time.setTimeout(() => {
        const peer = pair[1 - side]; if (!peer.open) return;
        peer.stats.receivedPackets++; peer.stats.receivedBytes += bytes.length;
        peer.message?.(bytes.slice());
      }, typeof pair.delay === "function" ? pair.delay(side, bytes) : delay);
    },
    onMessage(fn) { this.message = fn; }, onClosed(fn) { this.lost = fn; },
    discardPending() { this.discarded++; },
    fail() { this.open = false; this.lost?.("injected physical failure"); },
    close() { this.open = false; this.closed++; this.message = null; this.lost = null; },
  }));
  return pair;
}
function fixture(options = {}) {
  const time = new Clock(), channel = channels(time), relay = transports(time, "relay", 35);
  const managers = [], rtc = [], waiting = new Map(), closed = [0, 0];
  let nonce = 0;
  for (let side = 0; side < 2; side++) {
    managers.push(new PathManager(channel[side], side === 0, { relay: relay[side], clock: time,
      nonce: () => `00000000-0000-4000-8000-${(++nonce).toString().padStart(12, "0")}`,
      retryDelaysMs: [250, 500], timeoutMs: 1000, handoverMs: 500, maxAttempts: 6,
      createRTC: async (signaling, caller, signal) => {
        const generation = managers[side].attempts;
        if (options.rejectRTC) throw new Error("ICE unavailable");
        if (!rtc[generation - 1]) rtc[generation - 1] = transports(time, `rtc${generation}`);
        const connection = rtc[generation - 1];
        options.configureRTC?.(connection, generation);
        await new Promise((ok, fail) => {
          signal.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
          if (waiting.has(generation)) { const other = waiting.get(generation); waiting.delete(generation); other(); ok(); }
          else waiting.set(generation, ok);
        });
        return connection[side];
      }, ...options.managerOptions }));
    managers[side].onClosed(() => closed[side]++);
  }
  const bothRTC = () => managers.every(manager => manager.state === "RTC_ACTIVE");
  return { time, channel, relay, managers, rtc, closed, bothRTC,
    async close() { managers.forEach(m => m.close()); await time.advance(7000);
      assert.equal(time.jobs.size, 0, "closed manager leaked timers");
      for (const c of channel) { assert.equal(c.handlers.size, 0); assert.equal(c.statuses.size, 0); }
      for (const pair of rtc) for (const p of pair) assert.equal(p.closed, 1, "RTC was not retired exactly once");
    } };
}

// Lane ownership: RTC negotiation never takes over the gameplay receiver.
{
  const time = new Clock(), channel = channels(time), received = [], closed = [0, 0];
  const managers = channel.map((ch, side) => new PathManager(ch, side === 0, {
    clock: time, maxAttempts: 1, nonce: () => "00000000-0000-4000-8000-000000000001",
    createRTC: async () => { throw new Error("STUN-only NAT refusal"); },
  }));
  managers.forEach((m, side) => m.onClosed(() => closed[side]++));
  managers[1].onMessage(bytes => received.push([...bytes]));
  managers[0].send(new Uint8Array([2, 45]));
  await time.advance(100);
  assert.deepEqual(received, [[2, 45]]);
  assert.ok(channel[0].sent.some(bytes => new TextDecoder().decode(bytes).startsWith("path-v1:gameplay:")));
  assert.ok(channel[0].sent.some(bytes => new TextDecoder().decode(bytes).startsWith("path-v1:control:")));
  channel.forEach(c => { for (const fn of c.statuses) fn("CONTROL_TIMEOUT"); });
  assert.deepEqual(closed, [0, 0], "a social receipt timeout killed a usable gameplay relay");
  managers.forEach(m => m.close()); await time.advance(200);
  assert.equal(time.jobs.size, 0);
  channel.forEach(c => { assert.equal(c.handlers.size, 0); assert.equal(c.statuses.size, 0); });
}
{
  const f = fixture(); const received = [];
  f.managers[1].onMessage(data => received.push([...data]));
  f.managers[0].send(new Uint8Array([2, 99]));
  await f.time.until(f.bothRTC);
  await f.time.advance(100);
  assert.deepEqual(received, [[2, 99]], "gameplay was stolen by signaling");
  assert.equal(f.channel[0].handlers.size, 2, "only control and the current signaling attempt stay subscribed");
  await f.close();
}

// Loss and reordering of ACCEPT/HELLO/ACK/READY/ACTIVE cannot create a handover hole.
{
  let accepts = 0, ackDrops = 0, activeDrops = 0;
  const f = fixture({ configureRTC(pair) {
    pair.drop = (side, bytes) => {
      const msg = json(bytes);
      if (msg?.t === "PATH_ACK" && side === 1 && ackDrops++ < 4) return true;
      if (msg?.t === "PATH_ACTIVE" && side === 0 && activeDrops++ < 4) return true;
      return false;
    };
    pair.delay = (_, bytes) => json(bytes)?.t === "PATH_HELLO" ? 12 : 1;
  } });
  f.channel.drop = (_, bytes) => json(bytes)?.t === "ACCEPT" && accepts++ < 2;
  const received = [[], []]; f.managers.forEach((m, side) => m.onMessage(bytes => received[side].push(bytes[1])));
  for (let i = 1; i <= 70; i++) {
    f.managers.forEach(m => m.send(new Uint8Array([1, i]))); await f.time.advance(50);
  }
  await f.time.until(f.bothRTC);
  await f.time.advance(2200);
  assert.ok(f.managers.every(m => m.duplicates > 0), "overlap did not deduplicate");
  assert.deepEqual(received[0], Array.from({ length: 70 }, (_, i) => i + 1));
  assert.deepEqual(received[1], Array.from({ length: 70 }, (_, i) => i + 1));
  const sent = f.relay.map(t => t.data.length);
  f.managers[0].send(new Uint8Array([2, 222])); await f.time.advance(100);
  assert.deepEqual(f.relay.map(t => t.data.length), sent, "promoted RTC still published relay gameplay");
  await f.close();
}

// Only the callee receives a close event; lost RETRY controls are retried.
{
  const f = fixture(); await f.time.until(f.bothRTC); await f.time.advance(1000);
  let requests = 0; f.channel.drop = (_, data) => json(data)?.t === "RETRY" && requests++ < 2;
  const original = [...f.managers], old = f.rtc[0];
  old[1].fail();
  assert.equal(f.managers[1].kind, "relay", "RTC failure did not fall back synchronously");
  f.managers[1].send(new Uint8Array([2, 88]));
  assert.equal(f.relay[1].data.at(-1)[1], 88);
  await f.time.until(() => f.bothRTC() && f.rtc.length === 2);
  assert.deepEqual(f.managers, original); assert.deepEqual(f.closed, [0, 0]);
  // A delayed failure message from the old path cannot kill its replacement.
  const stale = f.channel[1].sent.find(data => json(data)?.t === "RETRY");
  f.channel[1].sendBytes([encode(stale)]); await f.time.advance(200);
  assert.ok(f.bothRTC()); assert.equal(f.rtc.length, 2);
  const oldAck = old[1].data.find(data => json(data)?.t === "PATH_ACK");
  // A valid old nonce on the NEW physical RTC must still be refused.
  f.rtc[1][1].send(oldAck); await f.time.advance(50);
  assert.ok(f.bothRTC()); assert.equal(f.rtc.length, 2);
  await f.close();
}

// The caller alone notices failure; a fresh nonce makes the callee switch too.
{
  const f = fixture(); await f.time.until(f.bothRTC); f.rtc[0][0].fail();
  await f.time.until(() => f.bothRTC() && f.rtc.length === 2);
  assert.deepEqual(f.closed, [0, 0]); await f.close();
}

// Signaling/relay outages do not kill a healthy RTC. A later all-path outage fires once.
{
  const f = fixture(); await f.time.until(f.bothRTC); await f.time.advance(700);
  f.channel.forEach(c => c.status("CLOSED"));
  await f.time.advance(7000);
  assert.ok(f.bothRTC()); assert.deepEqual(f.closed, [0, 0]);
  f.channel.forEach(c => c.status("SUBSCRIBED"));
  f.rtc[0][0].fail(); await f.time.until(() => f.bothRTC() && f.rtc.length === 2);
  f.channel.forEach(c => c.status("CHANNEL_ERROR"));
  f.rtc[1].forEach(t => t.fail());
  assert.deepEqual(f.closed, [1, 1]); f.channel.forEach(c => c.status("CLOSED"));
  assert.deepEqual(f.closed, [1, 1]); await f.close();
}

// A silently broken one-way RTC is detected by bounded path-heartbeat timeouts.
{
  const f = fixture(); await f.time.until(f.bothRTC); await f.time.advance(700);
  f.rtc[0].drop = side => side === 0;
  await f.time.until(() => f.bothRTC() && f.rtc.length === 2, 12000);
  assert.deepEqual(f.closed, [0, 0]); await f.close();
}

// Suspect mode protects gameplay before the hard timeout, including asymmetric
// failures where only the receiving peer can detect the missing RTC traffic.
const silentResults = [];
for (const direction of ["outbound", "inbound", "two-way"]) {
  const f = fixture(); await f.time.until(f.bothRTC); await f.time.advance(700);
  const received = [[], []];
  f.managers.forEach((m, side) => m.onMessage(bytes => received[side].push(bytes[1])));
  f.managers.forEach((m, side) => m.send(new Uint8Array([2, 10 + side])));
  await f.time.advance(100); received.forEach(list => { list.length = 0; });
  const old = f.rtc[0], stale = old[1].message, started = f.time.now();
  old.drop = side => direction === "two-way" || side === (direction === "outbound" ? 0 : 1);
  await f.time.until(() => f.managers.every(m => m.state === "RTC_SUSPECT"), 2500);
  const protectionMs = f.time.now() - started;
  assert.ok(protectionMs <= 1800, `${direction}: protection took ${protectionMs}ms`);
  const before = f.relay.map(t => t.data.length);
  f.managers.forEach((m, side) => m.send(new Uint8Array([2, 100 + side])));
  await f.time.advance(100);
  assert.deepEqual(received, [[101], [100]], `${direction}: relay did not protect both peers`);
  assert.ok(f.relay.every((t, side) => t.data.length > before[side]));
  await f.time.until(() => f.bothRTC() && f.rtc.length === 2, 9000);
  const freshMs = f.time.now() - started;
  assert.ok(freshMs <= 8000, `${direction}: fresh RTC took ${freshMs}ms`);
  assert.ok(old.every(t => t.closed === 1), "old RTC was not retired");
  stale(new Uint8Array([2, 222]));
  assert.deepEqual(received, [[101], [100]], "retired RTC delivered stale gameplay");
  await f.time.advance(1000);
  const relayCount = f.relay.map(t => t.data.length);
  f.managers.forEach((m, side) => m.send(new Uint8Array([2, 110 + side])));
  await f.time.advance(100);
  assert.deepEqual(f.relay.map(t => t.data.length), relayCount, "fresh RTC kept publishing relay gameplay");
  assert.deepEqual(received, [[101, 111], [100, 110]]);
  assert.deepEqual(f.closed, [0, 0]);
  silentResults.push({ direction, protectionMs, freshMs });
  await f.close();
}

// A short gap never starts relay. Recovery before the hard timeout stops relay
// after two separated RTC observations, and a second gap does not flap instantly.
{
  const f = fixture(); await f.time.until(f.bothRTC); await f.time.advance(700);
  const received = []; f.managers[1].onMessage(bytes => received.push(bytes[1]));
  f.managers.forEach((m, side) => m.send(new Uint8Array([2, 10 + side])));
  await f.time.advance(100); received.length = 0;
  f.rtc[0].drop = () => true;
  await f.time.advance(1000);
  assert.ok(f.bothRTC(), "transient loss entered suspect mode");
  f.rtc[0].drop = null; await f.time.advance(500);
  assert.ok(f.bothRTC(), "transient recovery changed the path");
  f.rtc[0].drop = () => true;
  await f.time.until(() => f.managers.every(m => m.state === "RTC_SUSPECT"), 2500);
  f.managers[0].send(new Uint8Array([2, 150])); await f.time.advance(100);
  assert.deepEqual(received, [150]);
  const attempts = f.managers.map(m => m.attempts);
  let offDrops = 0;
  f.channel.drop = (_, data) => json(data)?.t === "RELAY_OFF" && offDrops++ < 2;
  f.rtc[0].drop = null;
  await f.time.until(f.bothRTC, 4000);
  assert.equal(offDrops, 2, "recovery lease fixture did not lose both OFF controls");
  assert.deepEqual(f.managers.map(m => m.attempts), attempts, "recovery made an unnecessary RTC");
  await f.time.advance(1600);
  const relayCount = f.relay.map(t => t.data.length);
  f.managers[0].send(new Uint8Array([2, 151])); await f.time.advance(100);
  assert.deepEqual(received, [150, 151], "overlap delivered duplicate gameplay");
  assert.deepEqual(f.relay.map(t => t.data.length), relayCount, "relay continued after recovery");
  assert.deepEqual(f.closed, [0, 0]); await f.close();
}

// All attempts fail: the same emergency session remains usable, and retries stop.
{
  const f = fixture({ rejectRTC: true, managerOptions: { maxAttempts: 3 } });
  await f.time.advance(40000);
  assert.equal(f.managers[0].attempts, 3); assert.equal(f.managers[1].attempts, 3);
  assert.ok(f.managers.every(m => m.state === "RELAY_ACTIVE")); assert.deepEqual(f.closed, [0, 0]);
  const counts = f.channel.map(c => c.sent.length);
  await f.time.advance(90000);
  assert.deepEqual(f.channel.map(c => c.sent.length), counts, "exhausted attempt kept spending signaling messages");
  await f.close();
}

// Lost promotion confirmation cannot leave an unbounded dual-send state.
{
  const f = fixture({ configureRTC(pair) {
    pair.drop = (side, bytes) => side === 0 && json(bytes)?.t === "PATH_ACTIVE";
  }, managerOptions: { maxAttempts: 2 } });
  const received = []; f.managers[1].onMessage(bytes => received.push(bytes[1]));
  await f.time.until(f.bothRTC);
  for (let i = 0; i < 120; i++) { f.managers[0].send(new Uint8Array([2, i])); await f.time.advance(100); }
  assert.ok(f.managers.every(m => m.state === "RELAY_ACTIVE"), "unconfirmed promotion never stopped dual sending");
  assert.ok(received.length > 100, "unconfirmed promotion cut off gameplay");
  assert.deepEqual(f.closed, [0, 0]); await f.close();
}

// Closing while a credential/RTC promise is pending retires even a late result.
{
  const time = new Clock(), channel = channels(time), relay = transports(time, "relay");
  const pending = [], rtc = transports(time, "late"); let nonce = 0;
  const managers = [0, 1].map(side => new PathManager(channel[side], side === 0, {
    relay: relay[side], clock: time,
    nonce: () => `00000000-0000-4000-8000-${(++nonce).toString().padStart(12, "0")}`,
    createRTC: () => new Promise(ok => { pending[side] = ok; }),
  }));
  await time.advance(100); managers.forEach(m => m.close());
  pending.forEach((ok, side) => ok(rtc[side])); await time.advance(10000);
  assert.ok(rtc.every(t => t.closed === 1)); assert.equal(time.jobs.size, 0);
  channel.forEach(c => { assert.equal(c.handlers.size, 0); assert.equal(c.statuses.size, 0); });
}

// Actual deterministic LevelHost/NetSession objects survive RTC -> relay -> RTC.
async function game(migrate) {
  const f = fixture(); await f.time.until(f.bothRTC); await f.time.advance(700);
  const peers = f.managers.map((transport, slot) => {
    const host = new LevelHost();
    const session = new NetSession({ host, slot, transport, rollback: true, delay: 0,
      onLinkDown: () => f.closed[slot]++ });
    return { host, session };
  });
  peers[0].session.requestStart("adventure", 1); await f.time.advance(40);
  for (let frame = 0; frame < 340; frame++) {
    if (migrate && frame === 55) f.rtc[0][1].fail();
    if (migrate === "silent" && frame === 55) f.rtc[0].drop = () => true;
    for (const [slot, p] of peers.entries()) {
      p.session.setLocalInput((frame > 10 && frame < 24) ||
        (frame > 65 && frame < 90) ? (slot ? 1 : 2) : 0);
      p.session.tick(1 / 26);
    }
    await f.time.advance(1000 / 26);
  }
  for (const p of peers) p.session.tick(0);
  const result = peers.map(p => ({ hash: p.host.hash(), frame: p.session.frame,
    generation: p.session.generation, runSerial: p.session.runSerial, desyncs: p.session.desyncs }));
  assert.equal(result[0].hash, result[1].hash, "managed peers desynced");
  assert.equal(result[0].generation, result[1].generation);
  assert.ok(result.every(p => p.frame >= 335 && p.desyncs === 0 && p.runSerial === 1));
  assert.deepEqual(f.closed, [0, 0]); if (migrate) assert.ok(f.rtc.length >= 2);
  const quality = peers.map(p => ({ stalls: p.session.stalls, rollbacks: p.session.rollbacks,
    deepestRollback: p.session.deepestRollback }));
  await f.close(); return { result, quality };
}
const baseline = await game(false), migrated = await game(true), silentGame = await game("silent");
assert.deepEqual(migrated.result, baseline.result, "path migration changed the final deterministic session state");
assert.deepEqual(silentGame.result, baseline.result, "silent failure changed the final deterministic session state");

// Several failures in one logical game. Keep the real sessions and hosts alive
// while the physical RTC generations change, and measure every relay interval.
async function repeatedGame(sequence) {
  const f = fixture({ managerOptions: { retryDelaysMs: [1000, 2000, 5000] } });
  await f.time.until(f.bothRTC); await f.time.advance(700);
  const peers = f.managers.map((transport, slot) => {
    const host = new LevelHost();
    const session = new NetSession({ host, slot, transport, rollback: true, delay: 0,
      onLinkDown: () => f.closed[slot]++ });
    return { host, session };
  });
  peers[0].session.requestStart("adventure", 1);
  const identity = peers.map(p => ({ session: p.session, host: p.host }));
  let steps = 0, maxNoProgressMs = 0;
  const lastProgressAt = [f.time.now(), f.time.now()];
  const lastRelayAt = [-Infinity, -Infinity];
  const relayWindowStart = [null, null];
  const relaySeen = f.relay.map(t => t.stats.receivedPackets);
  const lastFrame = peers.map(p => p.session.frame);
  const lastConfirmed = peers.map(p => p.session.confirmed);
  async function step() {
    const dt = 1000 / 26;
    for (const [slot, p] of peers.entries()) {
      p.session.setLocalInput(steps % 150 < 18 ? (slot ? 1 : 2) : 0);
      p.session.tick(1 / 26);
    }
    await f.time.advance(dt);
    steps++;
    for (let side = 0; side < 2; side++) {
      const p = peers[side].session;
      const received = f.relay[side].stats.receivedPackets > relaySeen[side];
      if (f.managers[side].kind !== "relay") relayWindowStart[side] = null;
      if (received) {
        lastRelayAt[side] = f.time.now();
        relayWindowStart[side] ??= f.time.now();
      }
      if (p.frame > lastFrame[side] && p.confirmed > lastConfirmed[side])
        lastProgressAt[side] = f.time.now();
      const gap = f.time.now() - Math.max(lastProgressAt[side], relayWindowStart[side] ?? f.time.now());
      if (f.time.now() - lastRelayAt[side] <= 1000 && f.managers[side].kind === "relay")
        maxNoProgressMs = Math.max(maxNoProgressMs, gap);
      assert.ok(f.time.now() - lastRelayAt[side] > 1000 ||
        f.managers[side].kind !== "relay" || gap < 2000,
        `${sequence.join(" -> ")}: relay arrives but peer ${side} cannot advance: ${JSON.stringify({
          frame: p.frame, confirmed: p.confirmed, lastRemoteFrame: p.lastRemoteFrame,
          nextLocal: p.nextLocal, attempts: f.managers[side].attempts,
          state: f.managers[side].state,
          relayReceived: f.relay[side].stats.receivedPackets,
          lastInputFrame: f.managers[side].lastInput && new DataView(
            f.managers[side].lastInput.buffer).getUint32(2),
        })}`);
      relaySeen[side] = f.relay[side].stats.receivedPackets;
      lastFrame[side] = p.frame; lastConfirmed[side] = p.confirmed;
    }
  }
  async function until(check, limitMs = 20000) {
    const deadline = f.time.now() + limitMs;
    while (!check() && f.time.now() < deadline) await step();
    assert.ok(check(), `${sequence.join(" -> ")}: timed out at ${JSON.stringify(
      f.managers.map(m => ({ state: m.state, kind: m.kind, attempts: m.attempts,
        spent: m.spent, nextAttempt: m.nextAttempt, frame: peers[f.managers.indexOf(m)].session.frame,
        confirmed: peers[f.managers.indexOf(m)].session.confirmed })))}`);
  }
  await until(() => peers.every(p => p.session.frame > 60));
  const migrations = [];
  const retired = [];
  for (const mode of sequence) {
    await until(() => f.bothRTC() && f.managers.every(m => m.kind === "webrtc"));
    const before = peers.map(p => ({ frame: p.session.frame, confirmed: p.session.confirmed }));
    const attempts = f.managers.map(m => m.attempts);
    const old = f.rtc.at(-1);
    const stale = old.map(t => ({ deliver: t.message,
      bytes: t.data.find(data => data[0] === 1)?.slice() }));
    retired.push(...stale);
    const relayBefore = f.relay.map(t => ({ sent: t.stats.sentPackets, received: t.stats.receivedPackets }));
    const started = f.time.now();
    if (mode === "close") old[1].fail();
    else old.drop = side => mode === "one-way" ? side === 0 : true;
    await until(() => f.managers.every(m => m.kind === "relay"), 3500);
    const protectionMs = f.time.now() - started;
    const expectedDelay = [1000, 2000, 5000][Math.min(attempts[0] - 1, 2)];
    if (mode === "close") assert.ok(Math.abs(f.managers[0].nextAttempt - started - expectedDelay) < 100,
      `${mode}: retry backoff did not advance with the spent budget`);
    await until(() => f.bothRTC() && f.managers.every((m, side) => m.attempts > attempts[side]), 20000);
    const freshMs = f.time.now() - started;
    if (mode !== "close") assert.ok(freshMs >= 6000 + expectedDelay - 500,
      `${mode}: hard retirement skipped the expected retry backoff`);
    assert.ok(f.managers.every(m => m.spent === m.attempts),
      `${mode}: retry budget reset before a long healthy RTC period`);
    assert.ok(peers.every((p, side) => p.session.frame > before[side].frame &&
      p.session.confirmed > before[side].confirmed), `${mode}: no relay frame/confirmed progress ${JSON.stringify({
        before, after: peers.map(p => ({ frame: p.session.frame, confirmed: p.session.confirmed,
          lastRemoteFrame: p.session.lastRemoteFrame, nextLocal: p.session.nextLocal })),
        paths: f.managers.map(m => ({ state: m.state, attempts: m.attempts,
          lastInputFrame: m.lastInput && new DataView(m.lastInput.buffer).getUint32(2) })) })}`);
    assert.ok(f.relay.every((t, side) => t.stats.sentPackets > relayBefore[side].sent &&
      t.stats.receivedPackets > relayBefore[side].received), `${mode}: gameplay did not cross relay`);
    if (mode === "one-way") {
      const missing = before[1].confirmed;
      const covering = f.relay[0].data.slice(relayBefore[0].sent).map(decodePacket).some(packet =>
        packet?.kind === 1 && packet.frame >= missing &&
        packet.frame - packet.bits.length + 1 <= missing);
      assert.ok(covering, `one-way relay did not carry missing frame ${missing}`);
    }
    assert.ok(peers.every((p, side) => p.session === identity[side].session &&
      p.host === identity[side].host && p.session.generation === 1 &&
      p.session.runSerial === 1 && p.session.desyncs === 0), `${mode}: logical game changed`);
    for (const item of retired) {
      if (!item.deliver || !item.bytes) continue;
      const manager = f.managers[retired.indexOf(item) % 2];
      const receiver = manager.receiver;
      let delivered = 0;
      manager.receiver = data => { delivered++; receiver(data); };
      item.deliver(item.bytes);
      manager.receiver = receiver;
      assert.equal(delivered, 0, `${mode}: old RTC delivered gameplay`);
    }
    await step();
    assert.deepEqual(f.closed, [0, 0], `${mode}: link-down callback`);
    await until(() => f.managers.every(m => m.state === "RTC_ACTIVE"), 3000);
    for (let i = 0; i < 40; i++) await step();
    const sent = f.relay.map(t => t.stats.sentPackets);
    for (let i = 0; i < 20; i++) await step();
    assert.deepEqual(f.relay.map(t => t.stats.sentPackets), sent,
      `${mode}: relay published after promotion`);
    migrations.push({ mode, protectionMs, freshMs });
    assert.ok(f.managers.every(m => m.recentInputs.length <= 8 &&
      m.recentInputs.reduce((bytes, item) => bytes + item.data.length, 0) <= 8 * 256),
    `${mode}: replay history exceeded its memory bound`);
  }
  for (let i = 0; i < 80; i++) await step();
  peers.forEach(p => p.session.tick(0));
  assert.equal(peers[0].host.hash(), peers[1].host.hash(), "repeated migration diverged");
  const quality = peers.map(p => ({ frame: p.session.frame, confirmed: p.session.confirmed,
    stalls: p.session.stalls, rollbacks: p.session.rollbacks,
    deepestRollback: p.session.deepestRollback, desyncs: p.session.desyncs }));
  await f.close();
  return { sequence, migrations, maxNoProgressMs, quality };
}
const repeatedResults = [];
const repetitions = Number(process.env.FBWG_PATH_REPETITIONS ?? "1");
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 100);
for (let repetition = 0; repetition < repetitions; repetition++) {
  for (const sequence of [["close", "silent", "close"], ["silent", "close", "one-way"]])
    repeatedResults.push(await repeatedGame(sequence));
}
const repeatedSummary = {
  repetitions, sequences: repeatedResults.length,
  maxNoProgressMs: Math.max(...repeatedResults.map(result => result.maxNoProgressMs)),
  maxRelayProtectionMs: Math.max(...repeatedResults.flatMap(result =>
    result.migrations.map(migration => migration.protectionMs))),
  maxFreshRtcMs: Math.max(...repeatedResults.flatMap(result =>
    result.migrations.map(migration => migration.freshMs))),
  maxRollbackCount: Math.max(...repeatedResults.flatMap(result =>
    result.quality.map(peer => peer.rollbacks))),
  deepestRollback: Math.max(...repeatedResults.flatMap(result =>
    result.quality.map(peer => peer.deepestRollback))),
  desyncs: repeatedResults.reduce((total, result) => total +
    result.quality.reduce((sum, peer) => sum + peer.desyncs, 0), 0),
};

// Replay storage has a fixed bound and old-epoch snapshots age out as new
// input arrives. It is cleared with the transport, including after retries.
{
  const f = fixture(); await f.time.until(f.bothRTC);
  for (let i = 0; i < 30; i++) {
    const packet = new Uint8Array(18);
    packet[0] = 1; packet[14] = i < 10 ? 1 : 2; packet[2] = i;
    f.managers[0].send(packet);
    await f.time.advance(500);
  }
  assert.equal(f.managers[0].recentInputs.length, 8);
  assert.ok(f.managers[0].recentInputs.every(item => item.data[14] === 2),
    "old-epoch replay snapshots remained after the bounded window moved");
  await f.close();
  assert.equal(f.managers[0].recentInputs.length, 0);
}

// Use the actual PairChannel.sendBytes/flushHeld buffering during a two-second
// WebSocket outage. The final history packet must survive both path-control
// retries and an SDP/ICE burst, even when both sessions have already stalled.
{
  const time = new Clock(), pairs = [], managers = [], down = [0, 0];
  const lives = [0, 1].map(side => ({ state: "joined", sent: [], async send(message) {
    this.sent.push(message);
    if (lives[1 - side].state !== "joined") return "ok";
    for (const packet of message.payload.data.p) time.setTimeout(() => {
      for (const fn of pairs[1 - side].byteHandlers) fn(decode(packet));
    }, 5);
    return "ok";
  } }));
  for (let side = 0; side < 2; side++) {
    pairs.push(new PairChannel("pair:a:b", lives[side], { userId: side ? "b" : "a", username: `peer${side}`, activity: "in_game" }));
  }
  const relays = pairs.map(pair => {
    const lane = scopedChannel(scopedChannel(pair, "level-attempt"), "path-v1", "gameplay");
    let off;
    return { rttMs: 10, send(data) { lane.sendBytes([encode(data)]); },
      onMessage(fn) { off = lane.onBytes(fn); }, close() { off?.(); } };
  });
  pairs.forEach((pair, side) => managers.push(new PathManager(scopedChannel(pair, "level-attempt"), side === 0,
    { relay: relays[side], clock: time, retryDelaysMs: [100, 200],
      createRTC: async () => { throw new Error("no ICE route"); } })));
  const peers = managers.map((transport, slot) => {
    const host = new LevelHost();
    return { host, session: new NetSession({ host, slot, transport, rollback: true, delay: 0,
      onLinkDown: () => down[slot]++ }) };
  });
  peers[0].session.requestStart("adventure", 1); await time.advance(10);
  for (let i = 0; i < 20; i++) { peers.forEach(p => p.session.tick(1 / 26)); await time.advance(1000 / 26); }
  lives.forEach(live => { live.state = "joining"; });
  for (let i = 0; i < 52; i++) { peers.forEach(p => p.session.tick(1 / 26)); await time.advance(1000 / 26); }
  assert.ok(peers.every(p => p.session.stalls > 0), "outage fixture never stalled");
  const frames = peers.map(p => p.session.frame);
  for (const pair of pairs) {
    // These exact lanes used to overwrite the single heldBytes slot.
    scopedChannel(scopedChannel(pair, "level-attempt"), "extra", "control").sendBytes([encode(new Uint8Array([0xfc, 1]))]);
    const signal = scopedChannel(scopedChannel(pair, "level-attempt"), "extra", "signaling");
    signal.sendBytes([encode(new Uint8Array([0xfd, 10]))]);
    signal.sendBytes([encode(new Uint8Array([0xfd, 11]))]);
    assert.ok(pair.heldBytes.get("gameplay")?.length, "signaling evicted the final input history");
    assert.equal(pair.heldBytes.get("signaling")?.length, 2, "a late ICE candidate evicted the offer");
  }
  lives.forEach(live => { live.state = "joined"; });
  pairs.forEach(pair => pair.flushHeld()); await time.advance(10);
  for (let i = 0; i < 80; i++) { peers.forEach(p => p.session.tick(1 / 26)); await time.advance(1000 / 26); }
  peers.forEach(p => p.session.tick(0));
  assert.ok(peers.every((p, side) => p.session.frame > frames[side] + 50), "buffered final input did not heal the stall");
  assert.equal(peers[0].host.hash(), peers[1].host.hash());
  assert.ok(peers.every(p => p.session.generation === 1 && p.session.runSerial === 1 && p.session.desyncs === 0));
  assert.deepEqual(down, [0, 0]);
  managers.forEach(m => m.close()); await Promise.all(pairs.map(pair => pair.close())); await time.advance(10000);
  assert.equal(time.jobs.size, 0);
}
console.log(JSON.stringify({ scope: "Deterministic physical-path simulator with real NetSession and LevelHost",
  baseline, migrated, silentGame, silentResults, repeatedSummary,
  ...(repetitions === 1 ? { repeatedResults } : {}) }));
console.log("PATHMANAGER LOSS / MIGRATION / CLEANUP PASSED");
