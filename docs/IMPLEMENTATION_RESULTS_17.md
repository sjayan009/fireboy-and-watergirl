# Results: the 17 implementation packages

Implemented in the shared checkout on October 2–3, 2026, starting from
`ece3f5dce1e1998b2609fcf8bd8fe4244366b7f7`. The original handoff, audit, and raw
baseline measurements are preserved. No application deployment or live
database/schema modification was performed during implementation.

The deterministic simulation remains **26 Hz**. Local presentation preferences,
asset ownership, renderer caches, and delivery services live outside the Game
graph and its reflective rollback snapshots. Packet bodies and epoch validation
remain compatible; the generated engine version identifies the current source.

## Package status

“Verified” below means the named local checks passed. Hosted services, physical
display performance, and native/GPU memory measurements are separate gates.

| # | Status | Result and code | Evidence / remaining gate |
|---:|---|---|---|
| 1 | Implemented; hardware/performance gates unverified | [sprites.ts](../engine/src/render/sprites.ts) renders supported masks into bounded device-space tiles. [tiles.ts](../engine/src/render/tiles.ts) leases nested scratch surfaces with a 2-million-pixel retention budget. Difficult oblique masks retain the full-surface fallback. | Exact nested, mirrored, zero-scale, self-mask and scale fixtures; all 32 goldens; read-only snapshot checks. Processed pixel area falls sharply. Render tails vary between matched runs; representative lower-powered/high-refresh hardware remains untested. |
| 2 | Implemented; extended memory/performance gates unverified | A shared 16 MB LRU retains recurring effect poses and terrain. Translation reuses local effect tiles; continuous transforms do not produce an unlimited cache. | Recurring/continuous pose fixtures, effect dependency changes, bounded eviction, authored scene goldens. Warm effect builds fall 516→47 in the first matched pair. Cold device and extended GPU-memory measurements remain open. |
| 3 | Implemented and locally verified | Cache entries depend on per-resource content revisions and font revision. Unrelated completions preserve valid tiles; relevant loads/retries rebuild them. Immutable terrain content is described at capture boundaries. | Focused fixtures cover unrelated/relevant completion, failed-resource retry, shared already-ready images, visibility, replacement, alpha, and mask-root transforms. |
| 4 | Implemented conservatively; broad rollout deferred | [sprites.ts](../engine/src/render/sprites.ts) captures commands for an explicit static allowlist, preserving child order, alpha and dependencies. Animated/mutable content keeps normal traversal. | Static visibility/order/alpha and replacement fixtures; all-level goldens. p95 visits 80→74 and calls 62→58 in the first source comparison. Broader flattening needs scene-specific profiles and image evidence. |
| 5 | Implemented; real startup timing unverified | [levelassets.ts](../engine/src/render/levelassets.ts) waits for coherent common/level critical resources, then loads decorative work in the background. Counts, partial state, explicit retry and cancellation are exposed to [GameView](../engine/src/embed.ts) and the play UI. Fonts use a visible fallback while loading. | Synthetic delayed/failing/aborted-resource barriers and real browser play pass. The packaged harness prepared in 654 ms; this is not a measured login/invite-to-play duration. |
| 6 | Implemented and locally verified | [level-assets.mjs](../app/scripts/level-assets.mjs) generates [levels.json](../extracted/assets/levels.json) offline. Runtime preparation reads metadata and does not construct a disposable physics level. Source/production manifests carry content identity. | All 32 levels checked against an expanded constructor oracle, including movement/jump and common death/exit/pause families: 2,108,509 resource observations. Deterministic regeneration, cross-release rejection, and same-size source edits are tested. |
| 7 | Prototype implemented; default rollout deferred with measured justification | [atlas.mjs](../app/scripts/atlas.mjs) packs 22 representative character frames into five lossless pages with two-pixel edge extrusion. Source rectangles and individual-image fallback are supported. Enable with `FBWG_CHARACTER_ATLAS=1`; the default build uses individual art. | Exact crops, transparent borders, extrusion, fallback and manifest integrity pass. Requests 22→5, but packaged transfer +5.7% and decoded pixels +11.8%; no matched cold-browser win demonstrated. |
| 8 | Implemented; native/GPU plateau unverified | [assets.ts](../engine/src/render/assets.ts) provides critical/near/background priority, promotion, 12 bounded lanes, consumer cancellation, shared owners, queue-inclusive deadlines, retry and per-resource state. Cold decoded retention is capped at 64 MB and JSON retention at 128 documents; active owners pin resources. | Priority, shared consumer cancellation, hung metadata, retry/revision and ownership fixtures pass. A synthetic all-32-level navigation fixture plateaus at its 1 KB test budget. Active pinning can exceed the cold budget; this is not a browser/GPU plateau result. |
| 9 | Implemented; hosted/WAN gate unverified | [pathmanager.ts](../app/src/net/pathmanager.ts) retains the logical session through relay/direct migration and a 15-second known outage of both paths. It buffers early packets and bounded recent input/command history. Existing rollout flags retain control of deployment behavior. | Deterministic loss/reordering/repeated migration, five-second both-path outage/resume, same session/world/epoch/hash, terminal expiry and cleanup fixtures pass. Real local WebRTC is checked separately below. Supabase outage, TURN-only, regional relay and WAN acceptance remain open. |
| 10 | Implemented and locally verified | [session.ts](../engine/src/net/session.ts) reduces the fixed command lead from 14 to four simulation frames; controls expose pending feedback and clear held input immediately. Duplicate UI requests coalesce. Resends are serviced before art readiness, at an elapsed-time cadence. | Healthy mixed 30/60/120/144/240 Hz fixtures apply controls in 200–210 ms. Fifteen initial Start losses, late Pause/Retry and art-not-ready cases pass. Theoretical fixed lead changes ~538→154 ms; these are not physical click-to-photon measurements. |
| 11 | Implemented; hosted end-to-end timing unverified | [lobby.ts](../app/src/lobby.ts) returns friend reads before bounded background joins and reserves a selected-friend lane. ICE, handshake, canonical pair adoption and critical preparation overlap, with an explicit barrier before ready. [play.ts](../app/src/screens/play.ts) cancels siblings on failure and can restart a failed acceptance attempt. | A 50-friend fixture checks selected priority, six total join lanes, cancellation and no early ready. Forced-relay invite/accept/new-level browser play passes. Pair reads, assets and transport setup have bounded/cancellable waits. Real invite-delivery/acceptance timings remain open. |
| 12 | Implemented; worst-device recovery budget unverified | Recovery uses a default 8 ms work budget and 260-step chunk ceiling, generation cancellation and bounded deferred packets. Presentation freezes while a coherent frontier is repaired; intermediate replay effects/results are suppressed. Stall/healthy durations use elapsed time. | A 900-frame repair with a 2 ms injected budget requires over 400 chunks and publishes one coherent confirmed result with no replay effects; cancellation and watcher bootstrap pass. Stall notices occur at 2,000 ms at every tested display rate. Snapshot/restore itself is indivisible and may exceed a budget on slow hardware. |
| 13 | Implemented and locally verified | [solosave.ts](../app/src/solosave.ts) owns canonical solo data; [pairsave.ts](../app/src/pairsave.ts) supplies a separate engine projection and confirmed canonical pair data. Engine flush cannot publish prediction. Menus/release adopt fresh canonical solo state. | Maintained regressions replace the audit's bug assertions: late startup RPC, cleanup in pair play, cloud response ownership, release baseline and prediction publication all pass. Spectators continue using MemorySave. |
| 14 | Implemented; live cloud gate unverified | Every authoritative solo step confirms changes. Canonical changes persist locally immediately, debounce cloud work, retain revisions/acknowledgements, pin the owner's token, bound RPC time and retry failures. Footer/panel status distinguishes device storage, pending cloud acknowledgement and failure. | Actual authored finish and remaining on results saves and acknowledges a medal; 52 steps produce 52 callbacks; 100 unchanged confirmations produce no new revision. Quota, stale acknowledgements, hung requests and account switches pass. Existing live RPC/RLS acceptance remains open. |
| 15 | Implemented; live cloud gate unverified | [outbox.ts](../app/src/outbox.ts) merges durable revisions transactionally. Two bounded delivery lanes isolate failed pairs, use deadlines/backoff/Retry-After, stop on auth failure, and quarantine refused revisions. Web Locks deduplicate cross-tab drains. [progress.ts](../app/src/ui/progress.ts) offers scoped retry and a data-only export. | Mixed 403/hung/success delivery, 18-second network drain budget, stale success/failure revision races, cross-owner isolation and lock contention pass. Real IndexedDB refusal/reset and retry/export UI pass in Chromium, Firefox and WebKit. No records are discarded on permanent refusal. |
| 16 | Implemented; extended browser-memory/BFCache gates unverified | [game.ts](../engine/src/game/game.ts) removes owned Stage handlers; view disposal cancels preparation and releases audio/images/tiles. Legacy migration copies, verifies and only then removes the original. Obstructing panels pause without automatic resume. BFCache return reacquires the match lease and preserves a paused run. | Actual repeated disposal/next-level handler counts, quota migration, stale service callbacks, keyboard/panel behavior and cross-tab takeover pass. Audio requests are aborted and completed channels disconnect. Native BFCache cycling and extended retained heap/GPU measurements remain open. |
| 17 | Implemented; physical high-refresh gate unverified | [presentation.ts](../app/src/presentation.ts) and Settings offer local Auto/30/60/120/144/240 caps and 1×/1.5×/2× output. GameView supports bounded 0.5×–3× output with logical input geometry. Settings update a live view independently of simulation/network. | All caps preserve identical callback digests and 25 simulation frames in a one-second virtual schedule. Masks/hit tests cover all supported test scales. A real paired browser fixture uses 30 FPS/1× and 144 FPS/2× while retaining the same match. Unanswered command traffic remains ≤101 packets/1,212 logical bytes over five seconds at every tested rate. Physical 120/144/240 Hz capability and power/GPU costs remain unmeasured. |

