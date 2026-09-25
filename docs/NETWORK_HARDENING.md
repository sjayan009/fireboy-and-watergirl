# Realtime hardening evidence — 2026-09-23

## Production rollout status — 2026-09-25

**PathManager was rolled back to OFF in production.** The six networking-stack PRs were merged in order with normal merge commits, and the exact merged source was first deployed successfully with all five feature flags off. The source remains merged; no networking commit was reverted.

| PR | Merge commit |
| --- | --- |
| #24 TURN credentials | `2b70806cb26b501e8a18fd4625a7cbb92ef0cd45` |
| #25 relay edge publishing | `1e14bc48833a23c2cd7e0fa347baa6f70220456c` |
| #26 PathManager | `395f49e4ce655a88a92afeeaf25c2f6dce0fb18d` |
| #27 presentation gates | `bbdaee269e39bd135f5c78a71a5237b8461a727d` |
| #28 QoE evidence | `3df0db3610247eb6d96bbde99bc8805dd0f7f31d` |
| #29 realtime hardening | `a05ae33a6902d4ad440c7684a8050461dd675060` |

All ten validated stack commits were verified as ancestors of merged main `a05ae33a6902d4ad440c7684a8050461dd675060`. The initial dark Cloudflare build `8ad8ccf0-1eb8-48df-8a18-08f0cc35593f` deployed that exact SHA with PathManager off. The live `/version.txt`, `deployed` workflow and a two-player sign-in, friendship, invitation and gameplay smoke passed. The production Workers URL is `https://fireboy-and-watergirl.sjayan009.workers.dev/`.

At 2026-09-24 19:16:59 UTC, Cloudflare deployed build `353326f4-8291-4aa1-b70b-a7cd0788c0a0`, Worker version `5ae8693c-8af0-4f82-a2c9-8f56757b8637`, from the same merged SHA with `FBWG_PATH_MANAGER=1`. The other flags remained false: `FBWG_LEGACY_RELAY_BATCHING`, `FBWG_ROLLBACK_SMOOTHING`, `FBWG_DESCENDANT_INTERPOLATION`, and `FBWG_NETWORK_TEST_HOOKS` were unset. A comparison of the live lobby JavaScript with local flag-on and flag-off builds showed the live code matched the flag-on build after normalizing generated asset filenames. The production `window.fbwgNetworkTest` hook was absent. The enabled `deployed` workflow passed.

Two separate three-minute production sessions signed in disposable pairs, established friendship and invitations, started the same game on both peers, and responded to movement. Both stayed paired without visible reconnect UI or page exceptions. Browser-side RTC observation in the second session found both peers in `connected` ICE and peer-connection state, but one selected candidate pair reported zero received bytes while the other reported received bytes. The first session's WebSocket observer also failed to see a managed-capability frame; the bundle comparison established the compiled flag independently. These observations leave a possible one-way path or fallback regression unresolved, so the strict production smoke gate did **not** pass. Two HTTP 400 responses per session from `register_ranked_attempt` were the expected ranking fallback while no ranked engine version was accepting; no other failed responses were observed. The normal production build contains no failure-injection hook, and no production network disruption was intentionally induced.

Per the rollback rule, `FBWG_PATH_MANAGER` was set to `0` in Cloudflare's production **build** variables and the exact same merged SHA was rebuilt. Rollback build `56e1737a-ac8a-475a-aab9-315f355b3f8d` deployed Worker version `c23e7031-5545-4e07-878c-fb3b6d9ac243` at 2026-09-25 05:16:27 UTC. Live `/version.txt` still reported `a05ae33a6902d4ad440c7684a8050461dd675060`, and its lobby bundle matched a local flag-off build after normalizing generated asset filenames. The rollback smoke passed sign-in, friendship, invitation, gameplay movement and connected direct RTC on both peers; the selected candidate pair byte counts were reciprocal. Every disposable account used by these production smokes was signed out and deleted, with the cleanup helper confirming no test users or associated profiles remained. The rollback `deployed` workflow [passed on the exact merged SHA](https://github.com/sjayan009/fireboy-and-watergirl/actions/runs/36098026641).

