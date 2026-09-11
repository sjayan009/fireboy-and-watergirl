# Network measurements — 2026-09-11

All 24 scenarios passed before and after. Packet counts, payload bytes, RTT/jitter estimators, rollback depth/count, stalled callbacks and final frames are exactly unchanged. Passive transport counters and the RTT-poll cleanup do not change the protocol or transmission cadence. `network-report.mjs` asserts these invariants.

The deterministic harness runs the production NetSession, LevelHost and RealtimeTransport for 20 virtual seconds/cell. Network delay/loss is injected with a seeded RNG and deadline-ordered delivery; it is not a measurement of hosted Supabase or global Internet routes. The final loss-free drain verifies shared input logs, zero desyncs and each world's replay hash. Browser throttling is a 1.5-second missing-tick interval; 144 Hz is a virtual callback cadence. Physical high-refresh hardware and browser OS suspension remain separate field measurements.

Timing is real Node CPU/wall time on this host. These runs overlap other browser/build work, so p99 fluctuations are not evidence of a netcode speedup or regression. Heap is the shared Node process at cell end (GC phases vary), while snapshot bytes are per peer. Do not use these values as display frame-time or input-to-photon results.

## Before / after

Transport traffic below counts both players. Supabase bytes include the 74-byte attempt/session prefix before base64 and the `{p: [...]}` envelope; Phoenix topic/event/ref, WebSocket/TLS/TCP/IP headers are excluded. Realtime publishes also incur receiver deliveries in the quota model. Stalls are callbacks marked stalled, not unique stall incidents. Queue measurements use protocol timestamps rounded to whole milliseconds (up to 0.5ms quantization error); the direct path has no intentional queue despite its fractional rounding residual in the table.

