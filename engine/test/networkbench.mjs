/** Real NetSession + RealtimeTransport on a deterministic, deadline-ordered wire.
 * No provider is contacted. RTT/loss are injected, CPU is measured on this host.
 */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { NetSession } from "../dist/net/session.js";
import { LevelHost } from "../dist/net/levelhost.js";
import { decode } from "../dist/net/protocol.js";
import { Rng } from "../dist/net/rng.js";
import { held, replay } from "../dist/netlink.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const tag = args[args.indexOf("--label") + 1] || "after";
const heartbeatExperiment = args.includes("--heartbeat-experiment");
const durationMs = 20_000;
const asModule = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64")}`;
const base64Module = asModule(await readFile(resolve(ROOT, "app/src/net/base64.ts"), "utf8"));
const sourceAtStart = await readFile(resolve(ROOT, "app/src/net/realtime.ts"), "utf8");
const realtimeSource = sourceAtStart
  .replace('from "./base64.js"', `from ${JSON.stringify(base64Module)}`)
  .replace('from "@engine/net/protocol.js"', `from ${JSON.stringify(pathToFileURL(resolve(ROOT,"engine/dist/net/protocol.js")).href)}`)
  .replace('from "@engine/net/transport.js"', `from ${JSON.stringify(pathToFileURL(resolve(ROOT,"engine/dist/net/transport.js")).href)}`);
const { RealtimeTransport } = await import(asModule(realtimeSource));
const pct = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  return +sorted[Math.min(sorted.length-1, Math.ceil(sorted.length*q)-1)].toFixed(3);
};

class Clock {
  now = 1_000_000;
  next = 0;
  events = [];
  after = (fn, delay) => { const id = ++this.next; this.events.push({ at: this.now+delay, id, fn }); return id; };
  cancel = id => { this.events = this.events.filter(e => e.id !== id); };
  advance(ms) {
    const until = this.now+ms;
    for (;;) {
      this.events.sort((a,b) => a.at-b.at || a.id-b.id);
      const e = this.events[0];
      if (!e || e.at > until) break;
      this.events.shift(); this.now = e.at; e.fn();
    }
    this.now = until;
  }
}

const conditions = [
  { name: "LAN", rtt: 0, jitter: 0, loss: 0 },
  { name: "regional", rtt: 80, jitter: 10, loss: 0 },
  { name: "150ms", rtt: 150, jitter: 30, loss: .05 },
  { name: "300ms", rtt: 300, jitter: 50, loss: .1 },
  { name: "600ms", rtt: 600, jitter: 100, loss: .2 },
  { name: "burst_loss", rtt: 150, jitter: 20, loss: .02, blackout: true },
  { name: "background_tab", rtt: 150, jitter: 20, loss: .02, throttle: true },
  { name: "144hz", rtt: 80, jitter: 10, loss: .05, hz: 144 },
];

