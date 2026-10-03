# Deep codebase audit — October 2, 2026

The highest-value work is to fix progress ownership and solo autosave, reduce the remaining canvas masking/filter work, and shorten the path from choosing a partner or level to actually playing. Replacing the physics engine or rewriting the application framework would be expensive ways to approach the present bottlenecks.

This report catalogs **73 concrete opportunities** across correctness, frame pacing, loading, multiplayer, accessibility, database work, and development time. Some are reproduced defects; others are optimization candidates or optional product features. Static inspection cannot prove every possible improvement or predict its speedup. Recommendations explicitly marked conditional need measurements before implementation.

## Scope and evidence

- Audited commit: `ece3f5dce1e1998b2609fcf8bd8fe4244366b7f7`.
- Read the deterministic engine, Flash compatibility layer, Box2D port, renderer, asset/audio loaders, session/rollback logic, application screens, lobby/transports, progress stores/outbox, schema migrations, verifier, build scripts, hosting configuration, and CI workflows.
- Ran the full `engine test` suite: interpolation, physics, all 32 levels, deterministic digests, snapshots, shell, hostile simulated delivery/rollback/drift and the quick network matrix passed.
- Network unit checks passed. The path-manager test initially could not launch esbuild under the sandbox (`EPERM`); rerunning that test outside the sandbox passed loss, migration, and cleanup checks.
- Production build passed, including TypeScript. The build's existing asset conversion and output-size checks completed. The final configured build check passed; an earlier invocation incorrectly asked the checker to expect placeholder configuration although the local build used its configured public project values.
- Ran three current Chromium browser benchmarks, including one using the freshly packaged WebP assets, and local reproductions of five progress/lifecycle defects. These exercises did not query or modify the live database.
- No application/engine behavior was changed. Added this report, benchmark results, and an isolated reproduction script.

The current deployment path is static Cloudflare hosting. The verifier implementation exists but is not deployed or connected to the active client-reported leaderboard. Recommendations for that verifier are conditional.

### Fresh measurements

Environment: Windows 10.0.26200, Intel Core Ultra 9 185H, Node 22.17.1, headless Chromium 151.0.7922.34. Each browser workload ran adventure level 1 for approximately 20 seconds with the existing timed input pattern. Default presentation flags were used.

| Metric | Source assets, run 1 | Source assets, run 2 | Packaged WebP assets |
|---|---:|---:|---:|
| Preparation | 1,296 ms | 1,734 ms | 1,830 ms |
| Render p50 | 10.5 ms | 8.7 ms | 7.4 ms |
| Render p95 | 15.9 ms | 14.9 ms | 14.6 ms |
| Frame interval p50 | 16.7 ms | 16.7 ms | 16.7 ms |
| Frame interval p95 | 33.4 ms | 33.4 ms | 33.4 ms |
| Input → authoritative movement-render proxy, p95 | 71.3 ms | 61.3 ms | 70.2 ms |
| Long tasks | 2 | 2 | 2 |
| Longest long task | 267 ms | 389 ms | 311 ms |
| Draw calls p95 | 65 | 65 | 65 |
| Visited render nodes p95 | 85 | 85 | 85 |
| Render calls/second | 39.4 | 42.7 | 48.7 |
| Used JavaScript heap at sample | 9.14 MB | 8.06 MB | 7.05 MB |

Packaged-assets method timing over the whole sample: `drawMasked` 4.66 seconds; `drawFiltered` 1.88 seconds; `drawText` 118 ms; `childXform` 51 ms. These are nested measurements and **must not be added together**. They identify places to investigate, not independent slices of CPU time.

The snapshot benchmark measured a warmed capture at 5.26 ms and restore at 3.26 ms on adventure 1, traversing 26,227 objects / 107,913 slots. Its existing worst-case weighting estimates 2.42 ms per simulation frame. All 32 levels restored exactly.

The production build produced an engine chunk of 434 kB / 89.4 kB gzip and a Supabase chunk of 217 kB / 57.3 kB gzip. The existing converter reduced extracted art/audio from **41.6 MB to 27.1 MB**, converting 1,885 images. Whole deployment output was about 31.9 MB across 2,562 files. These are packaged totals, not initial page-transfer totals: routes and level art load selectively.

Interpretation: a 60 Hz display gives the entire page about 16.7 ms per frame; render p95 alone uses most of that. The remaining masks and filters are more promising than tiny matrix or text changes. WebP lowers transfer size, but the packaged-assets run still misses display frames. The running workload has long tasks whose causes need separate attribution; preparation and real application startup require their own traces.

Limits: headless scheduling, tracing, and renderer instrumentation affect timing; no physical 120/144/240 Hz monitor, low-end phone, real WAN, or live query plans were measured. Input timing excludes operating-system input and display scanout. One level is not representative of every mechanism. The preparation differences are run variability, not proof that WebP makes startup slower. Older September results used different conditions and are not evidence of a regression.

Raw evidence: [source run 1][bench1], [source run 2][bench2], [packaged-assets run][benchprod], [local checks][checks], [reproduction script][checkscript].

## Priority and effort

**P1:** address first: progress integrity, a major UX defect, or an observed expensive path. **P2:** valuable follow-up. **P3:** conditional, small, or a larger architectural option.

Effort is a rough planning range for someone familiar with the repository, including appropriate verification: **XS** under half a day, **S** 1–2 days, **M** 3–5 days, **L** 1–3 weeks, **XL** a separate project. Related entries share work; do not sum all estimates. Rendering and protocol work have greater uncertainty than small UI fixes.

## Progress integrity and lifecycle — do these first

### S01 — Separate canonical solo progress from the active pair projection

**P1 · M · reproduced.** [Solo sync][solo] holds the same `data` object that [pair adoption][pair] overwrites. Three concrete consequences:

1. A startup solo RPC can resolve after `adopt()`, merging solo medals into the pair's active arrays. Its `local.flush()` then writes pair values under the solo storage key.
2. Play-screen cleanup calls `solo.sync()` **before** `progress.release()`. The RPC arguments are copied synchronously while those arrays still contain pair results, so pair results are submitted to `sync_solo_progress`.
3. `close()` and owner checks happen before the await; an already pending response still merges/flushes after the store has closed or its active context has changed.

The local fixture reproduced the first two routes: a pair acquired a solo medal on node 2; the solo local record contained a pair medal on node 3; cleanup submitted that pair medal to the solo RPC. No live service was involved.

Keep canonical solo and each pair's progress in distinct objects. Let the engine operate on an explicit active projection, and route confirmed results to the correct owner/pair/session generation. Snapshot request data from canonical solo storage; reject or safely merge responses after context changes. Reordering cleanup fixes only one symptom. Validate delayed RPCs, adopt/release, account changes, navigation, and rollback together.

### S02 — Actually trigger solo cloud autosave

**P1 · S · reproduced.** [The solo stepping path][embed-step] never invokes `onConfirmed`. [The screen][play-confirm] relies on that callback to call `solo.touched()`. The actual method ran 52 simulation frames in the fixture and produced zero callbacks. Solo writes remain local during normal play; cloud sync is attempted at entry and route cleanup. Closing the browser is not equivalent to route cleanup, and the pagehide handler only beacons the pair outbox.

Publish confirmed solo progress at a well-defined point after simulation/results updates. Prefer a change/completion event or dirty signature, rather than scheduling a sync every second indefinitely. Preserve local-first play, retry on online/visible transitions, and surface pending cloud state. Test finishing solo, staying on the results screen, closing/reopening, and recovering from offline play.

### S03 — Make legacy-save migration safe when storage writes fail

**P1 · XS · reproduced.** [Legacy migration][solo] removes `FBCookie` before writing `FBCookie:<account>`. With a failing `setItem`, neither record remains and the earned medal is absent from the new in-memory store. Copy and verify the destination before deleting the original; preserve unreadable or unclaimed data separately and report failures. Also merge into an existing account save rather than replacing its durable record with the legacy raw value. Test quota errors, malformed data, and reloads between migration stages.

### S04 — Make “Saved” describe both local and cloud state

**P1 · S · inspected.** [The footer][play-save] reads pair errors/waiting and the wrapped local-storage error, but never `solo.lastError`. The retry button drains the pair outbox even when the failed operation is solo sync. A failed solo cloud request can leave the footer saying “Saved.” Introduce a shared status interface with pending, local-only, cloud-acknowledged, and retry states, each scoped to the active progress owner. Provide an explicit solo retry and notify the footer on solo state changes.

### S05 — Coalesce dirty saves and protect asynchronous merges

**P2 · S–M · inspected.** [LocalSave.flush][save] synchronously serializes/writes unchanged data on regular ticks; solo sync has no in-flight deduplication. Keep a last-persisted signature or revision, write only changed local data, allow one solo RPC per owner, and queue one newer dirty revision while it runs. A post-await generation check is necessary but should not discard newly earned progress. Add bounded retry/backoff with jitter and online wakeup. Do not replace durable local state with an unload-only network request.

### S06 — Prevent one outbox entry from delaying every pair

**P2 · M · inspected.** [Outbox draining][pair] serially posts records and stops on the first failure. A revoked friendship, a permanently refused record, or a hung request can delay unrelated friends' results. `adopt()` also waits for that drain before reading the selected pair. Add request deadlines; classify transient vs permanent errors; quarantine an unpostable record with an explanation while continuing other pairs; preserve its evidence. Read the selected pair and merge its durable pending results without awaiting unrelated network posts. Keep existing revision-based acknowledgements and cross-tab locks.

### S07 — Avoid repeated save/watch side effects while replaying confirmed history

**P2 · M · inspected; workload needs measurement.** [runFrame][session-frame] invokes `host.confirmed` during re-simulation whenever the frame is behind the confirmed frontier. That repeats callbacks on older states. Pair signatures mitigate duplicate identical snapshots, but intermediate replay states can still cause changed-signature work; watcher catch-up also runs through this hook. Separate simulation re-execution from durable publication. Publish the corrected confirmed frontier once per correction batch, or deduplicate by run/generation/frontier/revision. Prove that a real result is never lost and that observers still receive all necessary input history.

### L01 — Release singleton Stage keyboard handlers on solo view disposal

**P1 · S · reproduced.** [StartGame][game-start] registers two bound handlers on the singleton Flash Stage. [GameView.destroy][embed-destroy] removes DOM listeners and audio, but does not remove those handlers. `leave()` returns immediately without a session, so leaving an active solo game follows this path. The local lifecycle fixture retained two handlers after destruction and accumulated four after the next level started. Those closures retain the old game graph and can receive future keyboard dispatches.

Add a view-owned teardown that removes the game's Stage handlers, clears its focus if owned, and releases its graph without creating a new menu or emitting gameplay side effects. An explicit simulation-dispose operation is safer than relying on `EndGame()`'s menu-creation behavior. Test repeated solo play/watch/navigation cycles and verify handler counts and retained heap return to baseline. Existing audio disposal and cached font registration should be retained.

## Rendering and frame pacing