| Transport / scenario | Tick p95 ms before → after | Tick p99 ms before → after | CPU ms before → after | Heap MB before → after | Rollbacks/s before → after | Stalled callback % before → after | Messages/s before → after | Payload B/s before → after | Queue p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| direct / LAN | 5.75 → 5.69 | 8.16 → 9.04 | 2015.00 → 2108.00 | 89.75 → 92.86 | 7.40 → 7.40 | 0.00 → 0.00 | 52.05 → 52.05 | 3331.00 → 3331.00 | 0.33 |
| direct / regional | 6.02 → 6.07 | 20.26 → 9.32 | 1485.00 → 1735.00 | 72.60 → 77.00 | 11.20 → 11.20 | 0.00 → 0.00 | 52.20 → 52.20 | 3330.15 → 3330.15 | 0.33 |
| direct / 150ms | 5.98 → 5.31 | 19.20 → 8.06 | 1406.00 → 1468.00 | 113.15 → 129.88 | 12.30 → 12.30 | 0.00 → 0.00 | 52.45 → 52.45 | 3333.15 → 3333.15 | 0.33 |
| direct / 300ms | 5.65 → 5.20 | 10.46 → 7.99 | 1407.00 → 1344.00 | 166.66 → 197.70 | 12.85 → 12.85 | 0.00 → 0.00 | 52.70 → 52.70 | 3325.55 → 3325.55 | 0.33 |
| direct / 600ms | 5.51 → 4.50 | 11.38 → 8.47 | 1437.00 → 1235.00 | 209.40 → 237.41 | 10.80 → 10.80 | 0.00 → 0.00 | 52.85 → 52.85 | 3308.80 → 3308.80 | 0.33 |
| direct / burst_loss | 5.36 → 5.65 | 9.33 → 8.97 | 1359.00 → 1375.00 | 266.33 → 75.60 | 11.65 → 11.65 | 0.00 → 0.00 | 52.25 → 52.25 | 3325.45 → 3325.45 | 0.33 |
| direct / background_tab | 8.47 → 8.50 | 12.27 → 16.85 | 2984.00 → 3203.00 | 124.55 → 171.95 | 23.50 → 23.50 | 12.00 → 12.00 | 49.25 → 49.25 | 3130.45 → 3130.45 | 0.33 |
| direct / 144hz | 0.29 → 1.72 | 8.09 → 54.26 | 1438.00 → 2219.00 | 184.69 → 222.92 | 11.05 → 11.05 | 0.00 → 0.00 | 52.50 → 52.50 | 3333.75 → 3333.75 | 0.39 |
| supabase230 / LAN | 2.88 → 5.01 | 8.88 → 22.50 | 1062.00 → 1140.00 | 221.92 → 266.33 | 7.85 → 7.85 | 0.00 → 0.00 | 8.75 → 8.75 | 9814.20 → 9814.20 | 217.00 |
| supabase230 / regional | 2.98 → 7.98 | 10.21 → 52.93 | 906.00 → 1141.00 | 267.94 → 72.65 | 7.50 → 7.50 | 0.00 → 0.00 | 8.95 → 8.95 | 9839.40 → 9839.40 | 219.13 |
| supabase230 / 150ms | 2.39 → 5.18 | 8.44 → 43.31 | 891.00 → 1173.00 | 309.48 → 119.60 | 7.05 → 7.05 | 0.00 → 0.00 | 9.35 → 9.35 | 9871.95 → 9871.95 | 216.41 |
| supabase230 / 300ms | 2.38 → 9.42 | 10.52 → 61.78 | 954.00 → 1891.00 | 93.72 → 92.48 | 6.70 → 6.70 | 0.00 → 0.00 | 9.90 → 9.90 | 9910.25 → 9910.25 | 217.00 |
| supabase230 / 600ms | 1.77 → 2.31 | 12.20 → 17.64 | 859.00 → 922.00 | 146.43 → 132.63 | 5.95 → 5.95 | 0.83 → 0.83 | 11.10 → 11.10 | 9930.25 → 9930.25 | 214.35 |
| supabase230 / burst_loss | 8.08 → 4.33 | 61.67 → 26.36 | 1187.00 → 1407.00 | 182.76 → 174.90 | 7.70 → 7.70 | 0.00 → 0.00 | 9.35 → 9.35 | 9862.40 → 9862.40 | 217.27 |
| supabase230 / background_tab | 8.95 → 7.77 | 32.24 → 10.11 | 2673.00 → 2984.00 | 259.62 → 244.37 | 19.15 → 19.15 | 3.46 → 3.46 | 9.05 → 9.05 | 9230.00 → 9230.00 | 217.00 |
| supabase230 / 144hz | 0.21 → 0.15 | 7.57 → 6.56 | 937.00 → 922.00 | 291.33 → 283.20 | 6.75 → 6.75 | 0.00 → 0.00 | 9.30 → 9.30 | 9896.65 → 9896.65 | 215.13 |
| supabase115 / LAN | 5.23 → 4.22 | 10.72 → 9.47 | 1235.00 → 1313.00 | 122.21 → 100.06 | 9.75 → 9.75 | 0.00 → 0.00 | 17.45 → 17.45 | 9932.40 → 9932.40 | 110.00 |
| supabase115 / regional | 5.12 → 3.96 | 10.36 → 9.30 | 1266.00 → 1234.00 | 161.46 → 153.19 | 10.50 → 10.50 | 0.00 → 0.00 | 17.65 → 17.65 | 9957.60 → 9957.60 | 110.00 |
| supabase115 / 150ms | 4.51 → 4.81 | 10.49 → 10.18 | 1265.00 → 1437.00 | 214.07 → 201.33 | 10.45 → 10.45 | 0.00 → 0.00 | 18.00 → 18.00 | 9989.80 → 9989.80 | 108.00 |
| supabase115 / 300ms | 4.70 → 4.08 | 9.77 → 9.64 | 1188.00 → 1468.00 | 258.58 → 83.93 | 9.80 → 9.80 | 0.00 → 0.00 | 18.50 → 18.50 | 9999.10 → 9999.10 | 108.00 |
| supabase115 / 600ms | 4.11 → 3.84 | 10.93 → 10.96 | 1157.00 → 1344.00 | 117.52 → 115.72 | 8.50 → 8.50 | 0.00 → 0.00 | 19.60 → 19.60 | 10047.05 → 10047.05 | 108.35 |
| supabase115 / burst_loss | 5.08 → 4.40 | 9.54 → 9.93 | 1282.00 → 1281.00 | 166.87 → 176.60 | 10.25 → 10.25 | 0.00 → 0.00 | 18.00 → 18.00 | 9980.25 → 9980.25 | 109.27 |
| supabase115 / background_tab | 8.28 → 7.62 | 12.91 → 10.63 | 3000.00 → 3016.00 | 248.76 → 260.02 | 22.65 → 22.65 | 11.50 → 11.50 | 17.30 → 17.30 | 9392.80 → 9392.80 | 109.27 |
| supabase115 / 144hz | 0.26 → 0.23 | 8.77 → 7.48 | 1407.00 → 1313.00 | 95.08 → 83.39 | 10.20 → 10.20 | 0.00 → 0.00 | 18.00 → 18.00 | 10005.30 → 10005.30 | 106.14 |

## What the measurements show

At 600 ms RTT, ±100 ms one-way jitter and 20% injected message loss, the 230 ms Supabase batch has 20 stalled callbacks; 115 ms has zero, at 19.6 vs 11.1 publishes/s. This supports retaining the existing explicit hurry tradeoff, not enabling it for everyone. The 230 ms regional queue p95 is 219.1 ms. A binary unbatched relay could remove that browser queue, but actual relay route/TCP latency is unmeasured and its Free capacity is small; see [the relay evaluation](../../relay/README.md).

## Actual Chromium loopback transport

The direct channel negotiated in 97.60 ms and its real getStats RTT samples were 0.00 / 1.00 ms. Closing one real peer connection notified both sessions once in 48.40 ms. The old stats timers stopped. A new agreed relay-only attempt was ready in 0.00 ms and both peers advanced 60 / 60 frames to the same hash. The rendezvous here is local: this proves the owner reconnect seam, not a hosted Supabase outage or a seamless mid-level migration.

The test also verifies unordered/maxRetransmits=0, exact typed-array slice boundaries, actual handshake timeout under blackholed signalling, and cancellation without unwanted fallback. It fails rather than silently skipping when Chromium is unavailable.

## Reproduce

```powershell
npm --prefix engine run build
node engine/test/networkbench.mjs --label after
node engine/test/transport-failover.mjs
node engine/test/network-report.mjs
node relay/region-selection.test.mjs
```

Raw data: [before](network-before.json), [after](network-after.json), [loopback RTC](webrtc-local.json). Browser/render results are documented separately.