The temporary hardening Preview origin remains in Supabase `TURN_ALLOWED_ORIGINS` alongside the Workers production origin so the unresolved path can be investigated in staging. The Vercel `net/realtime-hardening` Preview still has branch-only `FBWG_PATH_MANAGER=1` and `FBWG_NETWORK_TEST_HOOKS=1`; production has no test hooks. Remove that origin and the Preview hook only after a passing production PathManager smoke makes staging unnecessary. Browserbase credentials remain for future manual release gates; the short-lived Preview share secret was already removed.

The new main CI layout is active: `fast` runs on push and pull request; `full` runs Tuesday and Friday at 04:23 UTC or manually; hosted and remote network tests are manual/reusable; `release-gate` dispatches worker-image, hosted and remote gates; `deployed` runs on main push; and `keepalive` runs daily. GitHub Actions billing headroom was checked before the merges. Main branch protection could not be applied: GitHub returned HTTP 403 because this repository is private on GitHub Free. No plan purchase or visibility change was made.

For a future production rollback, set Cloudflare Workers production **build** variable `FBWG_PATH_MANAGER=0`, retry the build for the exact current main commit, wait for `/version.txt` to match that commit, verify the live bundle is flag-off, and repeat the two-player production smoke. Keep all other flags false. Do not revert the merged networking commits unless the flag-off build also fails.

This branch adds a reversible RTC suspect phase above the existing hard timeout. It does not enable PathManager or either presentation flag in production.

## Silent RTC failure

At 26 Hz, 32 repeated input frames cover about 1.23 seconds. A normal path heartbeat is one second. The suspect threshold is 1.5 seconds since the last valid RTC packet: it allows a heartbeat and WAN jitter, but begins relay protection well before the six-second retirement timeout. A 250 ms timer checks the threshold. The old RTC stays open while both peers publish gameplay over the existing private relay. A control message makes the other peer publish too when only one direction failed. Bounded recent input history is reoffered because a stalled NetSession may have stopped producing new packets, and a sender on a one-way failure may have advanced beyond the latest packet's 32-frame window. Two RTC observations at least 250 ms apart end local suspicion; the peer's relay request has a 1.5-second lease so lost recovery controls cannot keep publishing forever. At six seconds of silence the old RTC is retired and the normal fresh attempt proceeds.

Acceptance targets: first-failure relay protection within 1.8 seconds in the deterministic fixture and 2.2 seconds in real Chromium; first clean-session fresh RTC around eight seconds; zero desyncs and link-down notifications; same NetSession, level generation and runSerial; no relay gameplay after healthy promotion; no remaining timers or pair listeners after close. Repeated recovery can exceed eight seconds because the retry budget resets only after 30 seconds of healthy RTC. Gameplay must continue over relay during that backoff.

| Failure direction | Last healthy RTC to relay protection | Failure to fresh RTC |
| --- | ---: | ---: |
| Outbound | 1,700 ms | 6,700 ms |
| Inbound | 1,700 ms | 6,450 ms |
| Both directions | 1,650 ms | 6,450 ms |

The prior code waited for `DEAD_MS = 6000` and a 250 ms timer before relay publication. That is a code-derived 6.0–6.25 second baseline; it was not separately instrumented. The real Chromium run measured 1,547 ms to protection and 7,348 ms to fresh RTC. Both peers reached frame 330 with hash `a10807fd`, generation 1, runSerial 1 and zero desyncs. They recorded 20/17 stalled callbacks, 40/38 rollbacks and deepest rollback 32/31. Another standalone Chromium run measured 1,561 ms and 7,259 ms, also with matching final hashes and zero desyncs. These runs use local byte channels and direct host ICE, not hosted Supabase or Cloudflare TURN.

Deterministic tests cover one-way and two-way blackholes, short transient loss, prolonged loss, recovery before retirement, fresh attempts, old-path packets, duplicate suppression, lost relay-off controls and cleanup. The real NetSession/LevelHost silent-loss run ended at frame 340 and identical hash `016cdd5f` on both peers, generation 1, runSerial 1, zero desyncs, zero stalled callbacks, 46 rollbacks per peer and deepest rollback 8. These are local fixtures, not WAN measurements.

