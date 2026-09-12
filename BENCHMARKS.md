# Measured performance audit

Recorded 2026-09-11. These are actual local measurements with the explicit scopes below; they are not claims about all clients or global Internet routes.

Follow-up: [repeated smoothness verification](docs/benchmarks/SMOOTHNESS_VERIFICATION.md) adds three new before/after comparisons, an actual deployed-level measurement and rerun simulation/input checks. It confirms improvement while documenting dropped frames under the later machine conditions; the original measurements below remain unchanged.

## Browser renderer: before / after

Same Intel(R) Core(TM) Ultra 9 185H, Windows 10.0.26200, Chromium 151.0.7922.34 headless, Node v22.17.1. Each sample is approximately 20 seconds of adventure level 1 with alternating movement every 120 ms, identical assets and instrumentation. The baseline is the compiled original at 7c399f8603918997197785957bcb05b86c72b89f; the after build includes the working-tree changes in this audit. Both workloads remain alive, with no missing art or page exceptions.

| Metric | Before | After |
| --- | ---: | ---: |
| rAF frame interval p50 / p95 / p99 (ms) | 50.00 / 66.70 / 83.30 | 16.70 / 16.70 / 16.80 |
| Render time p50 / p95 / p99 (ms) | 17.90 / 21.90 / 26.20 | 4.30 / 6.70 / 8.10 |
| Distinct canvas command updates/s | 18.49 | 58.06 |
| Distinct controlled-character positions/s | 17.95 | 47.67 |
| Input event to render p50 / p95 / p99 (ms) | 53.70 / 86.30 / 117.50 | 33.10 / 69.50 / 87.90 |
| Input samples / unresolved | 166 / 0 | 166 / 0 |
| Chromium main-task CPU fraction (%) | 98.95 | 60.58 |
| JS heap used / allocated (MB) | 6.72 / 15.62 | 9.62 / 16.68 |
| DrawImage calls p95 / scene visits p95 | 434 / 454 | 65 / 85 |
| Main-thread tasks over 50 ms (count) | 320 | 1 |
| Worst main-thread long task (ms) | 182.00 | 261.00 |
| GC events / cumulative / maximum duration (ms) | 38 / 64.67 / 24.55 | 26 / 16.03 / 3.05 |
| Cold asset/scene preparation (ms) | 507.50 | 582.00 |

The controlled-character count comes from actual canvas transforms at character drawing, so the improvement is not merely more identical rAF callbacks. The whole-canvas count hashes draw commands, not read-back pixels. Stopping/reversing input every 120 ms deliberately suppresses some local extrapolation; it should not reach the display rate on every callback. Synthetic steady-motion tests establish near-display-rate interpolation at 60/120/144/240 Hz while simulation remains 26 Hz.

The frame-time numbers are rAF intervals; render time is CPU time inside the draw call. Canvas instrumentation and tracing overhead are included equally. Headless rasterization can differ substantially from a hardware-accelerated foreground browser. Early exploratory runs varied with concurrent workloads; this table uses the final isolated, consecutive after/before pair with identical instrumentation. It is a short reproducible sample, not a confidence interval or hardware certification.

Input latency is synthetic DOM key event to the first render showing a changed authoritative local position. It excludes keyboard/OS sampling, compositor presentation and physical scanout. Physical input-to-photon latency was NOT measured; a photodiode or high-speed camera and physical display are required. Real GameView scheduling tests separately prove that smoothing first responds on the same simulation tick/callback as smoothing disabled at every tested refresh schedule.

CPU is Chromium TaskDuration divided by wall time including measurement setup/teardown. JS heap is a snapshot, not process RSS or graphics memory. Caches trade some retained memory for less raster work. GC durations include collector activity and are not all necessarily stop-the-world. The remaining isolated startup long task is visible above; p95/p99 improvement does not mean every stall disappeared. Different wall-clock callback schedules generate different input logs, so benchmark end hashes are not expected to match; identical-log determinism is verified separately.

## Network, rollback and relay traffic

The [24-cell before/after table](docs/benchmarks/NETWORK_BENCHMARK.md) reports actual engine execution over seeded links at 0–600 ms RTT, jitter, random/burst loss, missing browser ticks and 144 Hz callbacks. It includes p95/p99 tick work, CPU/heap, RTT/jitter, rollback counts/depth, stalls, relay queue p50/p95/p99, application bandwidth and message rates. All protocol/traffic/rollback/stall measurements are exactly unchanged by passive telemetry. Network CPU measurements ran alongside other work, so no netcode speedup is claimed.

