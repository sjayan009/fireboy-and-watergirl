# Network and presentation rollout measurements

Baseline captured 2026-09-12T23:18:07.923Z; after captured 2026-09-12T23:39:43.231Z. Baseline source was compiled/read before edits on main at 1717cf1. Raw records include source and timestamps; the render records identify the original HEAD because these changes were uncommitted during measurement.

All 24 direct/legacy cells reproduce the same logical frames, packet counts, bytes, RTT/jitter estimates, rollback counts/depths, stalls and queue quantiles. The additional eight edge-publisher cells have matching input logs and replay hashes after draining delivery. Key transitions have at most 1 ms quantized application queue p95. No edge cell increases stalled callbacks relative to 115 ms batching; the 230 ms background-tab cell remains less stall-prone than either faster mode.

This is the real 26 Hz NetSession/LevelHost and RealtimeTransport over a seeded virtual network, 20 virtual seconds per cell. Loss/jitter/RTT are injected, including 600 ms RTT, ±100 ms one-way jitter and 20% message loss. Node CPU and tick timings are actual local measurements; they are not browser/main-thread or WAN observations. Transport queue timestamps are rounded to whole milliseconds (direct 0.33 ms is quantization, not deliberate pacing).

Payload accounting retains the historical 74-byte modeled scope prefix before base64 for matched comparison. Production UUID attempt scoping is 37 bytes; managed gameplay adds 17 bytes. Phoenix/WebSocket/TLS/IP headers and provider deliveries are excluded from bytes. Supabase meters publishes plus deliveries; see FREE_TIER_BUDGET.md.