## Measurements and tradeoffs

Measurements ran serially on the audit laptop: Windows 10.0.26200, Intel Core
Ultra 9 185H, Node 22.17.1 and headless Chromium 151.0.7922.34. Both source
pairs use adventure 1, position steering and 20-second workloads. “Fallback”
disables the current bounded masks/recurring effects/static commands; it is
not an archived original build. The second pair followed compact terrain-key
changes and reversed run order. Each pair is comparable within itself.

| Run pair | Fallback render p50/p95 | Default render p50/p95 |
|---|---|---|
| [First fallback](../benchmarks/17-improvements-source-fallback.json) / [default](../benchmarks/17-improvements-source-default.json) | 4.3 / 6.2 ms | 3.8 / 7.1 ms |
| [Second fallback](../benchmarks/17-improvements-source-fallback-2.json) / [default](../benchmarks/17-improvements-source-default-2.json) | 4.6 / 9.1 ms | 3.7 / 6.1 ms |

The first pair reduced effect builds **516→47**, processed mask pixel area
**1.447 billion→2.30 million**, p95 visits **80→74**, and p95 draw calls
**62→58**. Its p95 render time worsened. The second pair improved both render
quantiles and observed task CPU **72.8%→58.6%**. This establishes less repeated
raster work, with insufficient evidence for a universal tail-latency claim.

