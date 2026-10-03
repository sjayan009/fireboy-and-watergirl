# Implementation handoff: 17 game improvements

**Prepared:** October 2, 2026

**Repository:** `C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl`

**Audited commit:** `ece3f5dce1e1998b2609fcf8bd8fe4244366b7f7`
**Purpose:** Give the next agent enough context to implement the user's selected improvements without reconstructing the audit or repeating existing work.

## Read this first

The user asked for the hardest improvements with the most impact, selected the following 16 implementation packages, and added a 17th: independently configurable, smooth local high-FPS multiplayer presentation without transmitting high-definition graphics or increasing the shared simulation rate.

This document is a detailed implementation brief. **None of the 17 packages has been implemented in this audit session.** The session added the original audit, local benchmark artifacts, a reproduction script, and this handoff. Existing application/engine code was left unchanged. No deployment, live database modification, or hosted-network acceptance was performed.

The immediate priorities are progress integrity, the remaining mask/filter renderer costs, startup preparation, and multiplayer continuity. Preserve the deterministic engine and build on the substantial rendering/network work already present.

Start by:

1. Reading this document, [the full audit][audit], [rendering architecture][render-doc], and [network rollout notes][net-doc]. Historical rollout documents sometimes describe earlier commits, hosting, or flags; verify against current code/configuration.
2. Checking `git status`, the current commit, and applicable `AGENTS.md` instructions. At handoff creation, HEAD still matched the audited commit and the audit files were untracked. Preserve those files and any later user work.
3. Inspecting the actual code paths linked below; line numbers refer to the audited state and will move during implementation.
4. Turning the acceptance criteria into a tracked implementation checklist. The 17 package IDs below are stable references for commits, tests, and progress reports.
5. Fixing progress ownership and lifecycle defects early, while defining shared rendering/asset interfaces. The list order groups related work; it does not mean package 13 should wait behind every graphics experiment.

## The user's selected list

| # | Implementation package | Main benefit | Effort / confidence |
|---:|---|---|---|
| 1 | Bounded mask rendering | Less compositing work; smoother frames | M / observed expensive path |
| 2 | Reusable character-effect caches | Avoid repeated glow/shadow rasterization | M / observed expensive path |
| 3 | Dependency-aware rendering invalidation | Avoid rebuilding unrelated caches | M / inspected mechanism |
| 4 | Flatten static scene rendering | Less traversal/context churn | L / profile before broad rollout |
| 5 | Critical-first asset loading | Earlier first playable frame | M / inspected preparation dependency |
| 6 | Build-time level dependency manifests | Avoid duplicate level/world construction | M–L / inspected duplicate work |
| 7 | Animation texture atlases | Fewer small-image requests/objects/decodes | L / measure transfer and memory tradeoffs |
| 8 | Prioritized, cancellable asset management | Less obsolete work; bounded memory | L / inspected ownership/budget gap |
| 9 | Seamless multiplayer reconnection | Preserve progress across supported path failures | L / existing local tests passed; hosted validation remains |
| 10 | Faster online control requests | Faster pause/retry/quit feedback | M / fixed 538 ms lead verified |
| 11 | Parallel multiplayer preparation | Less invite/join waiting | M / inspected serial dependencies |
| 12 | Time-budgeted network recovery | Fewer correction hitches; consistent stall notices | L / timing coupling verified; CPU gains need workload measurements |
| 13 | Separate canonical solo and pair progress | Correct result ownership | M / reproduced corruption routes |
| 14 | Reliable solo autosave with accurate status | Preserve results across devices/outages | M / reproduced missing callback; misleading status inspected |
| 15 | Failure-isolated durable save delivery | One failed pair cannot block others | M / inspected serial failure path |
| 16 | Safe game and progress lifecycle transitions | Release resources; preserve saves; reject stale work | M / Stage retention and migration loss reproduced |
| 17 | Independent high-FPS local presentation | Smoother local movement and optional sharper output | L / foundation already exists; expanded UI/performance/network guarantees need implementation |

Effort ranges for a developer familiar with this repository: **M ≈ 3–5 working days; L ≈ 1–3 weeks**, including appropriate tests. These are planning ranges, not commitments. Several packages share work, so adding every estimate exaggerates total effort. Existing foundations should make targeted implementations cheaper than rewrites; hosted validation or architecture changes can expand them.

## Architecture and constraints

### Shared simulation versus local presentation

The deterministic simulation runs at **26 Hz**, with a fixed step of `1/26` second (~38.46 ms). It drives physics, gameplay flags, authored movie playheads, timers, replay inputs, hashes, and rollback. [GameView][embed] uses a browser `requestAnimationFrame` accumulator; [NetSession][session] owns the simulation clock during a shared run.

Multiplayer uses input/command packets, timing information, and periodic digests, not streamed game images. Each peer has the same level/assets and computes its own world. [The wire protocol][protocol] contains three movement bits per player per simulation frame, repeated history, command epochs, and timing/checksum fields. Do not infer a production bandwidth figure from old comments; measure actual transport bytes, encoding, commands, relay overhead, and control traffic.

[VisualSnapshots][interpolation] already stores previous/current visual transforms outside simulation state. Remote/world movement is interpolated. The local controlled character uses bounded visual extrapolation to avoid adding a full interpolation tick to input response. Newly changed input blocks reuse of old velocity; observed impacts/reversals suppress extrapolation. Death, reparenting, retry, and large discontinuities reset visual history. Optional rollback smoothing and local descendant interpolation exist behind flags.

**Correction to an early audit assumption:** the existing display loop already skips a canvas draw when its simulation frame, asset revision, visual motion, and correction dirtiness are unchanged. Do not implement another generic dirty-render feature as if this were absent. Some page-side/audio/status work still runs per callback and should be profiled.

### State ownership rules

- Rendering must remain read-only: never temporarily change a Game/display node's position, visibility, filter, frame, or child list to draw it.
- The reflective rollback snapshot traverses the Game graph. Any mutable service object attached to that graph can become rewindable accidentally. Keep promises, timers, network/save services, metrics, resource ownership, and renderer caches in closures or external structures.
- The active engine progress projection is simulation state. Canonical durable progress and delivery bookkeeping must have separate ownership and must not be rewound with the engine.
- Publication of progress must come from confirmed state. Intermediate re-simulation frames are not separate player achievements.
- Spectators use a `MemorySave` and must never publish results to the spectator's own account or the players' durable stores.
- Preserve account IDs, pair IDs, match leases, generation/epoch validation, and ownership checks across all awaits and lifecycle changes.

### Infrastructure and scope

- Application: vanilla TypeScript SPA with Vite; Canvas2D game renderer.
- Hosting configuration currently targets static Cloudflare assets via [wrangler.json][wrangler]. Retained Vercel files and historical instructions do not establish the current deployment path.
- Backend: Supabase Auth/Postgres/private Realtime topics. Use the matching Supabase skill when implementing backend/schema work and current official documentation when necessary.
- WebRTC, relay, runtime ICE credentials, time sync, adaptive input delay, and a path manager already exist. Enhance them rather than introduce another transport architecture.
- A server verifier implementation exists, but the audit found it is not deployed/wired into the active client-reported leaderboard. Verifier activation, a framework migration, a physics rewrite, bots, and unrelated database tuning are outside this selected list.
- Creating this handoff did not publish or provision anything. A future implementation run should follow its actual user instruction and environment, including any external-operation authorization required there.

## Baseline evidence and current validation

### Reproduced defects

[The local reproduction script][checkscript] runs actual application source with local service mocks and actual engine methods. It makes no live RPCs. [Its captured output][checks] showed:

| Scenario | Observed result | Primary packages |
|---|---|---|
| Startup solo RPC resolves after pair adoption | Pair projection gained a solo node-2 medal; solo local save acquired pair node-3 progress | 13, 14, 16 |
| Cleanup calls `solo.sync()` before pair release | Solo RPC arguments included pair node-3 medal | 13, 16 |
| Legacy destination storage write throws | Original and destination records both absent; earned medal absent from new memory store | 16 |
| Actual solo stepping runs for 52 frames | Zero `onConfirmed` callbacks | 14 |
| Active solo view destruction | Stage keyboard handlers remained at 2; starting the next level increased count to 4 | 16 |