The separate [real Chromium WebRTC result](docs/benchmarks/webrtc-local.json) covers unordered/unreliable data channels, loopback RTT, a real connection closing, signalling blackhole/timeout, cancellation and agreed relay reconnection with equal replay hashes. The rendezvous is local; this does not measure physical NATs, hosted Supabase outages, global regional latency, or seamless live-run migration. DO deployment was deferred after the [capacity evaluation](relay/README.md); consequently no invented DO latency/bandwidth result appears here.

## What changed and what was investigated

Static terrain used to revisit hundreds of mask tiles on every draw and composite full-stage scratch layers. Its immutable final raster is now cached. Character glows use reusable 192×192 pose tiles rather than reallocating a 640×480 canvas on movement; cached output includes the blur. These reduce traversal, allocations and repeated full-surface overdraw. Draw counts are measured above; exact GPU overdraw/VRAM was not available. Matrix decomposition and output transforms are reused. Filter/mask code no longer temporarily writes into simulation objects.

The separate [asset profile](benchmarks/assets.json) measured 463 image decode promises: p50/p95/p99 0.30/1.80/8.90 ms, peak 9 simultaneously pending (existing limit 12). 471 cold local resources transferred 4.70 MB; scene preparation took 476.80 ms. Decode promise latency includes scheduling and is not isolated decoder CPU. A warmed drawing submitted 7.31 screen-equivalents of main-canvas image rectangles and 2.27 offscreen. This counts transparent/clipped rectangle area, not actual shaded GPU pixels.

Existing WebP/audio packing and the final Pages inventory fit far below 20,000 files, so an atlas was evaluated but not added without evidence of a further win. No object store or asset service was introduced. See [renderer design](docs/RENDERING_PERFORMANCE.md) and [free-tier budget](FREE_TIER_BUDGET.md).

## Validation and reproduction

Checks include all 32 pinned level digests; rollback/snapshot/drift/hostile-link contracts; isolated replay verification; identical 600-frame results in Chromium/Firefox/WebKit; all 32 visual goldens plus level-transition comparisons; full read-only render snapshots; actual GameView scheduling at 60/120/144/240 Hz and 500/1500 ms gaps; TURN configuration rejection; static file/security/asset checks; TypeScript and lint. Missing browsers fail the new browser checks.

```powershell
npm ci
npm --prefix engine run build
npm run bench:render -- after
node engine/test/asset-profile.mjs
node engine/test/performance-report.mjs
npm run bench:network -- --label after
node engine/test/network-report.mjs
node engine/test/render-schedule.mjs
node engine/test/render-readonly.mjs
node engine/test/transport-failover.mjs
node relay/region-selection.test.mjs
```

For a fresh baseline, build commit `7c399f8603918997197785957bcb05b86c72b89f` in a separate checkout, set `FBWG_BENCH_ENGINE` to its compiled engine directory, and use the current `performance.mjs before` harness with the same asset directory. `FBWG_BENCH_SECONDS` adjusts sample length. The preserved local baseline directory is not a committed dependency. Raw browser records: [before](benchmarks/before.json), [after](benchmarks/after.json).

Unmeasured field acceptance remains: physical input-to-photon and high-refresh hardware, mobile/low-end GPU behavior, real NAT combinations, two-user regional relay paths and provider quota refusal. The subsequent [production verification](docs/DEPLOYMENT_STATUS.md) records successful deployment/sign-in/assets checks and observed Free account settings; it does not turn controlled local benchmarks into physical-display or WAN measurements.
# September 12 networking rollout

The [rollout measurements](docs/benchmarks/NETWORK_ROLLOUT_BENCHMARK.md) add fresh
direct/legacy baselines, immediate relay edges, same-session RTC migration and
opt-in rollback/descendant rendering. The
[release report and checklist](docs/NETWORK_ROLLOUT.md) distinguish local passes
from unconfigured hosted TURN acceptance. Presentation flags remain off after
their enabled comparison worsened tail frame/render timing. Earlier evidence
below is retained as historical data.
