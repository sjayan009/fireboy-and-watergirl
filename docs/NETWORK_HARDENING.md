# Realtime hardening evidence — 2026-09-23

This branch adds a reversible RTC suspect phase above the existing hard timeout. It does not enable PathManager or either presentation flag in production.

## Silent RTC failure

At 26 Hz, 32 repeated input frames cover about 1.23 seconds. A normal path heartbeat is one second. The suspect threshold is 1.5 seconds since the last valid RTC packet: it allows a heartbeat and WAN jitter, but begins relay protection well before the six-second retirement timeout. A 250 ms timer checks the threshold. The old RTC stays open while both peers publish gameplay over the existing private relay. A control message makes the other peer publish too when only one direction failed. The most recent bounded input packet is reoffered because a stalled NetSession may have stopped producing new packets. Two RTC observations at least 250 ms apart end local suspicion; the peer's relay request has a 1.5-second lease so lost recovery controls cannot keep publishing forever. At six seconds of silence the old RTC is retired and the normal fresh attempt proceeds.

Acceptance targets: relay protection within 1.8 seconds in the deterministic fixture and 2.2 seconds in real Chromium; fresh RTC within eight seconds of a silent failure; zero desyncs and link-down notifications; same NetSession, level generation and runSerial; no relay gameplay after healthy promotion; no remaining timers or pair listeners after close. These targets passed locally.

| Failure direction | Last healthy RTC to relay protection | Failure to fresh RTC |
| --- | ---: | ---: |
| Outbound | 1,700 ms | 6,700 ms |
| Inbound | 1,700 ms | 6,450 ms |
| Both directions | 1,650 ms | 6,450 ms |

The prior code waited for `DEAD_MS = 6000` and a 250 ms timer before relay publication. That is a code-derived 6.0–6.25 second baseline; it was not separately instrumented. The real Chromium run measured 1,547 ms to protection and 7,348 ms to fresh RTC. Both peers reached frame 330 with hash `a10807fd`, generation 1, runSerial 1 and zero desyncs. They recorded 20/17 stalled callbacks, 40/38 rollbacks and deepest rollback 32/31. Another standalone Chromium run measured 1,561 ms and 7,259 ms, also with matching final hashes and zero desyncs. These runs use local byte channels and direct host ICE, not hosted Supabase or Cloudflare TURN.

Deterministic tests cover one-way and two-way blackholes, short transient loss, prolonged loss, recovery before retirement, fresh attempts, old-path packets, duplicate suppression, lost relay-off controls and cleanup. The real NetSession/LevelHost silent-loss run ended at frame 340 and identical hash `016cdd5f` on both peers, generation 1, runSerial 1, zero desyncs, zero stalled callbacks, 46 rollbacks per peer and deepest rollback 8. These are local fixtures, not WAN measurements.

## Relay held-input heartbeat

The edge publisher keeps changed input bits, commands and epoch boundaries immediate in both variants. Only the unchanged hold heartbeat differs. The seeded 20-second NetSession/LevelHost network experiment covers LAN, regional, 150/300/600 ms RTT, burst loss, a background tab and 144 Hz callbacks. Payload estimates include the serialized scoped message and exclude Phoenix, WebSocket, TLS and IP overhead. Message consumption is estimated from publishes, not provider billing data. Full rows are in `docs/benchmarks/network-heartbeat-experiment.json`.

| Held heartbeat | Mean publishes/s across 8 cases | Mean serialized bytes/s | Edge queue p95 | 600 ms RTT deepest rollback | Background held queue p95 |
| --- | ---: | ---: | ---: | --- | ---: |
| 115 ms | 21.97 | 4,267 | 0.33 ms | 24 / 21 | 48.67 ms |
| 230 ms | 15.08 | 2,910 | 0.33 ms | 31 / 21 | 129.67 ms |