These are presentation optimizations. Keep the 26 Hz deterministic simulation unchanged. Canvas caching, layer sizing, and opaque contexts are also supported by [MDN's canvas optimization guidance](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas); the priorities below come from this repository and the fresh measurements.

| ID | Priority / effort | Opportunity and code evidence |
|---|---|---|
| R01 | P1 / M | **Replace remaining full-stage mask compositing with bounded work.** [Mask rendering][masks] clears and composites 640×480 scratch surfaces for ordinary masks and self-masked ropes. The existing terrain cache is already effective. Compute conservative local bounds including transforms/filter padding; use local tiles or direct clips for simple eligible masks. Preserve nested-mask correctness with a scratch pool. Compare image output and p95 across ropes, doors, transitions, and all 32 levels. |
| R02 | P1 / M | **Retain a bounded set of recurring filtered character poses.** [Filtered rendering][filters] keeps one last raster per node; a repeated animation pose is rebuilt when the previous pose differs. Cache discrete pose/filter combinations or pre-bake appropriate glow/shadow variants. Limit bytes, invalidate by relevant art, and measure hit rate. Continuous descendant interpolation can explode cache keys; do not enable it globally without solving this interaction. |
| R03 | P2 / M | **Replace recursive pose-key strings with pose revisions.** [poseKey][filters] recursively builds strings, including child transforms, for each filtered draw. Track the visible visual subtree's revision at simulation/asset changes, with a separate interpolation key when needed. Skip irrelevant invisible descendants only if the output key still changes when they become visible. |
| R04 | P2 / L | **Flatten immutable presentation subtrees.** [draw/capture traversal][sprites] walks and manages context state for objects whose geometry and transforms never change. Cache static display commands or rasterize eligible subtrees. Keep animated children, mask order, and mutable descendants separate; preserve frame scripts in simulation. Measure node visits/state changes, not only draw calls. |
| R05 | P3 / S | **Raster-cache slow-changing text and HUD pieces.** [drawText][text] redraws menu labels/timer text. Key by text/font/style/scale and repaint only when relevant values change. The measured text cost is small (~118 ms over 20 seconds), so do this after masks and filters. Avoid an unbounded cache of every possible timer value. |
| R06 | P2 / S–M | **Cache pointer hit regions and inverse matrices.** [Pointer picking][embed-pick] calls `getBoundingClientRect` and [hitTest][hit] traverses button geometry and inverts matrices for each pointer movement. Process at most the latest pointer position per displayed frame, cache layout and current button transforms, and skip cursor writes when unchanged. Invalidate for interpolation, transitions, visibility, and resize; clicks must use current geometry. High-polling mice make this more relevant. |
| R07 | P2 / M | **Extend the existing dirty-render gate to remaining idle-loop work.** [tick/render][embed-tick] already skips canvas draws when the simulation frame, assets, motion, and correction state are unchanged. It still performs other per-callback work such as status-key construction, mute synchronization, and application `onFrame` callbacks. Profile settled/paused screens and gate or throttle genuinely unchanged page-side work; consider a lower cadence for noncritical decoration. Keep necessary network pumping independent of presentation cadence and resume with fresh state after visibility/layout changes. |
| R08 | P2 / XS | **Benchmark an opaque main canvas.** [Context creation][embed-context] uses default transparency although [render][embed-render] fills the background. Try `{ alpha:false }` on the display canvas only; mask scratch surfaces still need transparency. This is inexpensive to A/B, but a browser-specific win is not guaranteed. |
| R09 | P2 / M | **Offer a measured presentation-quality/battery setting.** Maintain full simulation while reducing expensive decorative effects or capping presentation to 60/30 Hz on constrained devices. Use hysteresis or an explicit setting rather than flapping quality during play. Keep immediate input feedback and gameplay-relevant visibility. A 120/240 Hz monitor should not multiply expensive effect work without a useful improvement. |
| R10 | P2 / S–M | **Narrow cache invalidation to relevant assets.** [Asset/renderer generations][assets] invalidate render caches when unrelated images finish loading. Track dependency revisions per sprite/terrain/filtered tile so a decorative download does not rebuild stable terrain. Verify that a previously missing image becomes visible promptly. |
| R11 | P3 / M | **Reuse immutable level backgrounds across retries.** [Terrain mask caching][masks] is per node, so fresh level instances rebuild the same terrain output. A small cache keyed by immutable level/render settings/asset content can serve retries. First verify the layer contains no mutable mechanisms; release by byte budget. |
| R12 | P3 / L–XL | **Prototype off-main-thread raster/decode work only after the above.** The observed long tasks and compositing work make a worker or OffscreenCanvas experiment reasonable after attributing their causes. Keep DOM/audio/input on the main thread and send compact presentation data. Measure transfer/serialization cost and browser compatibility. Moving the whole reflective Game graph every frame would defeat the purpose. |
| R13 | P3 / XL | **Consider an atlas-backed GPU renderer if Canvas2D remains limiting.** This is a measured fallback, not the first task. It could batch sprite quads and effects but must reproduce Flash masks, color transforms, text, ordering, and authored bounds. Start with a limited effect/scene prototype and retain Canvas2D until screenshots and real-device latency justify the cost. |

## Loading, startup, assets, and memory

| ID | Priority / effort | Opportunity and code evidence |
|---|---|---|
| A01 | P1 / M | **Split play-critical art from decoration and later poses.** [prepare/warm/prefetch][sprites] waits for all queued frames of visible animated sprites; [renderer loading][sprites-load] also waits for all fonts. Conversely, `warm()` skips invisible alternate character poses, so those may still load on first use. Generate a dependency list for essential initial/near-future gameplay frames, prioritize them, then load decoration and later animation in the background. Measure first playable time and first-use misses; prevent flicker with a coherent fallback. |
| A02 | P2 / S | **Put deadlines on manifests/fonts and the entire queued operation.** [jsonAsset][assets] and [font loading][fonts] have no explicit request deadline. The image timeout starts only after a queue lane becomes active, so a backlog of failing requests can exceed 15 seconds many times over. Add per-resource and overall preparation budgets, honest partial-load state, and deliberate retries. |
| A03 | P2 / M | **Cancel/deprioritize obsolete loading without breaking shared requests.** [Shared caches/queue][assets] persist across views and have no consumer ownership. Destroying a view guards late UI writes but does not remove its decorative backlog. Reference-count shared work; abort only when no current consumer needs it; reprioritize the active level. |
| A04 | P1 / M | **Stop building full physics levels solely to find art.** [prepareLevel][embed-prepare] constructs a complete level, warms its art, and discards it; the real start constructs it again. Build-time level/symbol dependency manifests can avoid duplicate worlds and object graphs. Reusing a constructed level would require careful clock, root, listener, and deterministic-state isolation. Measure allocation and long tasks around level selection. |
| A05 | P2 / S | **Make level-start preparation latest-request-wins.** [Start intent][embed-intent] allows multiple asynchronous preparations; earlier choices can finish after later choices and start the wrong selection. Use a request generation/abort signal, show the selected pending level, and disable or supersede repeat starts. Check both solo and online map selection. |
| A06 | P2 / L | **Pack small animation frames into modest atlases.** The build ships thousands of small art files, and warming a clip opens many requests. Evaluate per-character/per-animation/per-level atlases with offsets and padding in the manifest. HTTP/2 helps request overhead but does not eliminate image object/decode overhead. Avoid a giant all-game texture that makes initial loading and memory worse. |
| A07 | P3 / M | **Split metadata only if parse/transfer profiling supports it.** [sprites.json loading][sprites-load] imports the whole asset manifest before rendering. A tiny boot manifest plus per-level/character metadata could reduce startup parse/allocation. Record actual compressed size and parse time first; split packages must preserve symbol lookup and late animation dependencies. The five embedded fonts are already glyph subsets; measure their bytes before adding WOFF2 conversion or further subsetting. |
| A08 | P2 / S–M | **Prefetch critical sound bytes and bound failed sound retries.** [Audio buffer loading][audio] starts on first use and drops one-shots while decoding. Fetch likely jump/diamond/death effects during preparation and decode after an allowed gesture, without blocking visual play. Add deadlines/backoff and missing-sound diagnostics; avoid refetching a persistently missing sound on every occurrence. Measure decoded music memory as well as compressed transfer; streamed long music or eviction of inactive music buffers may be preferable to retaining every fully decoded track. Keep effects responsive and audio outside simulation. |
| A09 | P2 / S | **Finish audio graph lifecycle management.** [Loop stop/ended paths][audio] stop sources but do not explicitly disconnect both source and gain nodes as one-shots/dispose do. Disconnect completed/stopped loop graphs. Gate pending fetch/decode completion after disposal, and consider suspending the context on hidden/paused screens with a reliable resume path. Measure actual battery/retained audio nodes before claiming a leak beyond the reproduced Stage issue. |
| A10 | P2 / M | **Hash shipped content and conversion settings for cache identity.** [assetRelease][release] hashes most source files by path and size, not content; a same-size art edit or changed encoder settings can produce new shipped bytes with the same immutable URL marker. Hash final output or source content plus pipeline version/settings. Eventually use per-file hashes so one changed image does not invalidate every asset. Test same-size mutations and clean/repeated builds. |
| A11 | P2 / M | **Budget decoded art memory across many levels/views.** [Global image/document caches][assets] and per-renderer images retain everything requested with no byte/age eviction. Heap samples for one level omit much browser/GPU decoded-image memory. Track estimated decoded pixels, keep active/shared assets pinned, evict cold levels from all relevant owners, and test a 32-level navigation soak. HTTP cache can recover compressed bytes. |
| A12 | P2 / S | **Preload the play route on clear user intent.** [Lazy routes][main] already prevent downloading the engine for unrelated pages. Preload play/engine chunks when a signed-in user focuses/hovers Play or opens a valid invite, then critical metadata/art with a budget. Avoid loading the entire game on every signed-out visit or metered connection. Measure navigation-to-first-interactive-frame. |

## Multiplayer, reconnection, and watching

| ID | Priority / effort | Opportunity and code evidence |
|---|---|---|
| N01 | P1 / M | **Reduce the deliberate delay for pause/retry/quit.** [COMMAND_LEAD][command] is 14 frames: **538 ms at 26 Hz**, separate from movement latency. Show immediate local “Pausing/Retrying…” acknowledgement and clear input where appropriate. Investigate a smaller negotiated/adaptive lead with the existing late-command correction/resend machinery. Prove behavior when the command arrives behind the retained snapshot, under loss, across retry generations, and in lockstep; simply changing 14 to 0 is unsafe. |
| N02 | P1 / S | **Measure stall/recovery hysteresis in elapsed time.** [Session stalls][session-stall] increment per attempted stalled tick; [watchStall][play-stall] treats display-callback counts as time, including `healthy++` on every `onFrame`. A 52-count threshold is roughly 0.87 seconds at 60 Hz, 0.43 at 120 Hz, or 0.22 at 240 Hz when stalls are attempted every callback, rather than the intended two seconds. Use monotonic timestamps for notices/hysteresis/episode counts. Test synthetic refresh schedules and background returns. |
| N03 | P1 / M | **Shorten the serialized invite/accept path.** [Invite/accept setup][play-invite] currently waits for lease, pair data, level art, then signaling. Acquire the exclusive lease before context mutations, but parallelize independent reads/art/short-lived ICE preparation. Send a legitimate invitation before finishing decorative loads so the friend sees it sooner; preserve a ready barrier before starting simulation. Instrument click→invite delivered→accepted→connected→first shared frame. |
| N04 | P2 / M | **Let lobby refresh finish before channel warmup finishes.** [refreshNow][lobby] awaits all missing channel joins; six lanes × up to 50 friends × 15-second join deadlines can span roughly nine waves during an outage. The list appears incrementally, but refresh-after-change and reprioritization wait on the entire batch. Separate the fresh friend-list read from bounded cancellable channel warmup; immediately prioritize the selected friend. These are multiplexed Realtime channels, not 50 independent TCP sockets. |
| N05 | P2 / M | **Make polling proportional to need.** [Lobby polling][lobby] already limits visible refreshes and uses presence. Coalesce focus/visibility/timer refreshes, pause unnecessary fetches while hidden, and refresh on relevant membership events with periodic reconciliation. At larger account sizes, measure join count and polling traffic before considering a per-user mailbox topic. Preserve private topic authorization and friendship-change recovery. |
| N06 | P1 / L | **Complete rollout of the existing seamless path manager.** [Legacy reconnect][play-reconnect] restarts a level after rebuilding; [path manager][pathmanager] can retain the session across physical-path changes and passed the local migration suite. It is opt-in by default. Validate its existing staged rollout gates on hosted real networks, including one-way failures and TURN-only paths, then enable it where evidence supports it. Do not build a competing second migration implementation. |
| N07 | P2 / L | **Give catch-up/replay a wall-time budget.** [Session tick/resync][session] allows generous step bursts and performs some full-history replays synchronously. Cap work by milliseconds and yield between safe replay chunks; keep the displayed scene coherent until catch-up completes. Spectator bootstrap already has chunked replay—reuse that discipline where applicable. Measure correction spikes under real CPU throttling. |
| N08 | P3 / L | **Bound long-run log/snapshot work with an explicit supported duration.** [Session history/replay][session] keeps input and prediction history and serializes prefixes for watching/resync. Decide the maximum supported run length, enforce consistent local/wire limits, and expose failure meaningfully. For genuinely long runs, encode/persist immutable chunks or use checkpoint+tail formats instead of repeatedly rebuilding an ever-growing prefix. Do not discard data still required for canonical verification or recovery. |
| N09 | P2 / M–L | **Recover incomplete spectator snapshots.** [Watch snapshot assembly][watchchannel] rejects chunks older than 15 seconds but does not request missing chunks or announce an assembly timeout. Send failures can break the sequential chunk loop, leaving a viewer waiting. Add a bootstrap deadline, cancellation generation, bounded missing-chunk retransmission or snapshot re-request, and a visible retry action. Retain build/epoch/size validation and current consent authorization. |
| N10 | P2 / M–L | **Avoid rebuilding/broadcasting full history for each new viewer.** [WatchMirror][watch] requests canonical replay prefixes when viewers join; [snapshot send][watchchannel] broadcasts all chunks to the whole topic. Cache a recent immutable bootstrap plus tail, deduplicate concurrent joins, and target bootstrap where the authorized protocol permits. Measure bytes/CPU with long levels and several viewers joining together. Rotate/revoke cached data with feed consent. |
| N11 | P3 / M | **Coalesce spectator history without losing recovery coverage.** [WatchMirror's bounded queue][watch] already avoids sending when no viewers exist and batches at 115 ms. A newer history packet may subsume older ones. Coalesce by slot/run only when the union still covers necessary input/commands; cap pending bytes and detect failed sends. Preserve a complete bootstrap or request recovery when a viewer falls behind. |
| N12 | P2 / M | **Make connection recovery legible and actionable.** [Play reconnect][play-reconnect] and [watch screen][watch-screen] should explain the current stage—waiting for partner, relayed, retrying direct, disconnected—and offer one coherent retry/cancel path. Spectators currently need to leave/reopen after channel loss. Use deadlines and bounded rejoin, preserving consent checks. Reuse existing QOE counters and path indicators; do not expose ICE credentials, addresses, or raw logs. |

## Controls, access, and player experience

| ID | Priority / effort | Opportunity and code evidence |
|---|---|---|
| U01 | P1 / S–M | **Do not let a modal drawer remove control while the game continues.** [PlayShell.syncModal/syncInput][playshell] makes the viewport inert and disables game input on narrow layouts, but does not pause the simulation. A character can fall while the player opens settings/friends. Pause solo before an obstructing panel; online, request a shared pause with immediate feedback and keep its deterministic semantics. Only resume according to a clear player action and distinguish pauses that predated the drawer. |
| U02 | P2 / M | **Add remappable, layout-aware controls and gamepad support.** [Keyboard mapping][embed-input] uses `e.key` and fixed W/A/D/arrows. Offer remapping, physical-key vs character-key behavior, and controller input normalized into the same deterministic three-bit controls. Show controls for the actual mode: in online play either key scheme drives the assigned character. Preserve blur/focus releases and prevent stuck input when devices disconnect. Gamepad support is an optional product expansion. |
| U03 | P2 / L | **Provide real touch controls if mobile play is intended.** [Canvas/input binding][embed-input] supports pointer interaction with menus, but no on-screen movement/jump controls. `touch-action:none` alone does not make gameplay usable. Add multi-touch held-state controls, handedness/layout settings, safe-area placement, and robust pointer-cancel handling. Otherwise tell mobile visitors the keyboard requirement before they spend time joining. This is product scope, not a proven mobile performance defect. |
| U04 | P2 / L | **Expose canvas game navigation and status semantically.** [Play canvas][play-canvas] has an application label/hint, but levels and results inside the canvas do not have a complete DOM equivalent. Add accessible level selection, pause/retry/results actions, completion/status announcements, clear focus ownership, and textual controls. The drawer already has modal/inert/focus management; build on it. Offer visual alternatives for sound cues and distinguish hazards/characters by more than color where feasible. This improves access but cannot make all timing gameplay screen-reader equivalent automatically. |
| U05 | P3 / M | **Offer bounded high-DPI presentation quality.** [Canvas sizing][embed-context] is fixed at 640×480 and [fit][playshell] scales it with CSS. Large/high-DPI screens can appear soft. An optional bounded backing-resolution scale can improve clarity, but scales mask/filter work and memory rapidly. Preserve authored logical coordinates and accurate hit tests. Keep the default performance-friendly until real-device measurements support higher resolution. |
| U06 | P2 / XS | **Fix coarse-pointer footer target sizing.** [Footer CSS][styles-footer] sets 30 px min-height with more-specific selectors than the [44 px coarse-pointer rule][styles-touch]. A generic coarse rule cannot override those footer declarations. Add matching-specificity coarse rules for the actual footer/toolbar controls; verify computed sizes on touch/hybrid devices and small viewports. |
| U07 | P3 / M | **Reduce repetitive navigation after completing levels.** [Results/menu flow][game-results] returns players to the map. An explicit “Next available level,” “Replay,” or “Continue last selection” action can reduce clicks while retaining the branching map and chooser ownership. Preserve medals, online agreement, and optional exploration; do not auto-start a level without a player action. Measure completion→next start, not only page-load speed. |
| U08 | P2 / S–M | **Show useful preparation progress and make retry actually retry.** [Preparation UI][play-prepare] shows a generic Preparing message. Present stages and a bounded critical-art count. [prepare()][embed-prepare] memoizes successful preparation even when individual images failed, while SpriteRenderer knows how to retry failed art if its prepare is called again. Expose an explicit failed-resource retry/reprepare operation, show it for partial art, and clear stale notices after recovery. Retrying a rejected initial promise already works; the missing case is a successful partial preparation. |
| U09 | P2 / M | **Recover gracefully from offline, visibility, and back/forward navigation.** [Play page lifecycle][play-lifecycle] already clears input and pauses on suspension; keep that. BFCache return currently ends a shared session and asks for a new invite. With the existing path manager, explore a consent/lease-aware recovery path; otherwise make restart expectations clear. Keep solo local progress playable offline and retry cloud work on return. A service-worker/offline package is a separate, conditional feature requiring a storage/update budget. |
| U10 | P2 / S | **Explain expired/failed email links in the UI.** [redeemTokenHash][auth] logs verification failure but does not publish an actionable screen error. Show a specific invalid/expired-link state with resend or sign-in options. Never render the token itself. Measure sign-in-to-play delays and failures separately from engine preparation. |

## Database and application request efficiency

No live `EXPLAIN ANALYZE`, index usage, row counts, or database load measurements were performed. D01–D03 are source-backed candidates, not demonstrated production database bottlenecks. Current migrations already contain the leaderboard covering index and scalar auth wrappers on important read policies; recommending those as missing would be wrong. [Supabase's RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security) supports checking plans, indexing policy filters, and evaluating stable authorization calls once where semantics permit.

| ID | Priority / effort | Opportunity and code evidence |
|---|---|---|
| D01 | P2 / M | **Avoid ranking all eligible leaderboard rows just to find one pair.** [leaderboard_standing][standing-sql] builds windows/counts across all listed finished rows and only then filters the desired pair. Restrict work to nodes that pair has finished; benchmark indexed rank/count alternatives that preserve privacy and tie semantics. [The partial covering index][board-index] already helps top-N leaderboard reads. Use representative data, filters, buffers, and tail latency before choosing a rewrite. |
| D02 | P3 / S | **Check remaining row-independent authorization calls in RPC query plans.** [Leaderboard functions][board-sql] use bare `caller_allowed()`. Compare a scalar-select/initPlan form where it is truly independent of the row, and hoist constant auth values where appropriate. The latest solo/friend read policies already apply this optimization; do not wrap correlated membership checks as if they were constants. Preserve MFA, profile privacy, and friend access in the existing DB tests. |
| D03 | P3 / M | **Benchmark set-based progress merging instead of 32 individual upserts.** [Pair sync SQL][sync-sql] and [solo sync SQL][solo-sql] loop through at most 32 nodes. A validated `unnest`/set-based upsert could reduce statement/lock overhead, but this is a small bounded dataset. Keep monotonic medal/time merging, unchanged-row suppression, quotas, canonical labels, and authorization. Test concurrent devices and duplicate/out-of-order submissions. |
| D04 | P2 / S–M | **Make leaderboard ties deterministic and understandable.** [Ordering][board-sql] uses time and updated timestamp without a final unique pair key. Exact ties can have unstable ordinal ranks; the display records whole seconds. Add a stable final tie-breaker consistently to table/standing, or explicitly share ranks for equal times. More precise scoring is a separate versioned product change; do not alter simulation speed to improve ranking precision. |
| D05 | P2 / S–M | **Preserve leaderboard content and fetch only while useful.** [Leaderboard UI][board-ui] has a good 15-second table cache, but sets `opened` permanently after the first open, replaces results with Loading on refresh, and has no in-flight query deduplication/cancellation. Standings cache empty results even after errors and has no TTL. Track actual visibility; mark hidden tables dirty; use stale-while-revalidate; deduplicate/abort superseded reads; retry errors without permanently caching them. Keep focus and scroll positions. |
| D06 | P2 / S–M | **Coalesce auth refreshes and shorten independent reads.** [startAuth/refresh][auth] refreshes once explicitly and again from auth-state events; MFA checks precede the profile read, and stale generations still perform network work. Deduplicate same-session refreshes and cancel superseded reads where the SDK supports it. Parallelize only reads that remain allowed at the current assurance level; never bypass a security gate to make startup faster. Consider rendering a useful loading shell before the router waits for everything. |
| D07 | P3 / M | **If the verifier is activated, reduce idle polling and retain isolation.** [Worker slots][worker] poll every two seconds; two idle slots mean about 3,600 empty claim queries/hour. Back off with jitter, or use a notification wakeup plus reconciliation polling. Fresh worker realms intentionally prove determinism and isolate jobs; do not blindly pool them. Measure import/startup vs replay cost before tuning concurrency. Keep the active client-reported board honestly labeled unless verified results are actually wired and operated. |

## Simulation, rollback, and allocation — preserve determinism

The existing trig compatibility, fixed tick rate, one retained snapshot, typed snapshot storage, cached field lists, rollback/time sync, and sound replay suppression are deliberate and well tested. Optimize only after component profiling shows they are limiting the target device.

| ID | Priority / effort | Opportunity and code evidence |
|---|---|---|
| T01 | P3 / L | **Reduce proven hot temporary-vector allocation.** [Legacy Box2D][box2d] constructs temporary vectors/arrays in several hot methods. Use per-instance scratch values only where aliasing and re-entrancy are understood. Do not reorder floating-point arithmetic or globalize mutable scratch across simultaneous worlds. Compare allocation, physics p95, all-level digests, and cross-browser results. |
| T02 | P3 / S–M | **Cache fixed references in level updates.** [Level.Update][game-update] repeatedly looks up known scene children such as finish doors and performs repeated property-chain work. Cache references when the level is built; invalidate if frame scripts replace them. This is safer than a physics rewrite but likely smaller than rendering wins. |
| T03 | P2 / M–L | **Reduce display-tree snapshot allocation.** [advanceTree/enterFrameTree][flash] copy child arrays during both walks; event dispatch also copies handler lists. Cache immutable child/listener snapshots by mutation revision, or use an equivalent mutation-safe traversal. Maintain the exact visit/event order when scripts add/remove objects. Hidden clips can affect death/completion; skipping them wholesale is incorrect. |
| T04 | P3 / L | **Reduce the snapshot footprint of inactive capacity only with a proven schema.** [Broadphase/pair pools][box2d] preallocate legacy fixed-capacity structures; the reflective snapshot captures a large graph even for modest active worlds. A specialized representation or active-slot serialization could help. Capacity is already only 512 proxies; do not arbitrarily lower it or omit free-list state. All 32 levels and contact/free-list transitions must round-trip. |
| T05 | P3 / XL | **Consider an explicit simulation snapshot schema if captures dominate on target devices.** [Snapshot][snapshot] is already optimized and measured viable, but captures ~26,000 objects. Separating immutable authored data, mutable physics, and shell state could reduce capture/restore costs and improve migration. Keep the generic serializer as an oracle while developing, version the format, and include clocks, playheads, flags, progress projection, listener identity, and dynamic fields. This is a high-maintenance architectural option. |
| T06 | P3 / L | **Make global engine ownership explicit before multi-view/worker expansion.** [Singleton Stage/clock/SoundBus][flash] and the legacy root model assume one active game realm. Fix the present Stage teardown first. If simultaneous game previews, multiple active views, or workers are introduced, isolate those globals per realm or context so one view cannot reset another's clock/input/audio. This is future scalability work rather than a reason to rewrite working single-view code. |

## Faster builds, verification, and iteration

| ID | Priority / effort | Opportunity and code evidence |
|---|---|---|
| B01 | P2 / M | **Cache converted assets by input content and encoder settings.** [assets.mjs][asset-build] reconverts 1,885 images on every complete build. Reuse a validated content-addressed conversion cache, copy outputs into a clean staging directory, and verify every manifest reference. Use the same cache locally and in CI. Avoid leaving obsolete output files or weakening incomplete-release refusal. |
| B02 | P3 / S | **Avoid redundant compilation in test→build workflows.** [Root/engine/app scripts][package] build the engine during engine tests and again in the app prebuild. An orchestrated CI command can compile once, then run tests and package from that exact output. Standalone `npm run build` must remain self-sufficient. Consider incremental TypeScript only if clean-build parity is checked. |
| B03 | P2 / XS–S | **Cancel obsolete fast CI runs for the same branch.** [fast.yml][ci] has no run concurrency cancellation. Add a branch-scoped group with cancellation for superseded pushes, while preserving independent PR results. Keep DB migration/test jobs serialized and never cancel midway through a database mutation simply to save runner minutes. The existing fast/full split is already useful. |
| B04 | P1 / M | **Add regression budgets around the real user journey.** [Current browser benchmark][perf-script] measures one solo level well but does not cover play-route startup, modal control loss, real high-refresh displays, heavy mechanisms, or production art across slow CPU/network conditions. Track cold/warm first playable, invite-to-shared-frame, completion-to-cloud-ack, reconnect progress loss, renderer/correction p95, input-to-render, and decoded-memory plateau. Use representative devices/levels and distributions, not a single machine's FPS score. Keep measurement overhead documented. |
| B05 | P2 / S–M | **Turn the reproduced lifecycle/save scenarios into maintained regression coverage.** [Audit checks][checkscript] intentionally use only local mocks and the actual engine methods. Add equivalent meaningful application tests for delayed solo response, cleanup ordering, storage failure, solo completion persistence, Stage disposal, partial-art retry, and refresh-rate-independent stall notices. Keep tiny unit checks separate from expensive browser/live-service suites and ensure documentation reflects actual preparation/autosave behavior. |

## Suggested implementation order

1. **Protect progress:** S01–S04, L01, and application-level regressions. These affect earned results and retained games.
2. **Improve immediate feel:** N01–N03, U01, A04–A05, and R06/R08. Measure action acknowledgement and time to play.
3. **Recover the frame budget:** R01–R03, A01, R10, and B04. Use the packaged assets and representative levels; verify masks/screenshots and deterministic hashes independently.
4. **Strengthen long sessions and recovery:** S05–S07, A02–A03/A11, N04–N06/N09–N12, U08–U10, D05–D06.
5. **Improve access and iteration:** U02–U06, B01–B03/B05, and query optimizations justified by real plans.
6. **Evaluate larger experiments:** atlases/worker rendering/GPU rendering, explicit snapshots, long-run checkpoint formats, and verifier activation only if measured needs justify them.

Potential acceptance targets, to validate against actual target hardware rather than treat as promises: substantially less than 16.7 ms render p95 at 60 Hz with room left for input/network/DOM; fewer startup tasks above 50 ms; immediate visible acknowledgement of control requests; unchanged match progress across supported path migration; cloud save status that never claims acknowledgement before it happens; retained listeners/memory returning to a stable plateau after repeated navigation.

## Preserve what is already working

- Deterministic 26 Hz simulation and cross-run/cross-browser compatibility tests.
- Read-only visual interpolation and existing controlled local extrapolation; optional descendant interpolation requires cache/CPU evaluation.
- Cached terrain masks, bounded character filter tiles, transform-decomposition caching, and lazy route chunks.
- Shared downloads with 12 bounded decode lanes, WebP build conversion, compressed source audio, and immutable asset caching—improve prioritization/identity rather than deleting these protections.
- Immediate input-edge publishing, repeated packet history, adaptive input delay, time synchronization, and the existing path manager.
- Account-scoped durable IndexedDB pair outbox, monotonic merge, revision-aware acknowledgement, and cross-tab ownership.
- Private Realtime topics, consent/feed revocation, RLS/MFA gates, secret scanning, and zero-cost hosting constraints.
- Existing modal focus/inert behavior, semantic surrounding UI, reduced-motion CSS, fullscreen chrome, and explicit audio disposal.

Avoid unsupported shortcuts: increasing physics tick rate, lowering the solver's 50 iterations, weakening authorization, sending full game state every frame, enabling expensive interpolation indiscriminately, skipping invisible frame scripts, accepting save success before acknowledgement, or pooling verifier jobs without preserving fresh realms. Each can make a benchmark look better while changing gameplay or correctness.

## Reproduce the evidence

```powershell
npm --prefix engine test
npm run test:network-unit
npm run build
npm run check
node benchmarks/deep-audit-20261002-checks.mjs
node engine/test/performance.mjs deep-audit-local
$env:FBWG_BENCH_ASSETS = 'dist/extracted/assets'
node engine/test/performance.mjs deep-audit-local-production
```

Browser/esbuild subprocesses may need the same allowed execution environment as the successful reruns. Use unique benchmark labels to preserve earlier results. Configured vs deliberately unconfigured build checks must match the environment used to build. Live DB tests, hosted WAN scenarios, low-end-device measurements, and production query plans remain additional validation, not results claimed here.

[bench1]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/benchmarks/deep-audit-20261002.json
[bench2]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/benchmarks/deep-audit-20261002-repeat.json
[benchprod]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/benchmarks/deep-audit-20261002-production.json
[checks]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/benchmarks/deep-audit-20261002-checks.json
[checkscript]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/benchmarks/deep-audit-20261002-checks.mjs
[solo]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/solosave.ts:122
[pair]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/pairsave.ts:102
[save]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/game/save.ts:172
[embed-step]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/embed.ts:693
[play-confirm]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/play.ts:499
[play-save]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/play.ts:851
[embed-destroy]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/embed.ts:873
[game-start]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/game/game.ts:5014
[masks]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/render/sprites.ts:877
[filters]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/render/sprites.ts:793
[sprites]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/render/sprites.ts:351
[sprites-load]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/render/sprites.ts:226
[text]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/render/sprites.ts:767
[hit]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/render/sprites.ts:625
[embed-pick]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/embed.ts:540
[embed-tick]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/embed.ts:703
[embed-context]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/embed.ts:173
[embed-render]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/embed.ts:804
[embed-prepare]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/embed.ts:490
[embed-intent]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/embed.ts:254
[embed-input]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/embed.ts:302
[assets]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/render/assets.ts:1
[fonts]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/render/fonts.ts:42
[audio]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/audio/player.ts:112
[release]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/scripts/release.mjs:45
[main]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/main.ts:36
[command]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/net/session.ts:289
[session]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/net/session.ts:1279
[session-frame]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/net/session.ts:1457
[session-stall]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/net/session.ts:1373
[play-stall]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/play.ts:1023
[play-invite]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/play.ts:1258
[lobby]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/lobby.ts:195
[play-reconnect]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/play.ts:1480
[pathmanager]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/net/pathmanager.ts:1
[watch]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/net/watch.ts:1
[watchchannel]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/net/watchchannel.ts:84
[watch-screen]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/watch.ts:1
[playshell]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/ui/playshell.ts:147
[play-canvas]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/play.ts:128
[styles-footer]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/ui/styles.css:322
[styles-touch]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/ui/styles.css:569
[game-results]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/game/game.ts:4793
[play-prepare]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/play.ts:892
[play-lifecycle]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/screens/play.ts:1718
[auth]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/auth.ts:123
[standing-sql]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/supabase/migrations/0013_assurance_and_entitlement.sql:476
[board-sql]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/supabase/migrations/0013_assurance_and_entitlement.sql:436
[board-index]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/supabase/migrations/0018_leaderboard_index.sql:22
[sync-sql]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/supabase/migrations/0016_progress_writes.sql:141
[solo-sql]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/supabase/migrations/20260910130000_solo_progress_ambiguity.sql:25
[board-ui]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/src/ui/leaderboard.ts:97
[worker]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/worker/run.mjs:1
[box2d]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/box2d/box2d.ts:871
[game-update]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/game/game.ts:2081
[flash]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/flash/flash.ts:453
[snapshot]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/src/net/snapshot.ts:1
[asset-build]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/app/scripts/assets.mjs:1
[package]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/package.json:1
[ci]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/.github/workflows/fast.yml:30
[perf-script]: C:/Users/jayan/GeorgiaTech/Research/fireboy-and-watergirl/engine/test/performance.mjs:1