## Repeated failures in one session

The deterministic fixture now keeps the same two `NetSession` and `LevelHost` objects across `close → relay → RTC → silent two-way loss → relay → RTC → close → relay → RTC` and the reverse `silent → RTC → close → RTC → one-way loss → RTC`. It checks frame and confirmed progress while relay packets arrive, generation and runSerial, zero desyncs and link-down callbacks, stale packets from both earlier RTCs, relay publication stopping after promotion, and timer/listener cleanup. A 2,000 ms no-progress bound applies while relay packets arrived within the previous second. A local 20-repetition run passed all 40 sequences and 120 disruptions: maximum relay protection 1,654 ms; maximum fresh RTC 11,385 ms; no observed no-progress interval at the 38.5 ms simulation step resolution; maximum 187 rollbacks on one peer, deepest rollback 36; zero desyncs.

**Root cause reproduced locally.** Before the fix, after a prior recovery and a one-way loss, the receiving peer stopped at frame 450 with confirmed frame 420 while it had received remote input through frame 481. The latest relayed input packet covered only frames 450–481. Frame 420 was missing, so later packets could never advance the confirmed frontier. The 1.5-second suspect interval spans about 39 frames, longer than one 32-frame input-history window; the sender can keep running while its outbound RTC is blackholed. This explains how relay packets can arrive without carrying the missing frame. The previous single-packet replay was insufficient.

PathManager now samples at most eight opaque input packets, at 500 ms spacing and at most 256 bytes each, plus the newest packet. On relay protection it publishes those overlapping snapshots oldest first. The relay's normal held-input coalescing is bypassed for this bounded recovery batch so it cannot discard the older packet containing the gap. The ordinary 115 ms held-input heartbeat, deterministic input semantics, retries, and make-before-break behavior remain. Local tests assert a replayed relay packet covers the blocked frame, bound and age out the sample buffer, preserve immediate edges, and clear the buffer on close. The fix did not change the 1.5-second suspicion threshold, six-second hard timeout, or retry delays `[1000, 2000, 5000, 15000, 30000]` ms.

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

The isolated close and silent variants used the same two accounts in separate pairs of Chromium contexts and fresh games. Each used hosted Auth, friendship, the real private PairChannel, Realtime signaling and gameplay relay, and fresh RTC. They preserved NetSession, view, level, generation 1 and runSerial 1, stopped relay publishing after promotion, ignored retired RTC traffic, and converged with zero desyncs. Live session hashes matched at a shared confirmed frame.

| Hosted disruption | Relay protection | Fresh RTC | Shared confirmed live digest |
| --- | ---: | ---: | --- |
| Explicit RTC close | 58 ms | 1,240 ms | frame 88, `9f4057d9` |
| Silent two-way RTC blackhole | 1,790 ms | 7,480 ms | frame 240, `a10807fd` |

The new hosted suite then kept each game's same contexts, users, invitation, `NetSession`, view, level, generation and runSerial through two disruptions. It ran the full acceptance twice: six `close → relay → RTC → silent → relay → RTC` games and six `silent → relay → RTC → close → relay → RTC` games overall, with exactly two newly created disposable accounts per suite run. All 12 repeated games passed. The final, stricter run required input packets to cross the relay while both peers were still on relay and their frame and confirmed counters advanced. Relay publishing stopped after each promotion; callbacks from every retired attempt were ignored; shared confirmed live digests matched; there were zero reconnect notices and zero desyncs. The worst repeated-run no-progress interval with relay packets arriving was 339 ms across both runs (251 ms in the final run), below the explicit 3,000 ms hosted bound. The longest repeated silent protection time was 1,928 ms; the longest fresh RTC time was 9,238 ms after a prior failure. The final run recorded at most 54 rollbacks on one peer, deepest rollback 36 and at most 29 stalled callbacks, with recovery and no desyncs. The longer RTC latency reflects the intentional retry backoff, not a gameplay freeze. Earlier diagnostic runs had observed 9.7–14.4-second recoveries and one unexplained relay-arriving stall; the deterministic missing-history reproduction and passing repeated hosted runs provide an explanation and regression coverage, but do not measure every real network.

