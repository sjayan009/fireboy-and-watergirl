# Display-rate rendering without changing the simulation

The game still runs the original fixed 1/26-second simulation. Replay inputs,
physics, playheads, hashes, and rollback snapshots use that clock. Rendering
uses the browser's actual `requestAnimationFrame` callbacks and never advances
the game. A 144 Hz display does not create 144 simulation/network updates.

`VisualSnapshots` owns a previous/current transform pair in an external WeakMap.
`SpriteRenderer.captureTransforms` resolves positions, scales, rotations and
manifest child placements after each normal simulation step. Objects and output
transforms are reused. Nothing is attached to a Game, body, or display node.
The renderer interpolates remote characters, platforms, rotating mechanisms,
ropes and moving interface parents. This game has a fixed 640x480 stage rather
than a moving camera; the same parent-transform interpolation would also apply
to a moving camera parent if one were introduced later.

World interpolation deliberately presents between the previous and current
states. Its visual age is one simulation interval (38.46 ms) relative to an
extrapolated present. Applying this to the controlled character would delay its
response, so controlled character **position** instead uses current plus the
last observed displacement times the bounded accumulator fraction. Solo applies
this to both characters; network play applies it only to the local slot;
spectators interpolate both. Local poses, scales and rotations use the latest
state. This is bounded linear visual extrapolation, not a second physics world
and not proof that the next collision position is known. Its offset from the
latest authoritative state cannot exceed one observed step; its error against
the unknown future state is not known. The next simulation result corrects it;
observed impacts/reversals suppress the affected axis. A newly pressed/released
input suppresses the old velocity until that input reaches the normal next
simulation step. This can cause a small snap from an estimated position back to
the latest real position; it never postpones local input by a simulation tick.

Rollback replays never publish intermediate visual snapshots. At their end,
the corrected transform is compared with the last published transform. Changed
transforms snap to the correction; identical snapshot maintenance preserves
interpolation. Each completed replay batch invalidates presentation once, so
corrections to a stationary frame (including visibility/art-only changes) draw
even when the simulation accumulator is zero or the session is stalled. The
invalidation is consumed only after a successful draw. Scene changes,
reparenting, newly visible nodes, large transform
discontinuities, and a callback gap over two simulation intervals discard stale
history. A stalled session stops local extrapolation and bounds world
interpolation at its latest available state. Texture/frame selection, alpha and
visibility remain discrete simulation values.

`GameView({ smoothing: false })` retains exact simulation-frame presentation
for comparisons. This does not disable the independent raster optimizations.
Button hit testing uses the most recently presented visual transforms.

## October 2026 renderer implementation

The logical stage remains 640x480. `GameView` accepts local `presentationFps`
and `outputScale` preferences; the renderer scales only the canvas output.
Masks, filters, vector text, and effect tiles use device pixels consistently,
while button geometry and pointer input stay in logical stage coordinates.
Output scale changes clear renderer caches and force a presentation without
changing physics, inputs, replay hashes, or multiplayer packets.

Ordinary and self masks now intersect conservative content/mask bounds and
use exclusive scratch-surface leases. Nested masks cannot overwrite an outer
operation's content. Surfaces use 32-pixel buckets, and released surface
retention is capped at 2,097,152 pixels. Active nested operations can temporarily
exceed that retention budget; `scratchPeakPixels` reports that separately.
Missing geometry, text overflow, and oblique transformed raster edges retain
the full-surface path. The latter is deliberate: same-browser pixel comparisons
found changed edge antialiasing when oblique images moved to smaller surfaces.
`configureRasterOptimizations({ boundedMasks: false })` provides a comparison
and rollout fallback.

Completed terrain and effect tiles share a 16 MiB LRU budget. Discrete character
poses can reuse multiple results across an animation cycle; position translation
does not enter their local-art key. Continuous descendant interpolation and
rollback residuals use transient effect results rather than keeping a tile for
every floating-point sample. Filter padding grows from authored filter radius,
strength, scale, and offset. BitmapData structural descriptors are derived at
simulation/correction capture boundaries instead of rewalking static terrain
at every display callback.