The [packaged default run](../benchmarks/17-improvements-packaged-default.json)
uses compiled engine code and the real WebP output with atlas rollout disabled.
It recorded 654 ms harness preparation, 4.8/7.8 ms render p50/p95,
16.7/16.8 ms callback interval p50/p95 and a 51.3 ms input-to-render proxy p95.
All 167 input events resolved, 520 simulation frames completed, and there were
no browser errors or missing resources. Retained tiles were 5.63 MB/47 entries;
retained/peak scratch area was 921,600 pixels; JS heap sample was 15.02 MB.
One 186 ms long task remained. This single packaged run has no matched packaged
fallback. JS heap is not decoded-image/GPU memory, and the proxy excludes OS
input and scanout.

That performance capture preceded the final partial-font retry, pending forced
pause and progress-panel/error-handling fixes. Final builds and relevant
regressions were rerun; no additional timing gain is attributed to those fixes.

The atlas prototype changes 22 individual production WebP images from 247,116
bytes / 11,580,136 decoded bytes to five pages at 261,080 bytes / 12,942,392
decoded bytes. The source PNG byte count in the build fixture is a different
quantity. Five requests alone do not justify enabling this transfer/memory
regression by default.

The added renderer, preparation, coherent recovery and durable-save code raises
the configured main JS/CSS total to approximately **846 kB**. The former 820 kB
guard was deliberately revised to **860 kB**, retaining about 14 kB headroom;
the landing page retains its separate 100 kB limit. Art conversion reports
41.9→27.4 MB; the output checker includes other packaged art and reports about
27.8 MB. Neither total is initial page transfer. All manifest references and
client-secret checks remain enforced.

