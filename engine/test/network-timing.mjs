/** Fixed-step protocol under mixed display clocks and bounded replay CPU work. */
import assert from "node:assert/strict";
import { NetSession } from "../dist/net/session.js";
import { decode, encodeInput } from "../dist/net/protocol.js";
import { ENGINE_VERSION } from "../dist/version.js";
const Kind = { Input: 1, Command: 2 };
const Command = { Start: 1, Pause: 2, Retry: 3, Quit: 4 };

class Host {
  world = { value: 0, frames: 0, paused: false };
  confirmedFrames = []; effects = []; starts = 0; retries = 0; readyState = true;
  cost = () => {};
  start() { this.starts++; this.world.value = 0; this.world.frames = 0; this.world.paused = false; }
  retry() { this.retries++; this.start(); }
  quit() { this.world.paused = true; }
  pause(force = false) { this.world.paused = force || !this.world.paused; }
  ready() { return this.readyState; }
  step(bits, frame, replaying) {
    if (!this.world.paused) this.world.value = (this.world.value * 31 + bits + 1) >>> 0;
    this.world.frames++;
    if (!replaying) this.effects.push(frame);
    this.cost();
  }
  hash() { return this.world.value.toString(16).padStart(8, "0"); }
  save(snapshot) { snapshot.capture([this.world]); }
  load(snapshot) { snapshot.restore(); }
  confirmed(frame) { this.confirmedFrames.push(frame); }
}
const silent = { rttMs: null, send() {}, onMessage() {}, close() {} };
const rates = [30, 60, 120, 144, 240];
const commandTraffic = [];
// An unanswered Start is capped by elapsed time even when art prevents all stepping.
for (const hz of rates) {
  let now = 0, commands = 0, bytes = 0;
  const host = new Host(); host.readyState = false;
  const session = new NetSession({ slot: 0, host, now: () => now, workNow: () => 0,
    transport: { ...silent, send(packet) { if (decode(packet)?.kind === Kind.Command) { commands++; bytes += packet.byteLength; } } } });
  session.requestStart("adventure", 1);
  for (let i = 1; i <= hz * 5; i++) { now = i * 1000 / hz; session.tick(1 / hz); }
  assert(commands >= 70 && commands <= 101, "unanswered command exceeded20resends/second budget");
  assert(bytes <= 101 * 64, "command byte budget exceeded at a higher display rate");
  assert.equal(session.frame, 0);
  commandTraffic.push({ hz, commands, bytes });
  session.depart();
}
const stallNotices = [];
for (const hz of rates) {
  let now = 0;
  const host = new Host();
  const session = new NetSession({ slot: 0, host, transport: silent, rollback: true, delay: 0, now: () => now, workNow: () => 0 });
  session.begin("adventure", 1);
  let notice = null;
  for (let i = 1; i <= hz * 5; i++) {
    now = i * 1000 / hz; session.tick(1 / hz);
    if (notice === null && session.stalledMs >= 2000) notice = session.stalledMs;
  }
  assert.ok(notice >= 2000 && notice <= 2000 + 1000 / hz + 0.001);
  assert.equal(session.frame, 30);
  stallNotices.push({ hz, noticeMs: notice });
}

function pair(aHz, bHz, commandDelay = 10, droppedCommands = 0) {
  let now = 0; const queue = [], handlers = []; let commands = 0;
  const hosts = [new Host(), new Host()];
  const sessions = hosts.map((host, slot) => new NetSession({ slot, host, rollback: true, delay: 0,
    now: () => now, workNow: () => 0, transport: { rttMs: 20, close() {}, onMessage(fn) { handlers[slot] = fn; },
      send(data) {
        const packet = decode(data);
        if (packet?.kind === Kind.Command && packet.command !== Command.Start && commands++ < droppedCommands) return;
        queue.push({ at: now + (packet?.kind === Kind.Command && packet.command !== Command.Start ? commandDelay : 10), to: 1 - slot, data: data.slice() });
      } } }));
  const next = [0, 0], intervals = [1000 / aHz, 1000 / bHz];
  function run(ms) {
    const until = now + ms;
    while (Math.min(...next) <= until + 0.00001) {
      now = Math.min(...next);
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].at <= now) {
        const packet = queue.splice(i, 1)[0]; handlers[packet.to](packet.data);
      }
      for (let slot = 0; slot < 2; slot++) if (next[slot] <= now + 0.00001) {
        sessions[slot].tick(intervals[slot] / 1000); next[slot] += intervals[slot];
      }
    }
    now = until;
  }
  sessions[0].requestStart("adventure", 1); run(500);
  return { hosts, sessions, run, get now() { return now; }, get commands() { return commands; } };
}