const rows = [];
for (const mode of heartbeatExperiment ? ["supabaseEdge", "supabaseEdge230"] :
  ["direct", "supabase230", "supabase115", "supabaseEdge"]) {
  for (const condition of conditions) {
    const clock = new Clock(), rng = new Rng(12345);
    const epoch = clock.now;
    const saved = { now: Date.now, timer: globalThis.setTimeout, clear: globalThis.clearTimeout };
    Date.now = () => clock.now;
    globalThis.setTimeout = clock.after;
    globalThis.clearTimeout = clock.cancel;
    try {
      const handlers = [null, null];
      let settling = false;
      const metrics = { messages: 0, bytes: 0, binaryBytes: 0, lost: 0, queue: [], edgeQueue: [], heldQueue: [], tick: [], rtts: [], stalls: [0,0] };
      const published = [null, null];
      // 36-char session + ':' + 36-char attempt + ':'; the real scoped channel
      // adds this before base64. Supabase Phoenix/TLS/TCP headers are excluded.
      const prefix = "00000000-0000-4000-8000-000000000000:11111111-1111-4111-8111-111111111111:";
      const transmit = (side, packets) => {
        metrics.messages++;
        for (const bytes of packets) {
          metrics.binaryBytes += bytes.length;
          const parsed = decode(bytes);
          if (parsed?.timing) {
            const queue = Math.max(0, clock.now-parsed.timing.sent);
            metrics.queue.push(queue);
            if (parsed.kind === 1) {
              const previous = published[side];
              if (!previous || parsed.epoch !== previous.epoch || parsed.bits[0] !== previous.bits[0]) metrics.edgeQueue.push(queue);
              else metrics.heldQueue.push(queue);
              published[side] = parsed;
            }
          }
        }
        metrics.bytes += mode === "direct" ? packets[0].length : Buffer.byteLength(JSON.stringify({ p: packets.map(d => Buffer.concat([Buffer.from(prefix), d]).toString("base64")) }));
        const elapsed = clock.now-epoch;
        if (!settling && (rng.next() < condition.loss || (condition.blackout && elapsed >= 6000 && elapsed < 6500))) { metrics.lost++; return; }
        const delay = Math.max(0, condition.rtt/2 + (rng.next()*2-1)*condition.jitter);
        clock.after(() => { for (const p of packets) handlers[1-side]?.(p); }, delay);
      };
      const transports = [0,1].map(side => {
        if (mode === "direct") return {
          rttMs: condition.rtt, send: bytes => transmit(side, [bytes.slice()]),
          onMessage: fn => { handlers[side] = fn; }, close() {},
        };
        const tr = new RealtimeTransport({
          onBytes(fn) { handlers[side] = fn; return () => { handlers[side] = null; }; },
          sendBytes(packets) { transmit(side, packets.map(p => new Uint8Array(Buffer.from(p, "base64")))); },
          onStatus() { return () => {}; },
        }, { legacyBatching: !mode.startsWith("supabaseEdge"),
          heldHeartbeatMs: mode === "supabaseEdge230" ? 230 : 115, now: () => clock.now });
        if (mode === "supabase115") tr.hurry(true);
        return tr;
      });
      const peers = transports.map((transport, slot) => {
        const host = new LevelHost();
        return { host, session: new NetSession({ slot, host, transport, rollback: true, timeSync: true, now: () => clock.now }) };
      });
      peers[0].session.requestStart("adventure", 1);
      const hz = condition.hz ?? 60, dt = 1/hz;
      const cpuStart = process.cpuUsage(), wallStart = performance.now();
      for (let i=0; i<Math.ceil(durationMs/1000*hz); i++) {
        clock.advance(1000/hz);
        for (let side=0; side<2; side++) {
          const elapsed = clock.now-epoch;
          peers[side].session.setLocalInput(held(side, Math.floor(elapsed*26/1000)));
          if (condition.throttle && side === 1 && elapsed >= 6000 && elapsed < 7500) continue;
          const start = performance.now();
          peers[side].session.tick(dt);
          metrics.tick.push(performance.now()-start);
          if (peers[side].session.stalled) metrics.stalls[side]++;
          if (peers[side].session.rttMs !== null) metrics.rtts.push(peers[side].session.rttMs);
        }
      }
      const cpu = process.cpuUsage(cpuStart);
      const measurement = {
        mode, scenario: condition.name, injectedRttMs: condition.rtt,
        injectedJitterMs: condition.jitter, injectedLoss: condition.loss,
        callbackHz: hz, durationSeconds: durationMs/1000,
        tickP50Ms: pct(metrics.tick,.5), tickP95Ms: pct(metrics.tick,.95), tickP99Ms: pct(metrics.tick,.99),
        measuredRttP50Ms: pct(metrics.rtts,.5), measuredRttP95Ms: pct(metrics.rtts,.95),
        jitterMs: peers.map(p => +p.session.jitterMs.toFixed(3)),
        relayQueueP50Ms: pct(metrics.queue,.5), relayQueueP95Ms: pct(metrics.queue,.95), relayQueueP99Ms: pct(metrics.queue,.99),
        relayQueueMaxMs: Math.max(0,...metrics.queue), edgeQueueP95Ms: pct(metrics.edgeQueue,.95),
        heldQueueP95Ms: pct(metrics.heldQueue,.95),
        wireMessages: metrics.messages, messagesPerSecond: metrics.messages*1000/durationMs,
        payloadBytes: metrics.bytes, payloadBytesPerSecond: metrics.bytes*1000/durationMs,
        binaryPacketBytes: metrics.binaryBytes, droppedMessages: metrics.lost,
        observedLoss: metrics.messages ? metrics.lost/metrics.messages : 0,
        rollbacks: peers.map(p => p.session.rollbacks), deepestRollback: peers.map(p => p.session.deepestRollback),
        stalledCallbacks: metrics.stalls, stallFraction: metrics.stalls.map(v => v/(durationMs/1000*hz)),
        frames: peers.map(p => p.session.frame),
        cpuMs: (cpu.user+cpu.system)/1000, wallMs: +(performance.now()-wallStart).toFixed(3),
        heapUsedBytes: process.memoryUsage().heapUsed, snapshotBytes: peers.map(p => p.session.snapshotBytes),
      };
      // A dropped final packet cannot be repaired by silence. Restore delivery
      // after measurement and transmit steady input until history heals.
      settling = true;
      for (let i = 0; i < 120; i++) {
        clock.advance(1000/60);
        for (const p of peers) { p.session.setLocalInput(0); p.session.tick(1/60); }
      }
      // Finish in-flight history then correct each peer, without advancing it.
      clock.advance(2000);
      for (const p of peers) p.session.tick(0);
      const shared = Math.min(...peers.map(p => p.session.frame));
      assert.ok(shared > 250, `${mode}/${condition.name} stopped making progress`);
      assert.deepEqual(peers[0].session.log.slice(0,shared), peers[1].session.log.slice(0,shared), `${mode}/${condition.name} shared inputs differ`);
      for (const p of peers) {
        assert.equal(p.session.desyncs, 0, `${mode}/${condition.name} desync`);
        assert.equal(p.host.hash(), replay("adventure",1,p.session.log.slice(0,p.session.frame)).hash(), `${mode}/${condition.name} replay differs`);
      }
      for (const tr of transports) tr.close();
      measurement.finalHashes = peers.map(p => p.host.hash());
      measurement.replayHashes = peers.map(p => replay("adventure",1,p.session.log.slice(0,p.session.frame)).hash());
      measurement.sharedFrames = shared;
      measurement.sharedHash = replay("adventure",1,peers[0].session.log.slice(0,shared)).hash();
      rows.push(measurement);
      console.log(`${mode.padEnd(12)} ${condition.name.padEnd(15)} p99 ${measurement.tickP99Ms.toFixed(2)}ms, ${measurement.messagesPerSecond.toFixed(2)} msg/s, ${measurement.payloadBytesPerSecond.toFixed(0)} B/s, queue p95 ${measurement.relayQueueP95Ms}ms, rollback ${measurement.rollbacks}, stalls ${measurement.stalledCallbacks}`);
    } finally {
      Date.now = saved.now; globalThis.setTimeout = saved.timer; globalThis.clearTimeout = saved.clear;
    }
  }
}

const output = {
  label: tag, capturedAt: new Date().toISOString(), node: process.version,
  description: "Actual 26Hz NetSession/LevelHost and production RealtimeTransport; seeded simulated network, 20s per cell. CPU is local Node. Payload excludes Phoenix/WebSocket/TLS/IP overhead. Heap is process-wide, not per session. No global WAN or provider usage was measured.",
  realtimeSource: sourceAtStart, rows,
};
const dir = resolve(ROOT,"docs/benchmarks");
await mkdir(dir,{recursive:true});
await writeFile(resolve(dir,`network-${tag}.json`), JSON.stringify(output,null,2)+"\n");
console.log(`NETWORK BENCHMARK PASSED (${rows.length} scenarios)`);