The fixture currently asserts the faulty behavior to preserve audit evidence. **Once fixing these paths, turn the scenarios into maintained tests asserting correct behavior.** A fixture failing because the bug disappeared is not evidence that the fix regressed. Preserve baseline artifacts rather than overwrite them.

Other inspected issues: solo cloud errors do not reach the footer's Saved indicator; outbox posting stops at the first failure; modal drawers can block control without pausing; stall/recovery counts depend on display callbacks; ordinary masks use full-stage scratch layers; filtered characters cache only their last pose; art prewarming constructs a disposable physics level.

### Fresh local renderer measurements

Three ~20-second adventure-1 runs used Windows 10.0.26200, Intel Core Ultra 9 185H, Node 22.17.1, and headless Chromium 151.0.7922.34. Default presentation flags were used. The third run used freshly packaged WebP assets with the compiled engine harness, rather than testing the fully deployed app bundle.

| Metric | Source assets 1 | Source assets 2 | Packaged WebP assets |
|---|---:|---:|---:|
| Harness preparation | 1,296 ms | 1,734 ms | 1,830 ms |
| Render p50 | 10.5 ms | 8.7 ms | 7.4 ms |
| Render p95 | 15.9 ms | 14.9 ms | 14.6 ms |
| Frame interval p50 | 16.7 ms | 16.7 ms | 16.7 ms |
| Frame interval p95 | 33.4 ms | 33.4 ms | 33.4 ms |
| Event → authoritative movement-render proxy p95 | 71.3 ms | 61.3 ms | 70.2 ms |
| Render calls / second | 39.4 | 42.7 | 48.7 |
| Render-node visits p95 | 85 | 85 | 85 |
| Draw calls p95 | 65 | 65 | 65 |
| Observed long tasks | 2 | 2 | 2 |
| Longest observed task | 267 ms | 389 ms | 311 ms |
| Used JS heap sample | 9.14 MB | 8.06 MB | 7.05 MB |

Harness preparation includes constructing GameView, preparing its initial scene, starting adventure 1 with GameHost, and preparing that level. It is **not** a measured real-user login-to-play or invite-to-play duration. Long-task observation occurs in the instrumented running workload; the exact cause of the spikes was not attributed. Do not label them all startup tasks or blame disposable level construction without a separate trace.

Packaged-assets method timings over the sample: `drawMasked` ~4.66 seconds, `drawFiltered` ~1.88 seconds, `drawText` ~118 ms, `childXform` ~51 ms. These timings are partly nested: **never add them as independent CPU shares**. They identify investigation priorities.

The warmed snapshot benchmark measured ~5.26 ms capture, ~3.26 ms restore, 26,227 objects / 107,913 slots. Its existing worst-case weighting estimates ~2.42 ms per simulation frame. All 32 levels restored exactly. The serializer is already optimized and viable; it is not the first rewrite target.

The production converter reduced extracted art/audio from 41.6 MB to 27.1 MB, converting 1,885 images. Engine chunk: ~434 kB / 89.4 kB gzip; Supabase chunk: ~217 kB / 57.3 kB gzip. Whole output: ~31.9 MB / 2,562 files. Totals are not initial-page transfer: routes and assets load selectively.

Limits: instrumentation/tracing and headless scheduling affect results; one level and one powerful laptop are not universal. No physical high-refresh display, low-end/mobile CPU, real WAN, live query plan, or browser/GPU memory plateau was measured. The input proxy excludes OS input and scanout. Preparation variation does not prove WebP is slower. Compare new variants under matched conditions and retain raw distributions.

Artifacts: [source run 1][bench1], [source run 2][bench2], [packaged-assets run][benchprod].

### Tests that passed in the audit

- Full default engine suite, including all levels, digests, snapshot restoration, shell, interpolation, rollback, drift, and quick network matrix.
- Network unit components and the deterministic path-manager migration/loss/cleanup test. The latter needed an allowed execution context because sandboxed esbuild could not spawn (`EPERM`).
- Production build and TypeScript compilation; configured build/output/secret scan check.
- Local bug reproduction script, asserting the observed baseline defects.

The full browser/golden/cross-engine/hosted/live-database suites were **not** run as part of this audit. Listing a test below means it is relevant to implementation, not that it already passed on a future change.

## Coordination and implementation order

The user wants substantial work tackled together. Use multiple bounded changes with clear contracts and regression checkpoints rather than one opaque patch. Parallel development is possible when the current run authorizes it; the main shared files require coordination.

| Track | Packages | Main shared files | Coordination rule |
|---|---|---|---|
| Rendering | 1–4, presentation portions of 17 | `SpriteRenderer`, `VisualSnapshots`, `GameView` | Agree logical/device coordinates, cache keys, byte budgets, and revision interfaces before independent edits |
| Assets/startup | 5–8, preparation portions of 11 | asset loader, manifests, build converter, GameView preparation | Agree resource handles, priorities, manifest schema, retry/release semantics, and ready barriers |
| Multiplayer | 9–12, scheduling portions of 17 | NetSession, PathManager, lobby, play screen | Preserve protocol/epochs; coordinate clock and resend scheduling; keep simulation boundaries explicit |
| Progress/lifecycle | 13–16 | solo/pair stores, outbox, play cleanup, GameView disposal | Establish canonical/projection contracts first; do not let another track capture service state in rollback |

Recommended waves:

1. **Foundation:** reproduce failures; instrument budgets; implement 13 and core 16 fixes; define resource/coordinate/cache contracts.
2. **Immediate impact:** 1–3, 5–6, 10–11, and 14–15. Include the pause-on-obstructing-panel fix as part of shared control/lifecycle handling.
3. **Structural optimization:** 4, 7–8, 9, and 12, using the established contracts.
4. **High-refresh integration:** 17 with real-device testing; coordinate closely with 10/12 because retries/stall accounting currently depend on callbacks.

This is dependency guidance, not a requirement to finish every earlier item before prototyping the next. Package 17's scheduler/API design should begin early; broad rollout waits for rendering/network evidence.

## 1. Bounded mask rendering

**Goal:** Reduce cleared/composited pixel area and repeated traversal for ordinary and self-masked sprites without changing authored output.

**Current code:** [drawSelfMasked/drawMasked][masks] uses full 640×480 layer/mask scratch canvases. Terrain has a special per-node final-pixel cache already; it must be retained. Nonterrain masks and ropes still perform larger work. Transform origin/parent-space behavior is delicate: the code draws node and mask in a shared parent space and applies transforms exactly once.

**Implementation approach:**

1. Instrument mask type, bounds, cleared pixels, scratch allocations, and cache hits so improvement can be attributed.
2. Compute conservative effective draw bounds from authored geometry and visible descendants, including transformed corners, mask intersection, and filter padding. Unknown or unsupported cases should retain the correct full-stage fallback.
3. Render into bounded local/device-space tiles, offsetting transforms by the tile origin. Composite at the original stage location. Use direct clipping for simple shapes only when it reproduces masking semantics.
4. Use a depth-aware scratch-surface pool. Shared scratch surfaces cannot be overwritten by a nested mask/filter operation before the parent uses them.
5. Release/resize surfaces under a pixel/byte budget. Repeatedly reallocating tiles for tiny motion can erase the benefit; bucket sizes or reuse larger bounded surfaces when appropriate.

**Acceptance:** Golden output remains equivalent across ropes, mirrored/rotated sprites, zero-scale states, doors, death, overlays, and all 32 levels. Main-thread render p95 improves on mask-heavy scenes. Nested masks work without corrupting parent results. Renderer writes no simulation properties. A fallback remains available for difficult geometry.

**Tests:** Renderer readonly, golden rendering, render reconciliation, mouse hit testing, all-level digests. Profile both warm steady play and cold/retry transitions. Coordinate tile device scaling with package 17.

## 2. Reusable character-effect caches

**Goal:** Avoid rebuilding filtered art when an animation revisits a known pose.

**Current code:** [drawFiltered/poseKey][filters] recognizes `pers1`/`pers2`, uses 192×192 local tiles, and excludes ordinary position translation from the character key. It stores one last cache entry per node. The recursive pose key includes child transforms and the renderer generation, so repeated animation cycles and unrelated loads can rebuild tiles. Continuous local descendant interpolation makes keys change at presentation rate.