Cache entries record the resources actually painted or attempted, including
dependencies inherited from nested cache hits. Readiness, failure, replacement,
and retry change each resource's revision. Unrelated animation prefetch requests
do not enter the dependency set. Atlas rectangles keep their authored origin and
draw through every raster path; an unavailable atlas page falls back to the
retained individual frame. Renderer-owned image references and resource owners
are released on scene changes and disposal.

Static command flattening has a narrow allowlist: one-frame ground tiles,
GroundMask containers, lever bases, and pulley anchors. Animated/filter/mask/
bitmap/text/button descendants fall back to ordinary traversal. Content,
structure, alpha, visibility, sampled transforms, and source dependencies remain
in the observed key. Flattening never removes nodes from simulation or hit-test
traversal. It is available independently through the staticCommands comparison
switch; this is not a general classifier for menus or interactive overlays.

`SpriteRenderer.diagnostics()` exposes mask pixel area and fallback counts,
node visits, effect hit/miss/raster time, terrain hit/miss, static commands and
validation visits, cache bytes/evictions, scratch allocations, and retained/peak
pixels. The browser benchmark accepts `FBWG_BENCH_RASTER=default|fallback` and
records renderer counters before and after its workload. The fallback retains
one last character pose, full-surface masks, and ordinary static traversal so
comparisons isolate the new optimizations without overwriting audit artifacts.

The new `renderer-tiles.mjs` fixture compares exact nested/mirrored/zero-scale/
self-mask pixels at 0.5x/1x/2x/3x output, exercises scratch/LRU ownership,
recurring and continuous effects, unrelated and deferred readiness, explicit
failed-resource retry, atlas fallback, static alpha/order/visibility, and logical
hit geometry. `render-schedule.mjs` additionally checks all local caps
(display/30/60/120/144/240 FPS) on virtual 240 Hz callbacks: every simulation
digest and fixed-step count is unchanged. These are correctness tests, not
physical high-refresh measurements or a decoded/GPU memory plateau claim.

Two serial 20-second source-asset comparisons used the same current engine,
adventure 1, position steering, Chromium 151, and the audit laptop. The second
pair used compact observed terrain revisions and reversed the run order. Raw
results are not retained in the repository.

| Comparison | Fallback p50 / p95 | Default p50 / p95 |
|---|---|---|
| First pair | 4.3 / 6.2 ms | 3.8 / 7.1 ms |
| Second pair, compact terrain keys | 4.6 / 9.1 ms | 3.7 / 6.1 ms |

In the first pair, measured effect builds fell from 516 to 47 and processed
mask pixel area from 1.447 billion to 2.30 million; p95 node visits fell from
80 to 74 and draw calls from 62 to 58. The first pair's render tail became
slower despite those reductions. The second pair improved both render
quantiles and measured task CPU (72.8% fallback, 58.6% default). This supports
the reduced compositing/raster work while showing why a universal tail-latency
claim would be premature. These harness preparation figures are not a
login/invite-to-play measurement, and the fallback is the current implementation
with selected raster features disabled, not an archived original release.

The final packaged WebP run used the compiled engine
harness with `dist/extracted/assets`, default smoothing, position steering,
and the production atlas rollout disabled. Over 20.01 seconds it recorded
4.8/7.8 ms render p50/p95, 16.7/16.8 ms callback interval p50/p95, a 51.3 ms
input-to-render proxy p95, and 58.92 draws/second. All 167 input events resolved;
the level remained active with no missing resources or browser errors.
The effect cache recorded 3,492 hits and 46 builds during the workload.
Processed mask area was 2.325 million device pixels versus 1.449 billion for
the corresponding full-surface area. Final retained tiles used 5.63 MB across
47 entries; retained/peak scratch area was 921,600 pixels with three allocations.
The JS heap sample was 15.02 MB; it does not include all decoded-image/GPU
memory. One 186 ms long task was observed. This is one packaged run, without a
matched packaged fallback; do not compare its timings directly with the audit's
different steering/workload or claim end-to-end startup or physical display
performance from it.