## Verification record

- `npm --prefix engine test`: default deterministic suite passed, including
  all-level 3,000-frame digests, snapshot restoration, interpolation, hardening,
  rollback, drift and quick network matrix.
- `npm run test:progress`: canonical/projection, real Game finish/autosave,
  lifecycle/migration, token-owner, revision, failure isolation, deadline,
  cancellation and cross-tab fixtures passed.
- `npm run test:network-unit`: credentials/ICE privacy, relay edges/QoE,
  mixed-clock command/recovery, actual NetSession/LevelHost path migration,
  both-path outage and lobby selected-priority barriers passed.
- `npm run test:assets`: loader service, all-32 dependency oracle, deterministic
  identity, same-size/encoder-version mutation, exact atlas pixels/extrusion and packaged
  integrity passed.
- Renderer fixtures: `font-retry.mjs`, `renderer-tiles.mjs`, `render-readonly.mjs`, `rendertest.mjs`,
  `goldenrender.mjs`, `render-schedule.mjs`, `render-reconciliation.mjs`, and
  `mousetest.mjs` passed. Final all-32 goldens and focused/read-only fixtures
  were repeated after cache-key changes.
- `node app/test/pathmanager-webrtc.mjs`: real local unordered WebRTC→emergency
  relay→fresh WebRTC preserved the same session, generation, run serial and
  final hash with no desyncs. This run measured ~26 ms closed-path fallback,
  ~762 ms direct recovery, and ~1.7 seconds silent-path protection. Raw output
  is preserved in [the local path result](../benchmarks/17-improvements-pathmanager-local.json),
  with the original historical artifact preserved separately. Future fixture
  runs use unique labels (`FBWG_PATH_LABEL`) or timestamps.
- `node engine/test/crossengine.mjs`: Chromium, Firefox and WebKit each produced
  `aba863c1` over the same 600 simulation frames.
- `npm run test:play`: experience and social fixtures passed in Chromium,
  Firefox and WebKit; forced-relay paired play passed with different local
  FPS/output settings. Experience coverage includes real IndexedDB quarantine,
  stale-failure protection, scoped retry and data-only export.
- Production build, app TypeScript, build/resource/configuration/secret checks
  and `eslint . --quiet` passed. Existing warning-only lint findings remain.

Sandboxed esbuild/browser launches sometimes returned `EPERM`; those commands
were rerun in an allowed execution context. Such failed launches are not counted
as passing tests. Performance runs did not compete with builds/browser suites.

## Remaining acceptance work

1. Use a designated test deployment to exercise authenticated solo/pair writes,
   offline/reload recovery, RLS/auth changes, TURN-only and real regional/WAN
   failover. No new schema is needed by this implementation.
2. Measure real intent→critical-ready→first-playable and invitation phase
   timings with cold/warm HTTP and decoded state, slow network and CPU throttling.
   The offline constructor oracle establishes coverage, not end-user latency.
3. Run representative heavy scenes and extended navigation/play on lower-powered
   and physical high-refresh hardware. Record native decoded/GPU memory,
   retained heap, thermal/power cost and actual delivered frames. Virtual 240 Hz
   callbacks do not establish a physical 240 Hz rendering capability.
4. Validate native BFCache/background/display/fullscreen transitions with active
   peers and confirm match leases, pause policy and retained resources.
5. Keep atlases opt-in until a matched cold-browser test demonstrates a useful
   net benefit; widen static flattening only with profiles and golden coverage.

The current implementation supplies the local behavior and regression coverage;
these environmental acceptance gates remain explicitly unverified.