**Implementation approach:**

- Preserve the existing local-tile approach; add a bounded multi-entry cache for recurring discrete poses/filter/scale/art combinations.
- Separate finite authored pose identity from continuously sampled transforms. Do not cache an unbounded tile for each floating-point interpolation result. Consider caching constituent art and applying continuous transforms at composition, or a carefully bounded approximation with image validation.
- Include actual visual dependencies: visible child state, frame/base raster, color/filter configuration, mirroring, relevant scale/rotation, source revision, and output scale.
- Replace recurring string-concatenation work with reusable pose descriptors or versioned keys where profiling supports it.
- Define LRU/pixel budgets and counters: hit/miss, raster time, tile bytes, evictions. Do not assume the tile size always fits every filter radius or new DPI setting.

**Acceptance:** After warmup, recurring discrete animation cycles mostly reuse effect output; memory plateaus; moving a character does not rebuild identical local art. Changes in pose, art, filter, life state, or resolution update immediately. Descendant interpolation stays bounded in memory and p95 cost. Filter halos do not clip and rollback/death cannot display a stale pose.

**Tests:** Render readonly/reconciliation/goldens, interpolation contracts, repeated animation/turn/jump/death cycles, retries and quality changes. Compare both staged interpolation flags off and on. Depends on packages 3/8/17 for invalidation, retention, and scale.

## 3. Dependency-aware rendering invalidation

**Goal:** Rebuild only the visual caches whose inputs changed.

**Current code:** [Shared asset revision][assets] changes when an image finishes, including failures. [SpriteRenderer][sprites] increments its generation after successful loads and uses that broad generation in effect/terrain keys. An unrelated decorative resource can invalidate stable pixels.

**Implementation approach:**

1. Give resources stable handles with content/release identity, readiness, and a revision. The exact API is a design decision; keep it external to the Game graph.
2. Record dependencies while building terrain tiles, effect tiles, and static subtrees. Atlas-backed frames may share a resource while retaining distinct rectangle metadata.
3. Invalidate affected entries when a resource becomes usable/changes; do not repeatedly flush everything for a failed decoration. Maintain a coarse fallback revision until coverage is proven.
4. Track visual structural revisions outside simulation state, derived from observed changes or immutable capture boundaries. Never attach service generations to nodes merely for renderer convenience.
5. Define dependency release/subscription cleanup when a cache entry is evicted or a view is destroyed.

**Acceptance:** Loading an unrelated resource does not rebuild terrain/effects; a relevant previously missing image appears on the next appropriate draw. Cache cleanup releases subscriptions. Bounds/hit testing use current presentation. Correctness survives missing-resource retry, an asset release change, and a shared resource used by two views.

**Tests:** Fake/deferred image completion, failed-then-successful resource, counter assertions for relevant/irrelevant invalidation, readonly snapshots and goldens. Coordinate schemas with packages 5–8.

## 4. Flatten static scene rendering

**Goal:** Reduce repeated traversal, transform resolution, and save/restore operations for truly immutable presentation subtrees.

**Current code:** [drawNode/drawContent/captureTransforms][sprites] walks authored scene objects. Cached terrain already flattens one expensive case. Many display objects are static, but movie-frame scripts, masks, runtime visibility, children, and parent transforms make blanket assumptions unsafe.

**Implementation approach:** Start with a small allowlist of measured immutable cases. Cache a render-command list or rasterized subtree with explicit dependencies. Separate moving children/parents from immutable local art. Preserve z-order, text/font readiness, mask nesting, alpha, and color transforms. Never remove static objects from simulation traversal solely because their drawing is cached: invisible clips and frame scripts can affect gameplay.

Keep interactive hit geometry separate from flattened pixels. If a cached subtree moves via a parent transform, drawing/hit testing must apply the same latest presented transform. Invalidate on actual content/structure changes, quality scale, font completion, and source revisions. A general static-subtree classifier should follow successful narrow cases rather than precede measurements.

**Acceptance:** Node visits/context-state changes fall for the chosen workloads; draw-call count alone is insufficient evidence. The map, overlays, HUD, and level mechanisms stay visually and interactively correct. Dynamic descendants still animate and respond. Cache bytes and retention remain bounded.

**Tests:** All-scene goldens, mouse/map/button tests, renderer readonly, animation overlays, repeated transitions. Benchmark static menus, settled pause screens, and active gameplay separately. Depends on packages 1/3/8/17.

## 5. Critical-first asset loading

**Goal:** Shorten the path to coherent first playable output without reintroducing disappearing first-use animations.

**Current code:** [SpriteRenderer.load/prepare/warm/prefetch][sprites-load] loads manifests/fonts/buttons, warms visible nodes, starts all frames of visible animated sprites, does a scratch draw, and waits for captured loading work to settle. Invisible alternate poses are skipped and can still be discovered later. [GameView.prepare][prepare] blocks the simulation until preparation finishes. Missing individual images do not reject preparation, but missing/hung metadata can.

**Implementation approach:**

- Define explicit resource tiers: bootstrap UI/essential level geometry, characters plus likely immediate poses, near-future gameplay effects, and decoration/later clips.
- Gate start on a coherent minimal set of gameplay-critical resources. Character movement should not show blanks on the first turn/jump; dependencies need more than just the current visible pose.
- Defer fonts/decoration only with a usable fallback and accurate hit/text geometry. Fonts are already glyph subsets and globally cached; do not prioritize speculative font compression ahead of measured bottlenecks.
- Preserve a separate complete/partial/failed status. Game ready, art complete, and network ready are different conditions.
- Expose progress counts/stages for the critical set, with retry/cancel. Never count an atlas once per frame or change the denominator unexpectedly as discovery continues.

**Acceptance:** Matched cold/slow-network tests improve first playable time; characters/hazards/controls stay legible. Later loading never blocks already playable simulation unnecessarily. Partial art has an honest status and recoverable retry. Preparation cancellation and current selection are generation-safe.

**Tests:** Cold/warm cache, blocked/hung metadata, one missing critical image, missing optional decoration, fonts unavailable, first movement/death/finish poses, level selection changes. Depends on packages 6/8; coordinate with 11 and 17.

## 6. Build-time level dependency manifests

**Goal:** Remove disposable physics-level construction from asset discovery.

**Current code:** [prepareLevel][prepare] constructs `new level(mode,num)` merely to warm/draw/preload its art. [GameHost.start][gamehost] later creates the real level. Constructors allocate world/terrain/mechanism graphs and can consult legacy globals, so casually reusing the prewarm instance is risky.

**Implementation approach:** Generate deterministic level/symbol dependency metadata during extraction/build or in an isolated offline analysis tool. Include level ground/images, named base/child art, character pose families, buttons, masks, mechanisms, death/results states, and critical-vs-background tiers. Common assets should be shared rather than copied into every record.

Use an isolated constructor-based enumerator as a development oracle if needed, not as browser prewarm. Validate generated coverage against actual traversal across levels and dynamic states. Key the output to source content and generator/schema version; fail a release if a named resource is missing. Preserve a runtime discovery fallback for unusual cases until coverage is proven. Construct the real world once at the actual synchronized start.

**Acceptance:** Normal level preparation performs no disposable `level`/Box2D construction. All 32 levels and required dynamic pose families have coverage. First-use misses are recorded and eliminated or handled intentionally. Wrong/stale metadata is detected before shipping. Selecting levels repeatedly does not allocate dormant worlds or leave sounds/listeners behind.

**Tests:** Deterministic generator output, runtime coverage oracle, asset check, full level/golden tests, instrumentation counting constructor invocations around selected starts. Depends on 5/7/8 schema work; affects 11.

## 7. Animation texture atlases

**Goal:** Reduce the cost of thousands of small frame files without forcing the whole game into memory at once.

**Current code:** [The production converter][asset-build] converts 1,885 PNGs to WebP and rewrites raster metadata. [Manifest geometry][sprites-load] tracks frame dimensions, authored origins, and named-child placements. Composite-with-children versus stripped base art is essential to preserving independently controlled poses. Some parts remain SVG.

**Implementation approach:**