const controlSamples = [];
for (const [aHz, bHz] of [[30, 240], [240, 30], [60, 144], [120, 60], [144, 120]]) {
  const f = pair(aHz, bHz);
  const at = f.now;
  assert.equal(f.sessions[0].send(Command.Pause, 1), true);
  assert.equal(f.sessions[0].send(Command.Pause, 1), false, "a repeated request scheduled a second toggle");
  let applied = null;
  for (let i = 0; i < 30; i++) { f.run(10); if (f.hosts.every(h => h.world.paused)) { applied = f.now - at; break; } }
  assert.ok(applied !== null && applied <= 220, "healthy control request did not apply promptly");
  assert.ok(f.sessions.every(s => s.desyncs === 0 && !s.pendingControl));
  controlSamples.push({ aHz, bHz, applicationMs: applied });
}

// Retries continue at elapsed-time cadence while critical graphics block stepping.
{
  const f = pair(30, 240, 10, 15);
  f.hosts.forEach(h => { h.readyState = false; });
  f.sessions[0].send(Command.Pause, 1);
  const before = f.sessions.map(s => s.frame);
  f.run(1200);
  assert.deepEqual(f.sessions.map(s => s.frame), before);
  assert.ok(f.commands >= 15 && f.commands <= 25, "retry rate changed with display refresh");
  f.hosts.forEach(h => { h.readyState = true; }); f.run(500);
  assert.ok(f.hosts.every(h => h.world.paused), "lost command did not survive preparation");
  assert.ok(f.sessions.every(s => s.desyncs === 0));
}

// A command behind the retained snapshot takes the full deterministic repair path.
{
  const f = pair(60, 240, 1200);
  f.run(1000);
  f.sessions[0].send(Command.Pause, 1);
  f.run(2400);
  assert.ok(f.hosts.every(h => h.world.paused));
  assert.ok(f.sessions[1].rebuilds > 0, "late command never exercised the older-than-snapshot path");
  assert.ok(f.sessions.every(s => s.generation === 1 && !s.recovering));
}

// A delayed Retry applies once and advances both epochs without losing its log.
{
  const f = pair(60, 240, 1200);
  f.run(1000); f.sessions[0].send(Command.Retry); f.run(3000);
  assert.deepEqual(f.hosts.map(h => h.retries), [1, 1]);
  assert.ok(f.sessions.every(s => s.generation === 2 && s.runSerial === 2 && !s.recovering));
}

// Long repairs yield, defer input, suppress duplicate effects and publish once.
{
  let now = 0, work = 0; let receive;
  const host = new Host(); host.cost = () => { work++; };
  const session = new NetSession({ slot: 0, host, solo: true, rollback: true, delay: 0,
    now: () => now, workNow: () => work, workBudgetMs: 2,
    transport: { ...silent, onMessage(fn) { receive = fn; } } });
  session.begin("adventure", 1);
  for (let i = 0; i < 900; i++) { now += 1000 / 26; session.setLocalInput(i % 8); session.tick(1 / 26); }
  const hash = host.hash(), epoch = session.generation, effects = host.effects.length;
  const published = host.confirmedFrames.length;
  host.world.value = 0xdeadbeef;
  session.resync();
  assert.equal(session.recovering, true);
  assert.ok(session.frame <= 2, "repair exceeded its injected CPU budget");
  assert.equal(host.confirmedFrames.length, published);
  receive(encodeInput({ kind: Kind.Input, slot: 1, epoch, frame: 899, bits: [0], hashFrame: 0, hash: 0 }));
  let chunks = 0;
  while (session.recovering && chunks++ < 1000) session.tick(0);
  assert.ok(chunks > 400 && chunks < 1000);
  assert.equal(session.frame, 900); assert.equal(host.hash(), hash);
  assert.equal(host.effects.length, effects, "full repair replayed sounds/effects");
  assert.equal(host.confirmedFrames.length, published + 1);
  assert.equal(session.generation, epoch);
  session.resync(); assert.equal(session.recovering, true);
  session.begin("puzzle", 1); session.tick(0);
  assert.equal(session.recovering, false); assert.equal(session.frame, 0);
  assert.equal(session.generation, (epoch + 1) & 255);
  session.tick(1 / 26); session.resync(); session.depart(); session.tick(1);
  assert.equal(session.running, false); assert.equal(session.recovering, false);
}

// Long watcher bootstrap uses the same CPU budget and cancels without publishing.
{
  let work = 0; const host = new Host(); host.cost = () => { work++; };
  const session = new NetSession({ slot: 0, host, observer: true, transport: silent,
    workNow: () => work, workBudgetMs: 2 });
  const abort = new AbortController();
  const replay = JSON.stringify([1, ENGINE_VERSION, "adventure", 1,
    900, Buffer.from(new Uint8Array(900)).toString("base64"), []]);
  const loading = session.loadConfirmedReplay(replay, 3, abort.signal);
  assert.equal(session.recovering, true); assert.ok(session.frame <= 2);
  abort.abort(); await assert.rejects(loading);
  assert.equal(session.running, false); assert.equal(session.recovering, false);
  assert.equal(host.confirmedFrames.length, 0);
}

console.log(JSON.stringify({ stallNotices, controlSamples, commandTraffic, sharedSimulationHz: 26 }));
console.log("NETWORK TIMING / RECOVERY PASSED");
