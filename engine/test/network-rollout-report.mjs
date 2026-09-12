import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
const json = async path => JSON.parse(await readFile(new URL(path,root),'utf8'));
const before = await json('docs/benchmarks/network-rollout-before.json');
const after = await json('docs/benchmarks/network-rollout-after.json');
const rtc = await json('docs/benchmarks/pathmanager-local.json');
const render = await Promise.all(['before','default','after'].map(label => json(`benchmarks/rollout-${label}.json`)));
const invariant = ['frames','rollbacks','deepestRollback','stalledCallbacks','wireMessages','payloadBytes',
  'binaryPacketBytes','droppedMessages','measuredRttP50Ms','measuredRttP95Ms','jitterMs',
  'relayQueueP50Ms','relayQueueP95Ms','relayQueueP99Ms'];
for(const old of before.rows) {
  const current=after.rows.find(r=>r.mode===old.mode&&r.scenario===old.scenario);
  assert(current);
  for(const key of invariant) assert.deepEqual(current[key],old[key],`${old.mode}/${old.scenario}: ${key}`);
}
for(const row of after.rows) {
  assert.deepEqual(row.finalHashes,row.replayHashes,`${row.mode}/${row.scenario} replay`);
  if(row.mode==='supabaseEdge') {
    assert(row.edgeQueueP95Ms<=1,'input edges wait in the publisher');
    assert(row.relayQueueP95Ms<=115,'heartbeat deadline exceeded');
    const old=before.rows.find(r=>r.mode==='supabase115'&&r.scenario===row.scenario);
    assert(row.stalledCallbacks.reduce((a,b)=>a+b,0)<=old.stalledCallbacks.reduce((a,b)=>a+b,0),`${row.scenario} regressed versus115ms`);
  }
}
const n = value => value == null ? '—' : Number(value).toFixed(2);
const pair = values => values.map(n).join(' / ');
const lines = [
  '# Network and presentation rollout measurements', '',
  `Baseline captured ${before.capturedAt}; after captured ${after.capturedAt}. Baseline source was compiled/read before edits on main at 1717cf1. Raw records include source and timestamps; the render records identify the original HEAD because these changes were uncommitted during measurement.`, '',
  'All 24 direct/legacy cells reproduce the same logical frames, packet counts, bytes, RTT/jitter estimates, rollback counts/depths, stalls and queue quantiles. The additional eight edge-publisher cells have matching input logs and replay hashes after draining delivery. Key transitions have at most 1 ms quantized application queue p95. No edge cell increases stalled callbacks relative to 115 ms batching; the 230 ms background-tab cell remains less stall-prone than either faster mode.', '',
  'This is the real 26 Hz NetSession/LevelHost and RealtimeTransport over a seeded virtual network, 20 virtual seconds per cell. Loss/jitter/RTT are injected, including 600 ms RTT, ±100 ms one-way jitter and 20% message loss. Node CPU and tick timings are actual local measurements; they are not browser/main-thread or WAN observations. Transport queue timestamps are rounded to whole milliseconds (direct 0.33 ms is quantization, not deliberate pacing).', '',
  'Payload accounting retains the historical 74-byte modeled scope prefix before base64 for matched comparison. Production UUID attempt scoping is 37 bytes; managed gameplay adds 17 bytes. Phoenix/WebSocket/TLS/IP headers and provider deliveries are excluded from bytes. Supabase meters publishes plus deliveries; see FREE_TIER_BUDGET.md.', '',
  '| Mode/scenario | Queue p50/p95/max ms | Edge p95 ms | RTT p50/p95 ms | Jitter per peer ms | Rollbacks | Deepest | Stalled callbacks | Publishes/s | Payload B/s | Node CPU ms | Shared replay hash |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
];
for(const r of after.rows) lines.push(`| ${r.mode}/${r.scenario} | ${n(r.relayQueueP50Ms)} / ${n(r.relayQueueP95Ms)} / ${n(r.relayQueueMaxMs)} | ${n(r.edgeQueueP95Ms)} | ${n(r.measuredRttP50Ms)} / ${n(r.measuredRttP95Ms)} | ${pair(r.jitterMs)} | ${r.rollbacks.join('/')} | ${r.deepestRollback.join('/')} | ${r.stalledCallbacks.join('/')} | ${n(r.messagesPerSecond)} | ${n(r.payloadBytesPerSecond)} | ${n(r.cpuMs)} | ${r.sharedHash} |`);
lines.push('', '## Browser renderer', '',
  'Sequential 20-second Chromium headless runs with position-feedback DOM input, actual art and the existing tracing/canvas instrumentation. No other agent-started browser benchmark ran concurrently. Each column is one run, not a statistical certification. The default preserves presentation flags off. Both features remain opt-in because their enabled comparison worsened tail frame/render timing. All runs stayed in a level with complete art and no page exceptions.', '',
  '| Metric | Before | Default after | Both presentation flags on |', '|---|---:|---:|---:|');