Font preparation is optional and reports a partial state when a face fails or
reaches its overall metadata/face deadline. A retry keeps successful document
registrations and requests only missing faces; late timed-out faces cannot
register themselves afterward. Renderer disposal settles its local font wait
and clears its deadline. `font-retry.mjs` verifies partial/deadline retry,
successful-face reuse, and the renderer's missing status/revision transition.

## Earlier raster implementation (historical)

The initial real Chromium benchmark found `drawMasked` spent roughly six
seconds in a 20-second adventure-1 sample. `CreateGround` makes an immutable
texture and `GroundMask` containing approximately 371 terrain tiles. The old
renderer revisited those tiles and composited full-stage scratch layers on
every draw. Its final masked terrain result is now cached per level, transform
and loaded-art generation. Simulation code never edits this terrain after
construction; levels and retries create different objects.

The old glow cache held unfiltered pixels and applied the blur on every draw.
Character movement also invalidated its full-stage canvas cache on every
position change. Filters are now baked into reusable output canvases. Character
glows use a 192x192 local tile, invalidated by pose/child transforms and art
changes, so translating a character reuses the same raster. The stage's fixed
character scale and original art bounds fit this tile; this is not a generic
arbitrary-scale sprite cache. Static terrain retains a stage-sized cache.

That release cached manifest matrix decomposition per immutable placement and
reused per-node resolved/sampled transforms. Image download/decode
concurrency remained bounded at 12 lanes, and `prepare()`
waited for all requested art to settle before simulation started. No atlas or
new asset service was necessary for those earlier improvements. Asset-count/build
limits and packing decisions are covered in [the deployment guide](../HIGH_LEVEL/DEPLOYMENT.md).

The old mask and filter recursion temporarily wrote `mask`, `isMask` and
`filters` on display objects. Draw flags/content traversal now avoid those
writes entirely. A real-canvas test guards those properties against even
temporary assignment and compares every field of full before/after rollback
snapshots for ordinary terrain and pulley levels.

## Validation and inspiration

`interpolationtest.ts` checks deterministic schedules at 60/120/144/240 Hz,
distinct transform updates, same-step local response, bounded extrapolation,
input changes, impacts, rollback corrections, visibility/reparent resets and
real GameHost replay hashes with and without visual sampling.
`render-readonly.mjs` performs the full-snapshot and guarded-write browser
checks. `render-schedule.mjs` drives the real GameView with virtual rAF queues:
60/120/144/240 Hz, identical per-callback replay digests and local input response
frames with smoothing enabled/disabled, increased distinct local transforms,
and 500/1500 ms callback gaps while moving. Existing image regression tests
cover all 32 levels. The scheduling fixture also delivers a real late-input
packet to NetSession and verifies that a stationary same-frame rollback with
zero accumulator presents its corrected position exactly once.

Synthetic callback schedules establish interpolation behavior, not a claim of
physical 144/240 Hz display performance. The actual browser benchmark and its
environment, input-to-render proxy, CPU/heap, GC/long-task measurements and
limitations were recorded separately.

Survev was studied through its primary source on 2026-09-11. Its
[player renderer](https://github.com/survev/survev/blob/master/client/src/objects/player.ts)
maintains separate visual position/direction state and bounded interpolation
fractions. Its
[regional ping test](https://github.com/survev/survev/blob/master/client/src/pingTest.ts)
uses six small binary WebSocket echoes per target and ranks measured latency.
Those are useful examples of separating presentation from state and measuring
paths from the browser. This game retains deterministic peer simulation and
rollback; it does not adopt Survev's server-authoritative architecture. The
relay selector evaluates both players' measurements rather than picking only
the first player's nearest endpoint.