The hosted harness records per-peer path state, attempt generation and nonce, retry index/timing, relay and RTC counters, duplicate count, session frame/confirmed/stalls/rollbacks, and a bounded trace of relay packet type, slot, epoch, history length and represented frame range. Failure output contains no Auth tokens, TURN credentials or passwords. A 3,000 ms no-progress threshold starts with relay receipt: it allows much more than one 115 ms held-input heartbeat plus WAN jitter, yet fails a sustained gap before the six-second RTC retirement can hide it. The final read-only cleanup check found **0** `fbwg_network_acceptance_*` users and **0** associated test profiles.

PathManager may proceed to a **staged preview two-person test** after the final normal validation and branch preview build. It remains **OFF in production**. No production client deployment or merge was performed.

## Staged real-device preview procedure

1. In the existing Vercel project's Environment Variables, select **Preview** and the exact `net/realtime-hardening` branch. Set `FBWG_PATH_MANAGER=1` and `FBWG_NETWORK_TEST_HOOKS=1` on that branch only. Set `FBWG_LEGACY_RELAY_BATCHING=0`, `FBWG_ROLLBACK_SMOOTHING=0`, and `FBWG_DESCENDANT_INTERPOLATION=0` there. Keep `FBWG_PATH_MANAGER=0` for Production. These are compile-time Vite flags; a preview build must run after the branch-scoped values are saved. [Vercel documents branch-specific Preview variables](https://vercel.com/docs/environment-variables).
2. Use the Git-triggered preview for the validated commit, and confirm its commit/version before inviting anyone. Ensure that preview has only the public Supabase URL and publishable key needed by the client. If hosted sign-in or TURN issuance rejects the preview origin, add that exact preview origin to the relevant Supabase redirect/CORS and TURN broker origin allowlists through the normal staged configuration process. Do not put any service key or Cloudflare master TURN credential in Vercel or the browser.
3. On Device A use normal Wi-Fi; on Device B use a phone hotspot or separate network. Open the same preview URL in Chromium on both, sign in with disposable accounts, become friends, send an invitation, and start a level. Open DevTools on each device and run `fbwgNetworkTest.snapshot()`. Confirm `path: "rtc"`, `state: "RTC_ACTIVE"`, and `running: true`.
4. Start a bounded local trace on each console: `window.fbwgSamples=[]; window.fbwgSampleTimer=setInterval(()=>{fbwgSamples.push(fbwgNetworkTest.snapshot()); if(fbwgSamples.length>2000) fbwgSamples.shift()},250)`. On Device B run `fbwgNetworkTest.closeRtc()`; it returns `true` when an active RTC was closed. Watch both snapshots move through `relay` and back to `rtc`, with increasing frame/confirmed and relay counters. Repeat after recovery by running `fbwgNetworkTest.blackholeRtc()` on **both** devices; it silently drops the current RTC's outgoing traffic while leaving the hosted relay available. This hook exists only in a build explicitly flagged with `FBWG_NETWORK_TEST_HOOKS=1` and PathManager enabled.
5. Keep playing during each relay interval. Confirm `sameSession`, `sameLevel`, generation, runSerial, and zero desyncs. After both recoveries, stop each trace with `clearInterval(window.fbwgSampleTimer)` and export only `JSON.stringify(window.fbwgSamples)` from each console. The snapshot contains counters and path state, not tokens, passwords, ICE credentials or user identities. Sign out and delete disposable users after the test.

No Cloudflare master secret was read, changed or put in the client. The build secret scan passed. The broker's per-isolate issuance throttle remains a best-effort abuse control, not a global billing cap. The suspect control messages are scoped to the current RTC nonce and generation. The replay cache is strictly bounded and cleared on close.