1. Benchmark atlas scope per character/animation/level family; choose moderate dimensions and bundles aligned with package 5 tiers.
2. Extend manifest entries with source rectangle and trim/origin metadata, retaining authored logical coordinates. Add padding/extrusion appropriate for filtering/scaling to prevent bleeding.
3. Update every relevant draw path: ordinary/base frames, buttons/parts, masks, filter cache input, terrain, and any source-identity instrumentation. Do not pack all named children back into a composite that the game also draws independently.
4. Support an incremental fallback to individual images/SVGs; do not require one giant format migration before measuring a representative character.
5. Hash final content and encoder/layout settings for immutable asset identity. [Current assetRelease][release] hashes most source files by path/size; same-size edits or changed conversion settings are a known invalidation gap.

**Acceptance:** Smaller request/object/decode overhead under representative cold loading without excessive downloaded/decoded unused art. Identical authored alignment, no edge bleeding at every tested quality scale. All manifests reference existing resources; stale/cross-release caches cannot mix rectangles and textures. Converted-output cache uses content/settings and refuses incomplete releases.

**Tests:** Build/output check, same-size content mutation, deterministic layout, all-frame/golden comparisons, missing-atlas recovery, scaled/mirrored/filter cases, source and packaged benchmark variants. Coordinate 3/5/6/8/17.

## 8. Prioritized, cancellable asset management

**Goal:** Keep active gameplay ahead of obsolete decoration and keep memory bounded across navigation/levels.

**Current code:** [assets.ts][assets] maintains document-lifetime image/JSON promise maps and a FIFO queue with 12 active lanes. Image timeout begins only after its lane starts. JSON/font requests have no explicit task-wide deadline. Per-renderer references can keep resources alive even if a global cache entry is deleted. View destruction prevents some late UI writes but does not own/cancel queued work.

**Suggested contract:** Resource handles should express release/content identity, consumer ownership, priority, readiness/error, deadline, revision/dependencies, and release. This is an interface proposal, not existing code. Shared consumers must not cancel each other's requests. Priorities should be mutable when a user changes level or joins an invite.

**Implementation approach:**

- Add bounded priority lanes/fairness; age queued work so background tasks are not permanently starved.
- Use per-consumer cancellation and reference counts. Abort shared fetch/decode only when no needed consumer remains; remove obsolete queued entries cheaply.
- Add overall preparation deadlines in addition to resource deadlines, with explicit retry and bounded backoff.
- Estimate decoded pixels/bytes; pin active/shared resources and evict cold assets from global and per-renderer owners under a configurable budget. Coordinate effect/static tile budgets rather than count only images.
- Ensure failures are retryable: `GameView.prepare()` currently memoizes a successful partial prepare, so explicitly reprepare failed resources rather than simply return the same resolved promise.
- Expose counters without credentials: queued/active by tier, wait/decode times, estimated bytes, cache hits/evictions, failures, ownership count.

**Acceptance:** Rapid navigation does not keep old decorative jobs ahead of a new level; one view releasing a shared asset does not break another; hung metadata cannot leave Preparing forever; missing art can recover without recreating the view. A multi-level/repeated-navigation soak reaches a memory plateau. Use browser/native/GPU memory evidence where available—small JS heap alone does not prove decoded-image memory is low.

**Tests:** Deferred promises, priority promotion, shared ownership, queue cancellation, deadline expiry before lane start, retry, 32-level navigation/low-memory soak, app cleanup. Depends on coordinated 3/5/7/16 contracts.

## 9. Seamless multiplayer reconnection

**Goal:** Preserve the existing match/session/level through supported physical-path changes.

**Current code:** [PathManager][pathmanager] already implements stable transport switching, relay protection, probes/heartbeats, signaling retries, generation controls, deduplication, and path migration. [The legacy reconnect path][play-reconnect] can reconstruct/restart the level. [Flags][flags] and [build definitions][vite] make path-manager use opt-in by default; the audit did not inspect live deployed flag values.

**Implementation approach:** Read current rollout contracts and local test evidence first. Identify remaining hosted acceptance rather than replacing the manager. Preserve one logical transport and same session/level identity while recovering RTC or protecting gameplay with relay. Bind every reconnect attempt to the current match/generation/owner; cancel obsolete ICE/signaling callbacks. Keep recovery, intentional Leave, tab takeover, consent revocation, and partner departure distinct.

Validate direct→relay→direct, hard close, silent failure, one-way failure, repeated migration, reordered control messages, expired credentials, TURN-only networks, hidden-tab return, and unavailable partner. Preserve bounded control/message rates and rollback history across handover. Keep a fallback switch until hosted evidence supports rollout.

**Acceptance:** Supported path failures retain GameView/NetSession/level identity and earned state; peers converge to the same confirmed digest and generation. No duplicate level start or progress publication. Recovery has bounded deadlines and accurate visible stage/retry/cancel behavior. Intentional departure ends cleanly. Unsupported permanent failures exit honestly rather than falsely claim continuity.

**Tests:** Existing deterministic path-manager fixture; local WebRTC migration/failover; network rollout browser suite; hosted two-account TURN/Supabase acceptance when appropriately configured. Hosted scripts create disposable accounts and interact with real services—inspect their scope before running. No success claim based solely on deterministic simulation.

## 10. Faster online control requests

**Goal:** Make pause/retry/quit feel prompt while preserving command agreement and recovery under delayed/lost packets.

**Current code:** [COMMAND_LEAD][command] is 14 simulation frames, ~538 ms. Commands have scheduled frames, epochs, deduplication, retransmission, and late-command correction. Ordinary input already has immediate edge publication; do not confuse this command delay with movement latency. The retained snapshot can make extremely late commands unreachable even if the rollback window is wider.

**Implementation approach:**

1. Add immediate local feedback for the requested action, disable/coalesce repeated requests appropriately, and release movement input when relevant.
2. Measure request→scheduled application and acknowledgement/loss distributions before selecting a smaller lead. Decide whether the lead is negotiated/adaptive or a compatible fixed value.
3. Maintain deterministic scheduling and a defined response when a command is behind the retained snapshot; do not merely set the lead to zero.
4. Decouple retry timing from display callbacks (also required by 17). Continue necessary retries during stalls/graphics preparation, with bounded cadence and duration.
5. Handle cross-actions: repeated Pause toggles, simultaneous pause/resume, Retry then stale Quit, Leave while retrying, and new generation messages.
6. Fix obstructing drawers coherently: [PlayShell][playshell] currently disables controls while the simulation continues. Solo can pause immediately; online needs a shared pause request and honest pending state. Do not blindly auto-resume a game paused before the drawer opened.

**Acceptance:** Visible acknowledgement happens on the next available presentation opportunity. Shared application is materially faster under healthy conditions without extra desyncs or stranded generations under hostile delivery. Duplicate requests do not accidentally toggle twice. The pause menu/results remain consistent and modal interactions cannot silently remove control while the player falls.

**Tests:** Shell/rollback/net matrix tests, command dedup/generation tests, app paired play, narrow-layout drawer interactions, refresh schedules from 30 to 240 Hz, delayed commands older than snapshot, packet loss/reordering. Depends on 12/16/17 clock/lifecycle agreements.

## 11. Parallel multiplayer preparation

**Goal:** Reduce the time from choosing/accepting a friend to the first shared playable frame.

**Current code:** [Invite/accept paths][play-invite] serialize match lease acquisition, pair adoption, level art, then lobby signaling. Pair adoption also waits on unrelated outbox draining. [Lobby refresh][lobby] displays the list incrementally but its refresh promise awaits all missing channel joins: six lanes, up to 50 friends, up to 15 seconds per opening. Selected-friend priority can wait behind old warmup. Runtime ICE loading already has caching/fallback behavior.

**Implementation approach:** Split the preparation graph into safe independent reads and context-changing operations. Acquire/validate the match lease before mutation or publishing ownership claims. Start selected-level critical resources and short-lived ICE prefetch on user intent, in parallel with the selected pair read. Send a legitimate invite early enough for the other player to see it; do not wait on decorative completion. Gate actual shared Start on agreed selection, correct pair projection, transport, and critical readiness.

