import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const dir = resolve(ROOT,"docs/benchmarks");
const before = JSON.parse(await readFile(resolve(dir,"network-before.json"),"utf8"));
const after = JSON.parse(await readFile(resolve(dir,"network-after.json"),"utf8"));
const rtc = JSON.parse(await readFile(resolve(dir,"webrtc-local.json"),"utf8"));
// Transport cadence and simulation behavior must remain identical. CPU/wall
// timing is deliberately excluded: this machine also ran concurrent builds.
const invariant = ["frames","rollbacks","deepestRollback","stalledCallbacks","wireMessages","payloadBytes","binaryPacketBytes","droppedMessages","measuredRttP50Ms","measuredRttP95Ms","jitterMs","relayQueueP50Ms","relayQueueP95Ms","relayQueueP99Ms"];
for(const row of after.rows) {
  const old = before.rows.find(r => r.mode === row.mode && r.scenario === row.scenario);
  assert.ok(old);
  for(const key of invariant) assert.deepEqual(row[key],old[key],`${row.mode}/${row.scenario} changed ${key}`);
}
const n = v => Number(v).toFixed(2);
const totals = r => r.reduce((a,b) => a+b,0);
const lines = [
  "# Network measurements — 2026-09-11", "",
  "All 24 scenarios passed before and after. Packet counts, payload bytes, RTT/jitter estimators, rollback depth/count, stalled callbacks and final frames are exactly unchanged. Passive transport counters and the RTT-poll cleanup do not change the protocol or transmission cadence. `network-report.mjs` asserts these invariants.", "",
  "The deterministic harness runs the production NetSession, LevelHost and RealtimeTransport for 20 virtual seconds/cell. Network delay/loss is injected with a seeded RNG and deadline-ordered delivery; it is not a measurement of hosted Supabase or global Internet routes. The final loss-free drain verifies shared input logs, zero desyncs and each world's replay hash. Browser throttling is a 1.5-second missing-tick interval; 144 Hz is a virtual callback cadence. Physical high-refresh hardware and browser OS suspension remain separate field measurements.", "",
  "Timing is real Node CPU/wall time on this host. These runs overlap other browser/build work, so p99 fluctuations are not evidence of a netcode speedup or regression. Heap is the shared Node process at cell end (GC phases vary), while snapshot bytes are per peer. Do not use these values as display frame-time or input-to-photon results.", "",
  "## Before / after", "",
  "Transport traffic below counts both players. Supabase bytes include the 74-byte attempt/session prefix before base64 and the `{p: [...]}` envelope; Phoenix topic/event/ref, WebSocket/TLS/TCP/IP headers are excluded. Realtime publishes also incur receiver deliveries in the quota model. Stalls are callbacks marked stalled, not unique stall incidents. Queue measurements use protocol timestamps rounded to whole milliseconds (up to 0.5ms quantization error); the direct path has no intentional queue despite its fractional rounding residual in the table.", "",
  "| Transport / scenario | Tick p95 ms before → after | Tick p99 ms before → after | CPU ms before → after | Heap MB before → after | Rollbacks/s before → after | Stalled callback % before → after | Messages/s before → after | Payload B/s before → after | Queue p95 ms |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
];
for(const row of after.rows) {
  const old = before.rows.find(r => r.mode === row.mode && r.scenario === row.scenario);
  lines.push(`| ${row.mode} / ${row.scenario} | ${n(old.tickP95Ms)} → ${n(row.tickP95Ms)} | ${n(old.tickP99Ms)} → ${n(row.tickP99Ms)} | ${n(old.cpuMs)} → ${n(row.cpuMs)} | ${n(old.heapUsedBytes/1e6)} → ${n(row.heapUsedBytes/1e6)} | ${n(totals(old.rollbacks)/old.durationSeconds)} → ${n(totals(row.rollbacks)/row.durationSeconds)} | ${n(totals(old.stallFraction)*50)} → ${n(totals(row.stallFraction)*50)} | ${n(old.messagesPerSecond)} → ${n(row.messagesPerSecond)} | ${n(old.payloadBytesPerSecond)} → ${n(row.payloadBytesPerSecond)} | ${n(row.relayQueueP95Ms)} |`);
}
lines.push("", "## What the measurements show", "",
  "At 600 ms RTT, ±100 ms one-way jitter and 20% injected message loss, the 230 ms Supabase batch has 20 stalled callbacks; 115 ms has zero, at 19.6 vs 11.1 publishes/s. This supports retaining the existing explicit hurry tradeoff, not enabling it for everyone. The 230 ms regional queue p95 is 219.1 ms. A binary unbatched relay could remove that browser queue, but actual relay route/TCP latency is unmeasured and its Free capacity is small; see [the relay evaluation](../../relay/README.md).",
  "", "## Actual Chromium loopback transport", "",
  `The direct channel negotiated in ${n(rtc.handshakeMs)} ms and its real getStats RTT samples were ${rtc.rttMs.map(n).join(" / ")} ms. Closing one real peer connection notified both sessions once in ${n(rtc.failureDetectionMs)} ms. The old stats timers stopped. A new agreed relay-only attempt was ready in ${n(rtc.fallbackSetupMs)} ms and both peers advanced ${rtc.relayFrames.join(" / ")} frames to the same hash. The rendezvous here is local: this proves the owner reconnect seam, not a hosted Supabase outage or a seamless mid-level migration.`,
  "", "The test also verifies unordered/maxRetransmits=0, exact typed-array slice boundaries, actual handshake timeout under blackholed signalling, and cancellation without unwanted fallback. It fails rather than silently skipping when Chromium is unavailable.",
  "", "## Reproduce", "", "```powershell", "npm --prefix engine run build", "node engine/test/networkbench.mjs --label after", "node engine/test/transport-failover.mjs", "node engine/test/network-report.mjs", "node relay/region-selection.test.mjs", "```", "",
  "Raw data: [before](network-before.json), [after](network-after.json), [loopback RTC](webrtc-local.json). Browser/render results are documented separately.", "");
await writeFile(resolve(dir,"NETWORK_BENCHMARK.md"),lines.join("\n"));
console.log("NETWORK BEFORE/AFTER INVARIANTS PASSED; docs/benchmarks/NETWORK_BENCHMARK.md written");
