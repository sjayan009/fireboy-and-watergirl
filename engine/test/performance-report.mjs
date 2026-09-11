import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "../..");
const load = async name => JSON.parse(await readFile(resolve(root,name),"utf8"));
const before = await load("benchmarks/before.json"), after = await load("benchmarks/after.json");
const assets = await load("benchmarks/assets.json");
assert.equal(before.environment.browser, after.environment.browser);
assert.equal(before.environment.assets, after.environment.assets);
assert.equal(before.levelEnded, false); assert.equal(after.levelEnded, false);
assert.deepEqual(before.errors, []); assert.deepEqual(after.errors, []);
const fmt = n => n == null ? "unavailable" : Number(n).toFixed(2);
const rows = [
  ["rAF frame interval p50 / p95 / p99 (ms)", b => [b.frameMs.p50,b.frameMs.p95,b.frameMs.p99].map(fmt).join(" / ")],
  ["Render time p50 / p95 / p99 (ms)", b => [b.renderMs.p50,b.renderMs.p95,b.renderMs.p99].map(fmt).join(" / ")],
  ["Distinct canvas command updates/s", b => fmt(b.distinctVisualUpdatesPerSecond)],
  ["Distinct controlled-character positions/s", b => fmt(b.localPositionUpdatesPerSecond)],
  ["Input event to render p50 / p95 / p99 (ms)", b => [b.inputToRenderMs.p50,b.inputToRenderMs.p95,b.inputToRenderMs.p99].map(fmt).join(" / ")],
  ["Input samples / unresolved", b => `${b.inputToRenderMs.n} / ${b.inputUnresolved}`],
  ["Chromium main-task CPU fraction (%)", b => fmt(b.taskCpuPercent)],
  ["JS heap used / allocated (MB)", b => `${fmt(b.heap.used/1e6)} / ${fmt(b.heap.total/1e6)}`],
  ["DrawImage calls p95 / scene visits p95", b => `${b.drawCalls.p95} / ${b.traversalNodes.p95}`],
  ["Main-thread tasks over 50 ms (count)", b => b.mainThreadLongTasksMs.n],
  ["Worst main-thread long task (ms)", b => fmt(b.mainThreadLongTasksMs.max)],
  ["GC events / cumulative / maximum duration (ms)", b => `${b.gc.count} / ${fmt(b.gc.totalMs)} / ${fmt(b.gc.maxMs)}`],
  ["Cold asset/scene preparation (ms)", b => fmt(b.preparation.prepareMs)],
];
const lines = ["# Measured performance audit", "", "Recorded 2026-09-11. These are actual local measurements with the explicit scopes below; they are not claims about all clients or global Internet routes.", "", "## Browser renderer: before / after", "",
  `Same ${after.environment.cpu}, Windows ${after.environment.release}, Chromium ${after.environment.browser} headless, Node ${after.environment.node}. Each sample is approximately 20 seconds of adventure level 1 with alternating movement every 120 ms, identical assets and instrumentation. The baseline is the compiled original at ${before.commit}; the after build includes the working-tree changes in this audit. Both workloads remain alive, with no missing art or page exceptions.`, "",
  "| Metric | Before | After |", "| --- | ---: | ---: |",
  ...rows.map(([label,read])=>`| ${label} | ${read(before)} | ${read(after)} |`), "",
  "The controlled-character count comes from actual canvas transforms at character drawing, so the improvement is not merely more identical rAF callbacks. The whole-canvas count hashes draw commands, not read-back pixels. Stopping/reversing input every 120 ms deliberately suppresses some local extrapolation; it should not reach the display rate on every callback. Synthetic steady-motion tests establish near-display-rate interpolation at 60/120/144/240 Hz while simulation remains 26 Hz.", "",
  "The frame-time numbers are rAF intervals; render time is CPU time inside the draw call. Canvas instrumentation and tracing overhead are included equally. Headless rasterization can differ substantially from a hardware-accelerated foreground browser. Early exploratory runs varied with concurrent workloads; this table uses the final isolated, consecutive after/before pair with identical instrumentation. It is a short reproducible sample, not a confidence interval or hardware certification.", "",
  "Input latency is synthetic DOM key event to the first render showing a changed authoritative local position. It excludes keyboard/OS sampling, compositor presentation and physical scanout. Physical input-to-photon latency was NOT measured; a photodiode or high-speed camera and physical display are required. Real GameView scheduling tests separately prove that smoothing first responds on the same simulation tick/callback as smoothing disabled at every tested refresh schedule.", "",
  "CPU is Chromium TaskDuration divided by wall time including measurement setup/teardown. JS heap is a snapshot, not process RSS or graphics memory. Caches trade some retained memory for less raster work. GC durations include collector activity and are not all necessarily stop-the-world. The remaining isolated startup long task is visible above; p95/p99 improvement does not mean every stall disappeared. Different wall-clock callback schedules generate different input logs, so benchmark end hashes are not expected to match; identical-log determinism is verified separately.", "",
  "## Network, rollback and relay traffic", "",
  "The [24-cell before/after table](docs/benchmarks/NETWORK_BENCHMARK.md) reports actual engine execution over seeded links at 0–600 ms RTT, jitter, random/burst loss, missing browser ticks and 144 Hz callbacks. It includes p95/p99 tick work, CPU/heap, RTT/jitter, rollback counts/depth, stalls, relay queue p50/p95/p99, application bandwidth and message rates. All protocol/traffic/rollback/stall measurements are exactly unchanged by passive telemetry. Network CPU measurements ran alongside other work, so no netcode speedup is claimed.", "",
  "The separate [real Chromium WebRTC result](docs/benchmarks/webrtc-local.json) covers unordered/unreliable data channels, loopback RTT, a real connection closing, signalling blackhole/timeout, cancellation and agreed relay reconnection with equal replay hashes. The rendezvous is local; this does not measure physical NATs, hosted Supabase outages, global regional latency, or seamless live-run migration. DO deployment was deferred after the [capacity evaluation](relay/README.md); consequently no invented DO latency/bandwidth result appears here.", "",
  "## What changed and what was investigated", "",
  "Static terrain used to revisit hundreds of mask tiles on every draw and composite full-stage scratch layers. Its immutable final raster is now cached. Character glows use reusable 192×192 pose tiles rather than reallocating a 640×480 canvas on movement; cached output includes the blur. These reduce traversal, allocations and repeated full-surface overdraw. Draw counts are measured above; exact GPU overdraw/VRAM was not available. Matrix decomposition and output transforms are reused. Filter/mask code no longer temporarily writes into simulation objects.", "",
  `The separate [asset profile](benchmarks/assets.json) measured ${assets.decodePromiseMs.count} image decode promises: p50/p95/p99 ${fmt(assets.decodePromiseMs.p50)}/${fmt(assets.decodePromiseMs.p95)}/${fmt(assets.decodePromiseMs.p99)} ms, peak ${assets.peakDecodePromises} simultaneously pending (existing limit 12). ${assets.resourceRequests} cold local resources transferred ${fmt(assets.transferredBytes/1e6)} MB; scene preparation took ${fmt(assets.preparationMs)} ms. Decode promise latency includes scheduling and is not isolated decoder CPU. A warmed drawing submitted ${fmt(assets.submittedRectangles.stageAreaInScreens)} screen-equivalents of main-canvas image rectangles and ${fmt(assets.submittedRectangles.offscreenAreaInScreens)} offscreen. This counts transparent/clipped rectangle area, not actual shaded GPU pixels.`, "",
  "Existing WebP/audio packing and the final Pages inventory fit far below 20,000 files, so an atlas was evaluated but not added without evidence of a further win. No object store or asset service was introduced. See [renderer design](docs/RENDERING_PERFORMANCE.md) and [free-tier budget](FREE_TIER_BUDGET.md).", "",
  "## Validation and reproduction", "",
  "Checks include all 32 pinned level digests; rollback/snapshot/drift/hostile-link contracts; isolated replay verification; identical 600-frame results in Chromium/Firefox/WebKit; all 32 visual goldens plus level-transition comparisons; full read-only render snapshots; actual GameView scheduling at 60/120/144/240 Hz and 500/1500 ms gaps; TURN configuration rejection; static file/security/asset checks; TypeScript and lint. Missing browsers fail the new browser checks.", "",
  "```powershell", "npm ci", "npm --prefix engine run build", "npm run bench:render -- after", "node engine/test/asset-profile.mjs", "node engine/test/performance-report.mjs", "npm run bench:network -- --label after", "node engine/test/network-report.mjs", "node engine/test/render-schedule.mjs", "node engine/test/render-readonly.mjs", "node engine/test/transport-failover.mjs", "node relay/region-selection.test.mjs", "```", "",
  "For a fresh baseline, build commit `7c399f8603918997197785957bcb05b86c72b89f` in a separate checkout, set `FBWG_BENCH_ENGINE` to its compiled engine directory, and use the current `performance.mjs before` harness with the same asset directory. `FBWG_BENCH_SECONDS` adjusts sample length. The preserved local baseline directory is not a committed dependency. Raw browser records: [before](benchmarks/before.json), [after](benchmarks/after.json).", "",
  "Unmeasured field acceptance remains: physical input-to-photon and high-refresh hardware, mobile/low-end GPU behavior, real NAT combinations, two-user regional relay paths, provider quota refusal and all live billing settings. Do not describe this local audit as a completed live $0 deployment certification.", ""];
await writeFile(resolve(root,"BENCHMARKS.md"),lines.join("\n"));
console.log("BENCHMARKS.md generated from recorded measurements");