Separate friend-list refresh completion from cancellable background channel warmup. Promote the selected friend immediately; keep bounded join lanes and stale-generation cleanup. Existing channels are multiplexed over Realtime; do not model them as 50 separate TCP sockets. Use cancellation to clean up every child task after declined invite, tab takeover, route departure, or changed selection.

**Acceptance:** Record timestamped milestones: click, lease acquired, invite delivered, accepted, pair data ready, critical art ready, transport ready, Start applied, first shared frame. Matched tests improve the relevant critical path. No start against solo/other-pair data; no leaked channels or stale completions. An outbox failure for another friend does not delay this match. Overlapping/simultaneous invitations stay deterministic.

**Tests:** Local play/social fixtures, two-person invite/accept/cancel, friend channel outage/reprioritization, slow pair RPC, slow art, slow ICE, lease takeover, account change, two tabs. Depends on 5/6/8/13/15/16 and integrates with 9/10.

## 12. Time-budgeted network recovery

**Goal:** Make recovery/stall UX consistent across refresh rates and prevent expensive replay bursts from monopolizing the main thread.

**Current code:** [NetSession.tick/settle/resync][session] mixes frame accumulation, command pumping, snapshot maintenance, correction replay, and forward simulation. It has a generous frame-count budget and some synchronous full-history work. Spectator `loadConfirmedReplay` already yields every 260 frames, but a frame count is not a device-independent time budget. [watchStall][play-stall] uses `STALL_FRAMES = 52` and `RECOVERED_FRAMES = 26`; `stalledFrames` and healthy counts depend on attempted ticks/display callbacks.

**Implementation approach:**

- Track stall entry/recovery with an injected monotonic clock and elapsed durations. At a sustained stalled callback rate, 52 counts is ~0.87 seconds at 60 Hz, ~0.43 at 120 Hz, ~0.22 at 240 Hz—not the intended two seconds.
- Establish a millisecond budget for correction/catch-up work. Use bounded chunks and yield at safe points; preserve exact frame order and deterministic arithmetic.
- Model a recovery generation/job explicitly. Queue or reconcile packets arriving during a partial rebuild so forward ticks cannot consume a half-restored world.
- Present only coherent completed states; do not publish intermediate rollback snapshots, progress, sounds, or spectator achievements. Make progress/cancel visible during long bootstrap.
- Bound deferred packet bytes, queued jobs, and supported log length. A retry, route leave, new run, or superseding recovery must cancel cleanly.
- Retain time synchronization, adaptive input delay, and existing stall debt clamping. Simply increasing catch-up allowance can create teleporting after outages.

**Acceptance:** Same elapsed stall notice/recovery timing across 30/60/120/144/240 Hz schedules. Identical final digests after chunked versus synchronous canonical replay. No extra sounds/progress or duplicate commands. Recovery yields under CPU throttling and cancels without stranded state. Short normal corrections remain cheap; added scheduling overhead must not worsen the common path.

**Tests:** Engine rollback/drift/net matrix/hostile delivery, snapshot restoration, render reconciliation, watcher bootstrap, time injection, long-run log, input during chunking, retry/quit/depart mid-recovery. Coordinate 9/10/13/14/16/17.

## 13. Separate canonical solo and pair progress

**Goal:** Make result ownership explicit and remove the reproduced solo/pair contamination paths.

**Current code:** [soloProgress][solo] holds `local.data`; [pairProgress][pair] holds that exact same data object, privately copies solo, and overwrites its arrays on adopt. Startup invokes `void solo.sync()` without awaiting it. [Cleanup][play-cleanup] invokes solo sync before pair release. Sync checks owner/closed only before the await and merges the response into whatever those arrays contain when it resolves.

**Required architecture:**

| State | Owner | Rewindable? | Purpose |
|---|---|---|---|
| Canonical solo progress | Account-scoped progress service | No | Best known local/cloud solo results |
| Canonical pair progress | Account + canonical pair key | No | Best known server/durable pending pair results |
| Active engine projection | Explicit current solo/pair run | Yes, where engine snapshot requires | Gameplay comparison/unlocks during this run |
| Pending delivery/revisions/errors | Account-scoped service/outbox | No | Reliable persistence and UI status |

**Implementation approach:** Never use a live pair projection as the source for solo RPC parameters. Snapshot canonical solo for a sync request. Merge its response into canonical solo only; update the active projection only at a defined safe boundary, without asynchronous mutation of unconfirmed shared state. Adopt a pair from its canonical server+pending merge, then initialize an explicit engine projection. At a confirmed frontier, publish monotonic improvements to the correct canonical owner/pair. Between-level/release operations choose the next projection explicitly.

Use account, pair, view/run generation, and request revision checks around asynchronous operations. A response arriving after release/close may be safely merged to its original canonical owner if the service is still valid, or ignored/cancelled according to a documented rule; it cannot modify the new active pair or resurrect a closed view. Avoid replaying external service timers/promises through the reflective snapshot.

Keep current account-qualified local storage, monotonic medal/time semantics, known node count, and durable outbox acknowledgements. Verify the game still compares a new pair run against that pair's best result rather than solo/another pair. Reordering cleanup alone is insufficient.

**Acceptance:** The audit's delayed-startup and cleanup-upload scenarios assert isolation. Solo and pair rows cannot gain each other's results through adoption, release, closing, late replies, retries, or rollback. Account A cannot publish B's results on a shared browser. Server improvements do not rewind/inject asynchronous gameplay state. Spectators remain read-only. Reload/offline behavior remains local-first.

**Tests:** Replace the corresponding audit assertions with maintained deferred-RPC tests; add adopt/release/close/account-switch permutations, rollback confirmed publication, simultaneous tabs, offline pending merges, and pair ownership integration. This is a foundation for 14–16 and preparation in 11.

## 14. Reliable solo autosave with accurate status

**Goal:** Persist genuinely earned solo changes automatically and make status describe what has actually succeeded.

**Current code:** [GameView's solo step][solo-step] increments frames/captures visuals but never calls `onConfirmed`. [Play's confirmed callback][play-confirm] schedules `solo.touched()` when not shared, so that path is unreachable in normal solo stepping. Solo has startup and route-cleanup sync, but closing the browser is not equivalent to route cleanup. [The footer][play-save] observes pair status/local errors, not solo cloud status; its retry drains the pair outbox.

**Implementation approach:**

1. Define a single confirmed-progress publication contract for solo and pair play. Solo is immediately authoritative after the completed simulation step; pair publication follows a forward confirmed frontier or coalesced correction completion.
2. Detect actual changes by revision/signature/completion event. Do not blindly schedule RPCs once per second just because fixing the missing callback makes it fire.
3. Persist local canonical changes before best-effort cloud delivery. The engine's synchronous `flush()` interface must not publish unconfirmed/replayed state accidentally.
4. Coalesce writes and allow one owner-specific RPC in flight with one queued newer revision. Merge responses monotonically, preserve newer local work, and guard lifecycle changes.
5. Retry transient failures with bounded backoff/jitter and online/visible wakeups. A durable solo dirty marker/revision can make retry reliable across reloads.
6. Provide a shared status model: local-only/offline, pending cloud, acknowledged revision, storage failure, cloud failure/retry. Distinguish the currently active pair from “my own” progress displayed in the panel.
7. Retry the actual failed owner/path; expose solo status changes through subscriptions, not a silent private `lastError`.

**Acceptance:** Finish a level, remain on results, and the result becomes cloud-acknowledged without route departure. Offline completion survives reload and syncs on return. No-change play does not continuously write storage/call RPCs. “Saved to cloud” is never shown before acknowledgement of the current revision; older acknowledgements do not clear newer pending work. One account/pair's error cannot overwrite another's indicator. Pagehide is a supplementary flush opportunity, not the sole persistence mechanism.

**Tests:** Real solo completion plus mock deferred/rejected RPCs, close during debounce, reload/offline/online, storage quota, dirty revision during in-flight reply, stale acknowledgement, pair transitions, results replay/rollback. Depends on 13, coordinates 12/15/16.

## 15. Failure-isolated durable save delivery

**Goal:** Deliver each account/pair's pending results independently and preserve data through failures.

**Current code:** [drainOutbox/post][pair] serially sends each pending item and throws on the first failure. Requests have no explicit timeout; authentication is captured per post. [IndexedDB outbox][outbox] already merges monotonically and uses revision-aware acknowledge transactions. `adopt()` awaits a complete drain before fetching its chosen pair, and a permanently refused old entry can block unrelated work.