| Mode/scenario | Queue p50/p95/max ms | Edge p95 ms | RTT p50/p95 ms | Jitter per peer ms | Rollbacks | Deepest | Stalled callbacks | Publishes/s | Payload B/s | Node CPU ms | Shared replay hash |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| direct/LAN | 0.00 / 0.33 / 0.33 | 0.33 | 0.47 / 0.48 | 0.31 / 0.31 | 74/74 | 7/7 | 0/0 | 52.05 | 3331.00 | 2297.00 | 75e85c16 |
| direct/regional | 0.00 / 0.33 / 0.33 | 0.33 | 78.49 / 83.21 | 8.03 / 5.92 | 150/74 | 9/7 | 0/0 | 52.20 | 3330.15 | 1984.00 | 6f09685c |
| direct/150ms | 0.00 / 0.33 / 0.41 | 0.33 | 146.10 / 158.81 | 16.57 / 25.59 | 135/111 | 11/9 | 0/0 | 52.45 | 3333.15 | 1781.00 | e376c025 |
| direct/300ms | 0.00 / 0.33 / 0.33 | 0.33 | 297.43 / 315.06 | 37.22 / 30.31 | 124/133 | 15/12 | 0/0 | 52.70 | 3325.55 | 1577.00 | 945408df |
| direct/600ms | 0.00 / 0.33 / 0.35 | 0.33 | 599.81 / 636.46 | 83.50 / 73.06 | 113/103 | 22/17 | 0/0 | 52.85 | 3308.80 | 1532.00 | a3f76378 |
| direct/burst_loss | 0.00 / 0.33 / 0.33 | 0.33 | 145.66 / 154.08 | 15.26 / 9.19 | 122/111 | 16/20 | 0/0 | 52.25 | 3325.45 | 1765.00 | eeba622a |
| direct/background_tab | 0.00 / 0.33 / 0.33 | 0.33 | 146.30 / 154.74 | 16.74 / 15.84 | 110/360 | 37/8 | 288/0 | 49.25 | 3130.45 | 3734.00 | 62b6dec5 |
| direct/144hz | 0.00 / 0.39 / 0.44 | 0.39 | 77.92 / 82.30 | 7.24 / 6.24 | 146/75 | 10/8 | 0/0 | 52.50 | 3333.75 | 2032.00 | 6f09685c |
| supabase230/LAN | 113.00 / 217.00 / 227.00 | 217.00 | 119.96 / 140.83 | 60.62 / 60.62 | 82/75 | 13/13 | 0/0 | 8.75 | 9814.20 | 1640.00 | 75e85c16 |
| supabase230/regional | 113.14 / 219.13 / 229.14 | 220.00 | 199.78 / 226.17 | 60.38 / 60.76 | 73/77 | 14/13 | 0/0 | 8.95 | 9839.40 | 1484.00 | 6f09685c |
| supabase230/150ms | 113.00 / 216.41 / 227.00 | 207.00 | 271.03 / 301.17 | 60.89 / 58.79 | 68/73 | 26/19 | 0/0 | 9.35 | 9871.95 | 1046.00 | e376c025 |
| supabase230/300ms | 113.00 / 217.00 / 227.68 | 210.00 | 413.42 / 457.18 | 57.21 / 56.99 | 68/66 | 24/26 | 0/0 | 9.90 | 9910.25 | 1141.00 | 5ff12fb7 |
| supabase230/600ms | 110.00 / 214.35 / 228.35 | 210.00 | 715.54 / 802.53 | 57.84 / 64.01 | 54/65 | 36/30 | 18/2 | 11.10 | 9930.25 | 1281.00 | 935704b9 |
| supabase230/burst_loss | 113.00 / 217.27 / 227.27 | 220.00 | 268.13 / 293.60 | 60.59 / 58.35 | 77/77 | 21/19 | 0/0 | 9.35 | 9862.40 | 1280.00 | 5aaa4c5b |
| supabase230/background_tab | 113.00 / 217.00 / 230.33 | 219.67 | 266.12 / 300.56 | 56.31 / 62.19 | 71/312 | 36/13 | 83/0 | 9.05 | 9230.00 | 3516.00 | 3422a288 |
| supabase230/144hz | 113.14 / 215.13 / 230.00 | 213.00 | 199.27 / 223.53 | 59.68 / 59.01 | 70/65 | 20/19 | 0/0 | 9.30 | 9896.65 | 1015.00 | 6f09685c |
| supabase115/LAN | 57.00 / 110.00 / 113.00 | 108.00 | 74.20 / 96.54 | 49.11 / 49.11 | 100/95 | 10/10 | 0/0 | 17.45 | 9932.40 | 1437.00 | 75e85c16 |
| supabase115/regional | 57.00 / 110.00 / 114.14 | 109.14 | 150.66 / 178.76 | 48.87 / 49.32 | 113/97 | 11/10 | 0/0 | 17.65 | 9957.60 | 1546.00 | 6f09685c |
| supabase115/150ms | 56.41 / 108.00 / 113.41 | 107.00 | 222.66 / 245.18 | 49.88 / 52.49 | 107/102 | 14/14 | 0/0 | 18.00 | 9989.80 | 1453.00 | c94f1cc2 |
| supabase115/300ms | 57.00 / 108.00 / 113.68 | 107.00 | 369.20 / 396.33 | 50.44 / 54.61 | 101/95 | 19/19 | 0/0 | 18.50 | 9999.10 | 1360.00 | d8101402 |
| supabase115/600ms | 53.35 / 108.35 / 114.35 | 109.35 | 667.86 / 729.05 | 55.30 / 48.61 | 85/85 | 27/22 | 0/0 | 19.60 | 10047.05 | 2235.00 | 0c9aea93 |
| supabase115/burst_loss | 55.00 / 109.27 / 114.27 | 110.00 | 221.97 / 240.72 | 50.12 / 49.59 | 105/100 | 22/15 | 0/0 | 18.00 | 9980.25 | 1812.00 | 91acb759 |
| supabase115/background_tab | 47.27 / 109.27 / 115.33 | 108.67 | 218.05 / 244.48 | 45.74 / 50.24 | 99/354 | 37/12 | 276/0 | 17.30 | 9392.80 | 3562.00 | 61ffb1b1 |
| supabase115/144hz | 55.13 / 106.14 / 115.14 | 105.14 | 151.27 / 178.36 | 49.73 / 50.38 | 110/94 | 13/14 | 0/0 | 18.00 | 10005.30 | 1578.00 | 6f09685c |
| supabaseEdge/LAN | 29.67 / 48.67 / 48.67 | 0.33 | 46.74 / 59.88 | 22.88 / 25.92 | 64/64 | 10/9 | 0/0 | 21.55 | 4229.90 | 1281.00 | 75e85c16 |
| supabaseEdge/regional | 29.67 / 48.33 / 48.67 | 0.33 | 119.85 / 129.63 | 27.05 / 28.66 | 91/64 | 12/9 | 0/0 | 21.65 | 4236.30 | 1766.00 | 6f09685c |
| supabaseEdge/150ms | 16.33 / 48.67 / 48.67 | 0.33 | 189.18 / 203.81 | 26.29 / 33.81 | 117/105 | 15/14 | 0/0 | 21.85 | 4253.50 | 1546.00 | e376c025 |
| supabaseEdge/300ms | 29.67 / 48.33 / 48.67 | 0.33 | 336.11 / 356.69 | 39.87 / 39.62 | 112/101 | 16/16 | 0/0 | 22.45 | 4337.10 | 1780.00 | b006347a |
| supabaseEdge/600ms | 30.00 / 48.33 / 48.67 | 0.33 | 634.81 / 676.86 | 86.82 / 86.18 | 93/97 | 24/21 | 0/0 | 23.60 | 4495.40 | 1704.00 | 11a137b2 |
| supabaseEdge/burst_loss | 29.67 / 48.33 / 48.67 | 0.33 | 188.45 / 199.68 | 22.55 / 25.70 | 99/77 | 23/19 | 0/0 | 22.10 | 4302.40 | 1485.00 | eeba622a |
| supabaseEdge/background_tab | 29.67 / 48.67 / 115.33 | 0.33 | 190.50 / 211.12 | 24.74 / 27.07 | 108/348 | 37/9 | 275/0 | 20.90 | 4064.80 | 3515.00 | 62b6dec5 |
| supabaseEdge/144hz | 0.72 / 38.83 / 39.06 | 0.39 | 103.11 / 115.14 | 21.18 / 21.05 | 108/63 | 12/11 | 0/0 | 21.65 | 4215.30 | 1313.00 | 6f09685c |