All cells converged with zero desyncs and matched their own replay hashes. The 600 ms cells did not share the same final hash across variants because their input/frame progression differed, so they are not evidence of byte-identical mode behavior. The background case had 275 versus 217 stalled callbacks and deepest rollback 37/9 versus 37/15 (115 versus 230 ms). Retain **115 ms** as the default: the lower usage of 230 ms does not outweigh its deeper hostile-link rollback and background queue tail. This experiment does not claim a hosted cost reduction.

## Presentation benchmark

The four configurations were run sequentially in headless Chromium for 20 seconds each, using the existing canvas instrumentation and timed steering. Frame times include the browser's display cadence; the input metric is event-to-render callback, not physical scanout. CPU is Chromium TaskDuration divided by wall time. Runs have different digests because the timed input sequence can advance differently; this is a performance comparison, not a cross-variant determinism test. Existing render reconciliation tests cover simulation state separation. The JSON files' `commit` field names the pre-commit HEAD; the working tree contained this branch's changes during measurement.

| Rollback smoothing / descendant interpolation | Frame p95 / p99 | Render p95 | Input-to-render p95 | Long tasks | Main-thread CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| 00 off / off | 16.8 / 16.8 ms | 8.5 ms | 64.2 ms | 2 | 86.2% |
| 10 on / off | 16.7 / 16.8 ms | 8.5 ms | 54.4 ms | 1 | 87.6% |
| 01 off / on | 16.8 / 16.8 ms | 8.4 ms | 58.0 ms | 2 | 86.0% |
| 11 on / on | 16.8 / 16.8 ms | 8.4 ms | 54.1 ms | 2 | 85.6% |

The input proxy varied, but the short solo runs do not clearly establish a production benefit. Leave both flags **OFF**.

## Hosted acceptance and security boundary

On 2026-09-23, `npm run test:network-hosted` created two fresh, confirmed `fbwg_network_acceptance_` users with random passwords, signed them in through normal Auth, and verified both Admin deletions after browser and programmatic sign-out. The credentials stayed in process memory. Its live TURN stage verified missing and forged bearer tokens both return 401 with `Cache-Control: no-store`; the disposable user's token issued short-lived credentials with `no-store`; both Chromium peers forced relay-only ICE, selected `candidateType=relay` over Cloudflare TURN, played an active level, matched confirmed input and replay hashes, and reported zero desyncs. TURN was tested separately from hosted migration.

The two hosted variants used the same two accounts in separate pairs of Chromium contexts and fresh game sessions. Both signed in through hosted Auth, became friends, used the real private PairChannel and Realtime signaling, played an active level, sent and received gameplay through the hosted emergency relay, then promoted a fresh RTC without replacing NetSession, the view or the level, or changing generation 1 or runSerial 1. Relay gameplay publishing stopped after promotion, an injected late callback from the retired RTC was ignored in the silent case, and the peers converged with zero desyncs. Live session hashes matched at a shared confirmed frame.

| Hosted disruption | Relay protection | Fresh RTC | Shared confirmed live digest |
| --- | ---: | ---: | --- |
| Explicit RTC close | 14 ms | 1,600 ms | frame 88, `9f4057d9` |
| Silent two-way RTC blackhole | 1,419 ms | 7,349 ms | frame 224, `f6ce2a58` |

Several diagnostic runs exposed timing variability. A silent recovery took 9.7–14.4 seconds in earlier runs, above the eight-second target, and one back-to-back close-then-blackhole run in the same game received hosted relay packets while a peer made no frame progress before RTC recovery. The final isolated variants passed, but those observations warrant further investigation before enabling PathManager for a staged production test. PathManager remains **OFF** for production. No client deployment or merge was performed.

No Cloudflare master secret was read, changed or put in the client. The build secret scan passed. The broker's per-isolate issuance throttle remains a best-effort abuse control, not a global billing cap. The suspect control messages are scoped to the current RTC nonce and generation. The cached input packet is bounded to 256 bytes and cleared on close. No client deployment or merge is part of this branch.