**Implementation approach:** Retain IndexedDB durability, account indices, canonical pair keys, revision-based deletion, and cross-tab drain locks. Add per-request and per-drain deadlines. Classify failures accurately: offline/timeouts/rate limits/transient servers vs revoked friendship/permanent validation/account mismatch. Authentication errors may require pausing that owner's work rather than treating every record as permanently bad.

Isolate records by pair; continue other eligible records with bounded concurrency/fairness. Preserve refused records in an explained quarantine, with a recovery/export path where useful. Do not silently delete earned data. Backoff with jitter and honor applicable retry guidance. Selected-pair adoption reads server+its durable pending merge without awaiting unrelated posts. Keep acknowledge-after-success atomic even when a newer revision arrives during sending.

**Acceptance:** One 403/hung friend cannot delay another eligible pair forever. Owner mismatch never transmits under the wrong session. Successful older sends cannot erase a newer revision. Two tabs do not duplicate uncontrolled drains. Durable results survive crash/reload; pagehide keepalive failure leaves them available for the next authenticated visit. UI shows which records need action without exposing secrets.

**Tests:** Multiple records with mixed responses, a never-resolving fetch, auth changes, newer revision during acknowledgement, lock contention, reload during transaction/send, offline wake, adopted selected pair while another record fails. Preserve current monotonic/quota/canonical label behavior. Coordinate 13/14/16.

## 16. Safe game and progress lifecycle transitions

**Goal:** Make repeated play/watch/navigation safe for memory, input, audio, and earned results.

**Current defects:** [StartGame][game-start] registers two bound callbacks on the singleton Stage. [GameView.destroy][destroy] removes its DOM listeners and audio but not these handlers. Solo `leave()` returns immediately because there is no NetSession. Bound closures therefore retain the old Game. Separately, [adoptLegacy][solo] deletes the legacy key before potentially failing destination storage, and some progress/preparation responses outlive their original context.

**Implementation approach:**

- Add explicit idempotent game/view disposal that removes only its owned Stage handlers and focus, detaches references, cancels scheduling/jobs, and releases renderer/resource leases. Calling legacy `EndGame()` alone is not an ideal disposal abstraction: it builds a fresh main menu and emits related effects.
- Preserve the existing `AudioPlayer.dispose()` and font-registration caching. Guard late fetch/decode completion so it cannot repopulate disposed buffers or create contexts after leaving. Disconnect completed/stopped loop source/gain graphs when appropriate.
- Establish teardown order: stop accepting input/new work; cancel scoped preparation/recovery; finalize confirmed results from the correct canonical source; publish intentional departure; release view resources/listeners; close services after durable writes are secured. Async best-effort cloud delivery must not depend on retaining a dead view.
- Copy/verify a legacy save destination before deleting its original. Merge safely with an existing account save; preserve unreadable/unclaimed data for recovery. Handle quota/disabled storage and interruption between stages.
- Require post-await ownership/generation checks. Stale callbacks must release their resources and cannot start a level, change selection, show a toast, alter active progress, or resurrect a connection.
- Keep BFCache/pagehide/visibility semantics distinct from ordinary route disposal. Current visibility handling already clears input/pauses; avoid duplicating it or automatically resuming a pre-existing pause.

**Acceptance:** Repeated active solo→route→play/watch cycles return Stage listener counts and retained resources to a stable baseline; no old game responds to new keyboard input. Disposing twice is safe. Late work cannot revive a view/session. Migration errors leave recoverable progress. Narrow drawer interaction and tab takeover release held inputs predictably. Destroying a watcher cannot publish results.

**Tests:** Audit lifecycle/migration scenarios converted to correct assertions; route during loading, active solo, pair pending invite, reconnect, results, spectator bootstrap, audio decode; quota/malformed legacy/existing destination; BFCache; repeated navigation heap/resource soak. Depends on 13 and coordinates virtually every asynchronous package.

## 17. Independent high-FPS local presentation

**User intent:** A player with a capable computer should see smooth movement at a higher local frame rate—and optionally sharper output—without sending high-definition graphics over WebRTC or forcing their partner to use the same graphics settings.

**This is feasible and partly implemented already.** The task is to improve/configure/verify the existing separation, not invent a second networked physics engine.

### Three independent concepts

| Layer | Intended behavior | What a local setting may change |
|---|---|---|
| Shared simulation | Fixed deterministic 26 Hz physics/gameplay/replay | Nothing about tick rate, speed, timers, collision rules, or scoring |
| Network/control delivery | Compact input/history/command/timing/digest data, bounded delivery cadence | No graphic frames/textures/resolution data; rates must not scale just because drawing runs faster |
| Local presentation | Display-only transforms/effects and output pixels | FPS target, quality, interpolation/smoothing, bounded output scale |

**FPS** is the number of displayed frames; **pixel resolution** is output sharpness. They are separate settings. Interpolating two 26 Hz states into more displayed positions can look smoother without inventing new authoritative gameplay outcomes. It does not eliminate real packet latency or increase the resolution of authoritative input/physics decisions. Bitmap source art also limits how much true detail higher output resolution can reveal.

### Existing foundation to retain

- [GameView accumulator/render loop][embed-tick] already uses display callbacks separately from simulation steps and passes `visualAlpha` to drawing.
- [VisualSnapshots][interpolation] has interpolate/predict/latest modes and bounded local extrapolation with input/discontinuity guards.
- Optional rollback correction residuals are 80 ms, bounded by a 56-stage-pixel threshold in the current implementation. Treat those as current defaults to validate, not automatically optimal settings for every case.
- `smoothing:false` supports exact simulation-frame presentation for comparisons. Keep this diagnostic mode.
- [render-schedule tests][schedule-test] already simulate 60/120/144/240 Hz and exercise input, throttle return, and correction redraws. These prove scheduling contracts, not that real rasterization meets those rates.
- Descendant interpolation and rollback smoothing are independently staged in [networkFlags][flags]. Continuous limb transforms can defeat the current filtered-pose cache. Packages 1–3 must resolve that performance interaction before broad enablement.

### Important remaining callback coupling

[NetSession.tick][session-tick] invokes `drainOutbox()` each time it is called by GameView. [Command draining][command-drain] sends `untilHeard` entries every tick and decrements other resend counts per tick. A faster display callback schedule can therefore increase outstanding-command send frequency or exhaust a fixed resend count sooner, even though physics remains 26 Hz. Stall/healthy counters have a similar issue (package 12).

**Do not claim network cadence is completely display-independent today.** Refactor retry/control timing to explicit elapsed-time deadlines or a tested network scheduler; preserve prompt edge delivery and continued retry during stalls. A graphics readiness barrier currently precedes some command pumping in tick—ensure deferred art cannot silently stop necessary protocol/control recovery.

### Implementation approach

1. **Define local settings.** Suggested first scope: Auto/display-native and explicit caps such as 30/60/120/144 FPS, plus a conservative output-quality/scale option. Cap requests to what the monitor/browser/hardware can actually present; never promise guaranteed 144 FPS. Store preferences locally per documented scope, outside the Game snapshot. Each peer may choose independently.
2. **Separate presentation throttling from simulation/network servicing.** Continue the fixed-step accumulator and required input/control work even when a drawing cap skips a frame. Use the callback timestamp/monotonic time, not a fresh simulation tick per draw. Browser callbacks can pause/throttle while hidden; cooperate with current suspension handling rather than spin timers to defeat it.
3. **Bound command/control cadence.** Give retransmission/heartbeat work elapsed-time schedules and hard limits independent of draw FPS. Keep immediate user input edges and existing history redundancy. Rate-limit until-ack work while maintaining reliability and timely handshake recovery.
4. **Improve display-only smoothing.** Render local and remote motion between authoritative states with the existing interpolation/prediction model. Smooth small rollback corrections without easing through death, collision reversals, scene replacement, retry, or teleport-like changes. Do not mutate bodies to make presentation smooth.
5. **Handle lower render rates.** A 30 FPS cap must not reduce physics/network to 30 Hz or miss input transitions. Consume time correctly; avoid unstable cap phase, double drawings, or drift when the cap does not divide refresh rate.
6. **Design output scaling coherently.** Keep 640×480 logical stage coordinates and original 4:3 behavior. Decide whether the renderer's device-space backing scale is explicit throughout or isolated behind a final presentation target. Every `setTransform(1,...)`, full-stage scratch dimension, mask tile, filter tile, clearing/composite origin, font scale, and hit-test conversion must obey the same contract. Merely multiplying `canvas.width` is insufficient.
7. **Separate scale from detail.** Upscaling a 640×480 intermediate does not create extra sprite detail. Genuine higher-resolution text/vector composition needs a renderer-scale path; authored raster content may still limit sharpness. Use a pixel/byte cap rather than blindly applying devicePixelRatio to a large fullscreen viewport. Doubling both dimensions quadruples pixel work.
8. **Bound quality dynamically or explicitly.** Prefer a stable user-selected baseline. If Auto adapts, use measured frame-time windows/hysteresis and separate movement smoothness from costly cosmetic effects. Avoid quality oscillation during network trouble.
9. **Add useful measurement.** Report target vs achieved FPS/frame pacing, render/correction p95, visual position updates, main-thread tasks, tile/asset memory estimates, and actual transport sends/bytes. Settings should help the player choose; do not expose implementation details or network secrets in normal UI.

