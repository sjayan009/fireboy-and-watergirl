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

## Measured raster bottlenecks and changes

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

Manifest matrix decomposition is cached per immutable placement; per-node
resolved transforms and sampled transforms are reused. Image download/decode
concurrency remains bounded at the existing 12 lanes, and `prepare()` still
waits for all requested art to settle before simulation starts. No atlas or
new asset service is necessary for these improvements. Asset-count/build
limits and packing decisions are covered in the free-tier budget.

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
limitations are recorded separately in `benchmarks/`.

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