## Browser renderer

Sequential 20-second Chromium headless runs with position-feedback DOM input, actual art and the existing tracing/canvas instrumentation. No other agent-started browser benchmark ran concurrently. Each column is one run, not a statistical certification. The default preserves presentation flags off. Both features remain opt-in because their enabled comparison worsened tail frame/render timing. All runs stayed in a level with complete art and no page exceptions.

| Metric | Before | Default after | Both presentation flags on |
|---|---:|---:|---:|
| Frame p95 ms | 16.80 | 16.80 | 33.30 |
| Frame p99 ms | 16.80 | 33.30 | 33.40 |
| Render p95 ms | 9.70 | 9.90 | 11.90 |
| Input-to-render proxy p95 ms | 50.50 | 52.10 | 52.20 |
| Long tasks>50ms | 1.00 | 1.00 | 2.00 |
| Longest task ms | 248.00 | 508.00 | 310.00 |
| Main-task CPU% | 84.19 | 83.35 | 90.94 |

Display hashes differ across wall-clock runs because the steering samples inputs at different times and reaches different frame counts. Hash invariance is tested using identical scripted replay inputs, pinned level digests and read-only render snapshots, not by comparing these unrelated live input logs. Input latency excludes physical input and scanout. CPU is Chromium TaskDuration/wall time including instrumentation. Startup long tasks remain.

## Real RTC migration

Chromium host/UDP RTC was active in 352.20 ms. Closing one peer connection selected local emergency relay in 19.70 ms and a fresh verified RTC path in 817.10 ms from failure. Both peers retained generation 1 and runSerial 1, reached frame 144, hash 86fe42ec; link-down callbacks 0/0, stalls 0/0. Relay gameplay stopped after promotion, retired stats timers and subscriptions were cleaned up. This is a real browser RTC path and local ByteChannel relay, not hosted Supabase.

Deterministic path-manager tests also compare a 220-frame run with and without migration: both reach 514ceabe, generation 1, runSerial 1. They exercise control loss/reordering, stale attempts, asymmetric failure, silent blackholes, retry bounds, subscriber cleanup, credential-load races and actual PairChannel buffering across a two-second outage.

## Unmeasured deployment cells

Forced Cloudflare TURN and hosted Supabase relay/failover were not run: the user confirmed that the broker is not configured and requested the deployment checklist. Their queue/RTT/jitter, input-to-render, frame/render, long-task and CPU fields remain unavailable. The local network simulator has no renderer; the renderer benchmark has no WAN. No averages or local mocks establish those missing results.

## Reproduce

```powershell
npm --prefix engine run build
node engine/test/networkbench.mjs --label rollout-after
node app/test/pathmanager-webrtc.mjs
$env:FBWG_BENCH_SECONDS="20"
$env:FBWG_BENCH_STEERING="position"
$env:FBWG_BENCH_ROLLBACK_SMOOTHING="0"
$env:FBWG_BENCH_DESCENDANTS="0"
node engine/test/performance.mjs rollout-default
$env:FBWG_BENCH_ROLLBACK_SMOOTHING="1"
$env:FBWG_BENCH_DESCENDANTS="1"
node engine/test/performance.mjs rollout-after
node engine/test/network-rollout-report.mjs
```

Preserve the checked-in before artifacts. To recreate them, build original main 1717cf1 in an isolated checkout and use the same harness. Run browser benchmarks sequentially. Existing historical network-report.mjs retains its September 11 input files; this report uses separate rollout artifacts.