### Acceptance matrix

- Peer A at 60 FPS, peer B at 144/240 schedule: same confirmed per-simulation-frame hashes, generation, timers, medals, collision outcomes, and replay input interpretation.
- Same scripted input and delivery schedule at 30/60/120/144/240 callbacks: packet bytes/retry counts stay within an explicitly specified display-independent budget. Compare decoded logical packets and total transport bytes separately; timing/encoding can make exact raw payload equality an inappropriate assertion.
- FPS/quality settings never enter gameplay replay/snapshot/hash input. Local preference changes during a run do not force remote restarts or alter scoring.
- Both characters look smoother where the hardware meets the budget; input reversal/release, death, collision, retry, and rollback remain correct. Exact simulation presentation is still available for comparison.
- Real 120/144 Hz hardware meets an agreed render budget on representative scenes; virtual callback tests alone are not proof. Main-thread and GPU/decoded memory plateau under extended high-refresh play.
- Raising resolution/quality does not send image/video frames, larger textures, or extra graphic state to the peer. Network control cadence remains bounded even during unacknowledged Start/Pause or a long stall.
- Switching caps/scales, resizing/fullscreen, moving between displays, focus loss, and BFCache/visibility return cannot corrupt transforms or leave old cached output/hit geometry.
- A slower peer still controls the same game and can choose lower quality. Its connection/input stalls remain genuine protocol issues; high local FPS cannot promise to hide them indefinitely.

**Tests:** Interpolation unit contracts; render readonly/schedule/reconciliation; frame hashes across matched virtual clocks; command traffic accounting; app mixed-preference paired play; all-scale goldens/hit tests; actual high-refresh hardware with packaged assets. Browser presentation guidance: [requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame), [Canvas optimization and output scaling](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas), [Page Visibility](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API).

## Shared acceptance and measurement strategy

### Workloads

Use adventure 1 for continuity with the baseline, then add all-level correctness coverage and measured heavy scenes: ropes/rotating mechanisms, filters/characters, winds/moving platforms, map transitions, pause/results/death overlays, repeated retries, and a long online run. Select the actual worst cases from instrumentation rather than inventing level labels without confirming them.

Measure cold browser cache, warm HTTP cache, warm decoded/cache state, and repeated navigation separately. Use both source assets and the real packaged format. Add CPU throttling/slow-network fixtures and actual lower-powered/high-refresh hardware. Run performance comparisons serially so tests do not compete for CPU/ports. Use matched steering inputs and sufficient repeated samples.

### Metrics

| Area | Required evidence |
|---|---|
| Rendering | p50/p95/p99/max render and frame intervals; mask pixel area; effect/static cache hits/misses; traversal/context counts; long tasks |
| Startup | intent→critical ready→first playable; manifest parse/fetch/decode; queue wait by priority; level construction count |
| Multiplayer | click→invite delivered→accepted→transport ready→first shared frame; command acknowledgement/application; per-path bytes/packets/retries; outage→protected/resumed |
| Correctness | same confirmed frame digests/epochs/results; no renderer writes; exact rollback/restoration; no stale-generation work |
| Saving | changed revision→durable local→cloud acknowledgement; no-change write rate; pending/quarantined entries; recovery after reload/offline |
| Lifecycle | Stage/DOM listener and audio/resource counts; retained heap/image/tile memory plateau; pending task count after dispose |
| High refresh | target vs achieved presentation; same simulation speed and bounded network traffic across mixed caps/settings |

Avoid reporting only average FPS or final heap. Record unresolved/blocked input samples rather than silently dropping them. Explain headless/instrumentation limitations. Timing a render callback does not measure physical input-to-photon latency. Cache wins must be evaluated alongside added memory and cold misses.

### Proposed performance goals

Select explicit target hardware before locking numerical gates. Useful starting goals: recover enough render headroom below 16.7 ms for stable 60 Hz; at 120 Hz the entire presentation opportunity is only ~8.33 ms, and at 144 Hz ~6.94 ms. Those are display budgets, not guaranteed engine achievements. Improve p95 and long-task frequency, not just median. Require immediate visible control acknowledgement, durable confirmed progress, unchanged simulation outcomes, and stable lifecycle/memory regardless of FPS settings.

### Release identity and backwards compatibility

Asset manifests/atlas layouts must carry an unambiguous schema/content identity. Preserve individual-image compatibility during development where useful. Treat old browser caches as real deployment conditions; cache versioning based only on filenames/sizes is inadequate for same-size edits.

Engine changes that affect replay semantics/deterministic outcomes require deliberate version handling; presentation-only settings should not change canonical outcomes. Preserve packet body/trailer compatibility and epoch checks unless a protocol version migration is explicitly designed and tested. Do not deploy unvalidated new flags merely because local tests pass.

## Test and benchmark commands

Run commands from the repository root. Commands below are a menu mapped to changes; do not repeat every expensive suite after each tiny edit. First build the engine so compiled imports/declarations match source. Browser tests require installed Playwright runtimes, and some local environments block child-process spawning; treat an `EPERM` launch failure as an environment issue, not a passing/skipped test.

### Local deterministic and unit checks

```powershell
npm --prefix engine run build
npm --prefix engine test
npm run test:network-unit
node benchmarks/deep-audit-20261002-checks.mjs
```

The last command is baseline defect evidence, not a post-fix correctness suite. Update/add maintained assertions before relying on it after implementation. `engine test` builds the engine itself; avoid unnecessarily rebuilding twice in one orchestrated verification run.

### Rendering and actual browser scheduling

```powershell
node engine/test/render-readonly.mjs
node engine/test/rendertest.mjs
node engine/test/goldenrender.mjs
node engine/test/render-schedule.mjs
node engine/test/render-reconciliation.mjs
node engine/test/mousetest.mjs
node engine/test/crossengine.mjs
```

Golden differences must be investigated, not accepted by regenerating the baseline indiscriminately. Intentionally changed output/scale needs a documented separate expected result; canonical logical-scale comparisons should remain stable where the artwork is unchanged.

### Local application and transport fixtures

```powershell
npm run test:play
node app/test/pathmanager.mjs
node app/test/pathmanager-webrtc.mjs
node engine/test/webrtc.mjs
node engine/test/transport-failover.mjs --rollout
```

`test:play` runs local fixture experience/pair/social tests. The network rollout browser runner also executes a serial collection of browser/cross-engine checks; use the defined [root scripts][package] to avoid duplicate concurrent fixture servers.

### Production packaging and inspection

```powershell
npm run build
npm run check
npm run lint
```

If no project configuration exists, the repository supports explicitly unconfigured builds using `FBWG_PLACEHOLDER_ENV=1`. That flag supplies missing values; it does not necessarily replace configured values. The checker's configured/unconfigured expectation must match what was actually built. During the audit, the first check invocation used the wrong placeholder expectation and failed two configuration assertions; the correctly configured rerun passed. Do not change real configuration or reveal secrets to work around a mismatch.