for(const [label, pick] of [
  ['Frame p95 ms',r=>r.frameMs.p95],['Frame p99 ms',r=>r.frameMs.p99],
  ['Render p95 ms',r=>r.renderMs.p95],['Input-to-render proxy p95 ms',r=>r.inputToRenderMs.p95],
  ['Long tasks>50ms',r=>r.mainThreadLongTasksMs.n],['Longest task ms',r=>r.mainThreadLongTasksMs.max],
  ['Main-task CPU%',r=>r.taskCpuPercent],
]) lines.push(`| ${label} | ${render.map(r=>n(pick(r))).join(' | ')} |`);
lines.push('',
  'Display hashes differ across wall-clock runs because the steering samples inputs at different times and reaches different frame counts. Hash invariance is tested using identical scripted replay inputs, pinned level digests and read-only render snapshots, not by comparing these unrelated live input logs. Input latency excludes physical input and scanout. CPU is Chromium TaskDuration/wall time including instrumentation. Startup long tasks remain.', '',
  '## Real RTC migration', '',
  `Chromium host/UDP RTC was active in ${n(rtc.initialRtcMs)} ms. Closing one peer connection selected local emergency relay in ${n(rtc.fallbackMs)} ms and a fresh verified RTC path in ${n(rtc.recoveryMs)} ms from failure. Both peers retained generation ${rtc.final[0].generation} and runSerial ${rtc.final[0].runSerial}, reached frame ${rtc.final[0].frame}, hash ${rtc.final[0].hash}; link-down callbacks ${rtc.down.join('/')}, stalls ${rtc.final.map(r=>r.stalls).join('/')}. Relay gameplay stopped after promotion, retired stats timers and subscriptions were cleaned up. This is a real browser RTC path and local ByteChannel relay, not hosted Supabase.`, '',
  'Deterministic path-manager tests also compare a 220-frame run with and without migration: both reach 514ceabe, generation 1, runSerial 1. They exercise control loss/reordering, stale attempts, asymmetric failure, silent blackholes, retry bounds, subscriber cleanup, credential-load races and actual PairChannel buffering across a two-second outage.', '',
  '## Unmeasured deployment cells', '',
  'Forced Cloudflare TURN and hosted Supabase relay/failover were not run: the user confirmed that the broker is not configured and requested the deployment checklist. Their queue/RTT/jitter, input-to-render, frame/render, long-task and CPU fields remain unavailable. The local network simulator has no renderer; the renderer benchmark has no WAN. No averages or local mocks establish those missing results.', '',
  '## Reproduce', '', '```powershell',
  'npm --prefix engine run build',
  'node engine/test/networkbench.mjs --label rollout-after',
  'node app/test/pathmanager-webrtc.mjs',
  '$env:FBWG_BENCH_SECONDS="20"', '$env:FBWG_BENCH_STEERING="position"',
  '$env:FBWG_BENCH_ROLLBACK_SMOOTHING="0"', '$env:FBWG_BENCH_DESCENDANTS="0"',
  'node engine/test/performance.mjs rollout-default',
  '$env:FBWG_BENCH_ROLLBACK_SMOOTHING="1"', '$env:FBWG_BENCH_DESCENDANTS="1"',
  'node engine/test/performance.mjs rollout-after',
  'node engine/test/network-rollout-report.mjs', '```', '',
  'Preserve the checked-in before artifacts. To recreate them, build original main 1717cf1 in an isolated checkout and use the same harness. Run browser benchmarks sequentially. Existing historical network-report.mjs retains its September 11 input files; this report uses separate rollout artifacts.', '');
await writeFile(new URL('docs/benchmarks/NETWORK_ROLLOUT_BENCHMARK.md',root),lines.join('\n'));
console.log('ROLLOUT REPORT PASSED: direct/legacy invariants, edge latency, replay hashes and 115 ms stall baseline');