The build writes repository `dist/` and recompiles `engine/dist/`; preserve user files and verify actual paths before any cleanup. Packaged assets are in `dist/extracted/assets`.

### Comparable renderer measurements

```powershell
# Unique labels preserve baseline artifacts.
node engine/test/performance.mjs handoff-source-before

$env:FBWG_BENCH_ASSETS = 'dist/extracted/assets'
node engine/test/performance.mjs handoff-production-before
Remove-Item Env:FBWG_BENCH_ASSETS
```

Relevant harness options: `FBWG_BENCH_ENGINE`, `FBWG_BENCH_ASSETS`, `FBWG_BENCH_SECONDS`, `FBWG_BENCH_STEERING` (`timed` or `position`), `FBWG_BENCH_ROLLBACK_SMOOTHING`, and `FBWG_BENCH_DESCENDANTS`. Verify [the harness][perf-script] before changing options; matched before/after inputs, art, flags, duration, browser, and instrumentation are essential. New CPU/network/level variants may require extending the harness; those capabilities are not implied by these variables.

```powershell
node engine/test/networkbench.mjs --label handoff-network-before
```

Keep unique output labels and inspect the actual network benchmark's scenario/cost assumptions. Record transport overhead, not just protocol payload. Real hosted testing is a separate gate.

### Hosted/live-service gates

Relevant existing entry points include `npm run test:network-hosted`, `npm run test:turn-live`, `npm run test:deployed`, database/solo tests, and `npm run test:play-db`. Some create disposable users or modify live fixtures/schema. Read the scripts and use the intended configured test environment before executing them. A local readonly audit did not authorize arbitrary production migrations or establish that hosted credentials/resources are ready. Build a reviewable implementation first and report any actual missing environment rather than inventing a live-success claim.

## Local configuration switches

[Vite build definitions][vite] currently read these public behavior switches:

| Environment setting | Current role |
|---|---|
| `FBWG_PATH_MANAGER=1` | Enable existing stable path-manager behavior |
| `FBWG_LEGACY_RELAY_BATCHING=1` | Select legacy relay batching behavior |
| `FBWG_ROLLBACK_SMOOTHING=1` | Enable existing display-only rollback residual smoothing |
| `FBWG_DESCENDANT_INTERPOLATION=1` | Enable continuous local descendant transforms |
| `FBWG_NETWORK_TEST_HOOKS=1` | Include fixture/acceptance diagnostics hooks |
| `FBWG_ASSET_RELEASE` | Override asset release marker |

Defaults and deployed values are separate questions. New local FPS/output-quality preferences should live in the user-facing settings layer and view options, not require rebuilding the deployment for each player. Test hooks remain restricted to the intended test build; never expose credentials/candidates/raw logs through diagnostics.

## Open design decisions and reasonable starting defaults

- **Targets:** Preserve baseline 640×480 logical output and conservative default quality. Treat real high-refresh support as a measured capability, not a forced default for every device.
- **FPS:** Start with Auto and explicit caps; keep physics/network servicing independent. Settings labels should explain smoothness/battery tradeoffs simply.
- **Scale:** Start bounded; identify whether benefits come from text/vector paths or just raster enlargement. Coordinate tile/cache budgets before enabling larger output.
- **Command lead:** Choose from matched latency/loss/snapshot evidence; no arbitrary zero-frame default. Immediate acknowledgement can ship before a protocol timing adjustment.
- **Resource tiers:** Agree critical readiness and coherent fallback with all character/mechanism states; do not gate Start on every decorative frame.
- **Cache budgets:** Express retained bytes/pixels, pinning rules, and LRU behavior; tune on target devices. Do not choose unlimited caching to win one warm benchmark.
- **Progress contracts:** Separate canonical/projection ownership before changing autosave or cleanup ordering. Choose explicit publication/frontier revision semantics.
- **Recovery:** Prefer bounded, coherent chunks; define cancellation and deferred-packet behavior before converting synchronous APIs to asynchronous work.
- **Rollout:** Keep staged features independently reversible where meaningful, with flags and evidence. Presentation fallback must not discard saved results or reset an otherwise recoverable match.

Ask for additional product preferences only when they materially change scope. Routine reversible implementation choices can proceed under a future request to implement these packages. Do not infer permission to message another chat simply because this file is for the next agent.

## Completion report expected from the implementing agent

For each of the 17 packages, report one of: implemented and verified; implemented with specifically unverified gates; deferred with measured justification; or blocked by a concrete missing dependency. Include:

1. Final behavior and the relevant code locations.
2. Before/after evidence under matched conditions, including cold behavior and memory where relevant.
3. Correctness/regression tests and exact environment limitations.
4. Remaining risk, feature/fallback defaults, and hosted/live gates still open.
5. A dependency-aware list of what remains; do not call a whole workstream complete because one sub-change landed.

Store new measurements under unique filenames. Preserve audit raw evidence and user work. Avoid claiming performance gains from changed hardware, reduced instrumentation, mismatched steering, or source-vs-packaged assets. An unmeasured architectural change is not a demonstrated optimization.

## Copy-paste prompt for the next agent

> Implement the 17 improvements described in `docs/IMPLEMENTATION_HANDOFF_17_IMPROVEMENTS.md`. Read the document and current repository instructions first, preserve existing user/audit work, and verify the audited findings against current code. Prioritize progress ownership/lifecycle defects and the measured renderer/startup/multiplayer bottlenecks. Build on the existing deterministic 26 Hz engine, interpolation, path manager, asset converter, and durable outbox. Keep local FPS/output quality independent of physics and bounded network/control cadence. Follow the documented dependencies, add meaningful regression coverage for the reproduced bugs, and compare performance under matched conditions. Work through bounded reviewable changes, explain material decisions and missing environment, and report each package's implementation/validation status. This request concerns implementation; report any deployment, live-service, or schema work separately according to the actual authorization and environment available in the new chat.

## Source and evidence index

All links below refer to the original workspace. If the next agent uses another checkout/host, resolve the same repository-relative path and verify the current line/function. Do not edit generated `engine/dist` as the source of truth.

[audit]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/docs/DEEP_AUDIT_2026-10-02.md
[render-doc]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/docs/RENDERING_PERFORMANCE.md
[net-doc]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/docs/NETWORK_ROLLOUT.md
[bench1]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/benchmarks/deep-audit-20261002.json
[bench2]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/benchmarks/deep-audit-20261002-repeat.json
[benchprod]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/benchmarks/deep-audit-20261002-production.json
[checks]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/benchmarks/deep-audit-20261002-checks.json
[checkscript]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/benchmarks/deep-audit-20261002-checks.mjs
[embed]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/embed.ts:173
[embed-tick]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/embed.ts:703
[solo-step]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/embed.ts:693
[prepare]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/embed.ts:490
[destroy]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/embed.ts:873
[sprites]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/render/sprites.ts:351
[sprites-load]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/render/sprites.ts:226
[masks]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/render/sprites.ts:877
[filters]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/render/sprites.ts:793
[assets]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/render/assets.ts:1
[interpolation]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/render/interpolation.ts:1
[session]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/net/session.ts:1279
[session-tick]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/net/session.ts:1342
[command]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/net/session.ts:289
[command-drain]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/net/session.ts:1030
[protocol]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/net/protocol.ts:1
[gamehost]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/net/gamehost.ts:108
[game-start]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/game/game.ts:5014
[pathmanager]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/net/pathmanager.ts:1
[flags]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/net/flags.ts:1
[vite]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/vite.config.ts:1
[lobby]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/lobby.ts:195
[play-invite]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/play.ts:1258
[play-reconnect]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/play.ts:1480
[play-stall]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/play.ts:1023
[play-confirm]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/play.ts:499
[play-save]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/play.ts:851
[play-cleanup]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/play.ts:1764
[playshell]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/ui/playshell.ts:147
[solo]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/solosave.ts:65
[pair]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/pairsave.ts:102
[outbox]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/outbox.ts:1
[asset-build]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/scripts/assets.mjs:1
[release]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/scripts/release.mjs:45
[wrangler]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/wrangler.json:1
[package]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/package.json:1
[perf-script]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/test/performance.mjs:1
[schedule-test]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/test/render-schedule.mjs:1
