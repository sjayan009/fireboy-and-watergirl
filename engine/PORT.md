# Engine port

TypeScript port of the physics and game code recovered from the SWF.

```
src/box2d/box2d.ts     GENERATED - Box2DFlash 2.0.2, 10,925 lines
src/box2d/dettrig.ts   hand-written - deterministic sin/cos/atan2
src/flash/flash.ts     hand-written - the Flash display API the game needs
src/flash/symbols.ts   GENERATED - 107 SWF library symbols
src/game/game.ts       GENERATED - level + ContactListener, 3,483 lines

src/render/sprites.ts  renders the original SWF art from the scene graph
src/render/filters.ts  Flash GlowFilter / DropShadowFilter via ctx.filter
src/render/debugdraw.ts physics view -- draws collision shapes, not the art
src/audio/player.ts    plays the SoundBus queue through Web Audio
src/net/hash.ts        deterministic state digest + input packing
src/main.ts            browser harness entry point
src/replay.ts          headless replay CLI, for cross-machine checks

src/trigcheck.ts       trig accuracy vs Math.*
src/smoke.ts           physics smoke test
src/coverage.ts        every solid tile has a collision shape, all 32 levels
src/leveltest.ts       boot one level and step it
src/alllevels.ts       boot all 32 levels, and test input
```

Regenerate with `python tools/as3_to_ts.py && python tools/gen_symbols.py &&
python tools/gen_game.py`. **Never hand-edit the generated files** — change the
generator instead. `npm test` runs everything.

## Why it is generated

AS3 *is* ECMAScript, so the decompiled Box2DFlash 2.0.2 translates almost
one-to-one. Generating it means the port is reproducible and reviewable as a
diff, and it keeps us on the exact physics build the original game shipped
rather than a modern Box2D whose solver behaves differently.

11,729 lines of AS3 across 74 files → 10,925 lines of TypeScript, compiling
with zero errors.

## The five things AS3 does that TypeScript does not

Each of these is a silent-wrong-answer bug, not a compile error, so they are
worth knowing about:

1. **Unqualified instance members.** `m_flags` means `this.m_flags`. Safe to
   rewrite automatically because the decompiler names every local `_locN_` and
   every parameter `paramN`, so no member name can ever be shadowed.
2. **Unqualified statics, including inherited ones.** `e_circleShape` inside
   `b2CircleShape` resolves to `b2Shape.e_circleShape`.
3. **Static initialiser order.** `b2BroadPhase.b2_invalid` reads
   `b2Settings.USHRT_MAX`, but `b2BroadPhase` is declared first. All static
   initialisers are hoisted to the end of the file and topologically sorted by
   the `Class.static` references they make.
4. **`var` is function-scoped.** The decompiler declares a local inside one
   `if` block and uses it in the next. Emitting `let` would make that a
   reference error, so locals stay `var`.
5. **Typed locals coerce on assignment.** This is the subtle one:
   `var i:int = (lo + hi) / 2` *truncates* in AS3. TypeScript's `number` keeps
   the fraction, turning `bounds[i]` into `bounds[0.5]` — `undefined`. Every
   assignment to an `int`/`uint` variable is wrapped in `i32()`/`u32()`, which
   is exactly AS3's semantics (`x | 0` and `x >>> 0`).

Everything lands in **one module**: Box2D's class graph is densely circular
(`b2World` ↔ `b2Body` ↔ `b2Shape` ↔ `b2Contact`), and ES module cycles would
break `extends` at evaluation time.

## Determinism

Lockstep netcode requires both peers to compute bit-identical physics.

- `Math.sqrt` is fine — IEEE-754 requires it to be correctly rounded, and
  ECMAScript mandates that.
- `Math.sin`, `Math.cos` and `Math.atan2` are **not** fine. ECMAScript specifies
  them as "implementation-approximated", so V8, SpiderMonkey and JSC may each
  return a different last-ulp result. Two peers on different browsers would
  drift apart within seconds.

`dettrig.ts` reimplements them with fdlibm's algorithms using only `+ - * /`,
all of which are correctly rounded and therefore identical everywhere. Measured
against V8's own implementations: **0.704 ulp** worst case for sin and cos,
**1.0 ulp** for atan2, with every atan2 sign/edge convention matching exactly.

Only five call sites needed rewriting, all in `b2Mat22` (building a rotation
matrix from an angle, and reading the angle back).

`Math.random` appears only inside `b2Math.b2Random()`, which nothing in the
game calls — there is no randomness in the physics path.

## The Flash shim is part of the simulation

`level.as` does not merely draw MovieClips, it reads them back as game state:

- the exit doors' `currentFrame` gates level completion (`< 22`, `== 22`), and
  the SWF says `FinishBoy`/`FinishGirl` have exactly 22 frames
- levers and wind machines address a child named `light`
- the characters address `mc_1`..`mc_5` and `mc_4.head`
- a Box2D body's `userData` *is* its MovieClip, and bodies are found again
  through `getChildByName`

So `flash.ts` is a deterministic scene graph, not a renderer, and `symbols.ts`
carries the real frame counts and child names pulled from the SWF
(`tools/extract_symbols.py`). Rendering will read this tree; it never writes
to it.

Two deliberate departures, both cosmetic:

- `hitTestPoint` always returns true. Its one use fades the tutorial overlay;
  reproducing vector hit-testing would be a rendering job.
- sound playback is pushed onto a `SoundBus` queue instead of playing
  inline, which keeps audio out of the deterministic path — a muted peer
  cannot desync a loud one.

## Verification

`npm test` runs fourteen checks:

| Test | What it proves |
|---|---|
| `trigcheck` | deterministic sin/cos/atan2/acos within a few ulp of `Math.*`, and exact `pow` for integer exponents |
| `smoke` | Box2D settles bodies at numerically correct rest positions |
| `coverage` | **all 32 levels: every solid tile has a collision shape** |
| `leveltest` | a real level boots, simulates, and is repeatable |
| `alllevels` | all 32 levels boot; input moves each character independently |
| `diamonds` | the right character collects, the wrong one does not |
| (visual) | `snaps/` -- the page POSTs canvas grabs to the dev server, which is how the rendering bugs above were actually found |
| `shelltest` | the whole shell headlessly: intro to map to level to pause to results to menu, with progress recorded |
| `determinism` | a fixed 600-frame input log reproduces an exact state digest |
| `mousetest` | Playwright's real mouse clicks Play, a level node, Retry Level and Main Menu, and locked nodes are not clickable |
| `rendertest` | the rope's chain really grows on screen with the length the game sets |
| `nettest` | two lockstep sessions over a simulated link: 5000 frames at 150 ms RTT with 5% loss, 25% loss, synchronised pause and retry, and a corrupted peer detecting and repairing itself |
| `twotabs` | two real browser tabs pair, play, and stay bit-identical; each moves only its own character |
| `webrtc` | a real RTCDataChannel carries a real game between two tabs, and a pair with WebRTC removed still plays over the relay |
| `crossengine` | the same log gives the same digest in Chromium, Firefox and WebKit |

`smoke` checks numbers rather than just "it didn't crash", stepping the game's
own settings (gravity `(0, 26)`, timestep `1/26`, 50 iterations): a
0.95-half-height box on ground whose surface is at y=27 settles at **26.0505**
(the expected 26.05 plus Box2D's resting slop), a radius-0.8 ball at
**26.2050**, and the first-step fall is **0.0385** = `g·dt²` = `26/26²`.

`coverage` is the strongest of these. The level tables were decoded by one
program (`tools/extract_levels.py`, walking raw bytecode) and turned into a
physics world by a completely different one (the transliterated
`CreateGround`). They agree on every solid tile of all 32 levels.

Spot-checked against the extracted data: `adventure-01` builds 422 shapes
across 20 bodies, spawns Fireboy at (2, 27) and Watergirl at (2, 23), and has
exactly 1 lever and 2 pushers — matching `extracted/entities/adventure-01.json`
exactly. Holding right moves Fireboy from x=2.0 to x=11.4 while Watergirl stays
put.

One scare worth recording: three levels report exactly 512 shapes, and
`b2_maxProxies` is 512. Raising the limit to 4096 changes nothing and every
solid tile is covered, so the number is genuine rather than a silent cap.

## Rendering the original art

`tools/export_assets.py` runs two JPEXS passes, because each gives something
the other cannot:

- **`sprite:png`** -- the pixels, one file per symbol per frame. Smaller than
  SVG here (34 MB vs 64 MB) because the art is dense vector work, and the game
  is a fixed 640x480 stage, so resolution independence buys nothing.
- **`sprite:svg`** -- the *structure*: each frame's registration offset, and
  the placement matrix of every named child instance.

Trimmed to 268 sprites / 1,865 frames / **16 MB**, plus 17 sound effects as
WAV. Three things are dropped: the `DefineSprite_912` library container (one
instance of every symbol, placed off-stage purely to force export), the Armor
Games intro, and `LightMask` -- which `CreateGround` constructs and names and
then never adds to the display list. It is dead code in the original too, and
at 434 frames it was the single heaviest sprite.

Four behaviours had to be reproduced before the picture was right, and each was
invisible until it wasn't:

1. **Composites vs. named children.** JPEXS bakes child instances into the
   frame image. FireBoy carries five pose clips `mc_1`..`mc_5` and shows one by
   toggling `visible`; drawing the composite stacked all five. So a sprite with
   named children skips its composite and draws the children, each seeded with
   the SWF placement matrix and freely overridden by game code (`mc_4.scaleX =
   -0.135` flips a pose).
2. **Masks are never painted.** `GroundMask` is a *child of* `GroundMC`, so
   drawing it painted over all 378 terrain tiles. Flash only ever clips with a
   mask, so `DisplayObject.mask` now marks its target `isMask`, and masked
   subtrees are composited through an offscreen layer with `destination-in`.
   That is what confines the moss texture to the ground.
3. **Cached bitmaps.** `CreateGround` rasterises the assembled terrain into a
   `BitmapData` and stages only the resulting `Bitmap` -- `GroundMC` itself
   never gets a parent. We cannot rasterise, so `BitmapData.draw` remembers its
   source and the renderer walks that subtree instead.
4. **A sprite's own art is not its children.** The exporter also writes a
   *base* image per frame with the named instances stripped out, and the
   renderer draws base-then-children. Skipping the composite entirely (the
   first attempt) threw away the sprite's own art: 38 sprites were affected, so
   a running character was a floating head and a sliding platform was just the
   little coloured light strip from inside it.
5. **Clips auto-play.** Flash animates a placed multi-frame clip unless
   something stops it, and what stops it is the SWF frame script
   (`addFrameScript(0, frame1)` calling `stop()`). Without this the lava, water,
   goo and diamonds all sat frozen on frame 1. `gen_symbols.py` recovers those
   stop frames from the symbol sources -- 20 symbols have them, including the
   exit doors, the lever on/off states and each tutorial page.

6. **A mask lives in the parent's coordinate space.** It sits *beside* the
   node it clips, not inside it, so the mask must be drawn before the node's
   own transform goes on the context. Applying it after offsets the mask by the
   node's position twice. This is invisible for the moss texture (`texture1`
   and `GroundMask` are both at 0,0) and fatal for a floor button at (590,198)
   whose mask sits at (590,200): the mask landed off-screen and
   `destination-in` erased the button completely. The pressure plates you stand
   on were simply gone.

7. **Filters are applied in code, not baked.** `level.as` sets four:
   an orange `GlowFilter` on Fireboy, a blue one on Watergirl, and on the
   terrain a black outline glow plus a `DropShadowFilter`. Without them the
   terrain has no edge definition and the characters no halo. `filters.ts`
   maps them onto `ctx.filter` drop-shadows; the terrain's is cached, since it
   is static after load and full-screen blurs are not cheap.

   That cache has one trap worth remembering: keyed on the transform alone, a
   layer rendered *before its art finished loading* was cached blank forever,
   which silently erased the entire terrain. The key now includes a generation
   counter bumped on every image load.

The renderer never writes to the scene graph: that tree is simulation state.
The physics view is still one checkbox away, because sprite art hides exactly
the kind of collision bug it was built to expose.

## Playing it

```bash
node serve.mjs          # or: preview_start "fbwg"
```

Then open <http://localhost:5173>. The game boots into its own intro menu.

| | |
|---|---|
| Menus | click, or arrows move / Enter selects / Esc goes back |
| Fireboy | arrow keys |
| Watergirl | W A D |
| P | pause |
| M | mute |
| R | retry, on the game-over board |

A fresh save opens only level 1, so **Unlock all levels** is there to reach
level 30 without playing to it. Checkboxes switch between the original art and
the live Box2D world — the physics view shows a wrong collision shape rather
than hiding it behind art.

Two buttons matter:

- **Replay check** re-runs the inputs you just played into a fresh level and
  compares digests. It proves the simulation is a pure function of
  (level, input log) — the property lockstep netcode is built on.
- **Cross-engine check** replays a fixed 600-frame log shipped as
  `web/scriptlog.txt` and compares against a reference digest. Open the page in
  another browser or on another machine; a mismatch means those two peers would
  desync. `npm test` does this automatically for three engines.

`window.__debug` on the page exposes `step(n)`, `render()` and the shell
dispatcher. `requestAnimationFrame` is throttled to a crawl in a hidden or
background tab, so driving the game from automation needs to step it directly.

## Determinism status

Verified so far, on `adventure-01` over a 600-frame scripted log:

| | frame 100 | 200 | 300–600 | fire | water |
|---|---|---|---|---|---|
| Node | `9d9213e4` | `2578a018` | `aba863c1` | 13.581378, 24.147853 | 18.426033, 27.123074 |
| Browser | `9d9213e4` | `2578a018` | `aba863c1` | 13.581378, 24.147853 | 18.426033, 27.123074 |

Identical across the whole run, and `npm test` now replays the same log in
Chromium, Firefox and WebKit through Playwright (`engine/test/crossengine.mjs`),
so **V8, SpiderMonkey and JavaScriptCore all agree**. Playwright's WebKit is
JavaScriptCore, the engine Safari uses, though not literally Safari on macOS.
The Cross-engine check button in the harness runs the same log in whatever
browser you happen to be holding.

Three hazards were found and closed on the way there. `Math.sqrt`, `abs`,
`min`, `max`, `round` and `floor` are exactly specified by ECMAScript and are
safe; these were not:

| Call | Where | What was done |
|---|---|---|
| `Math.acos` | `CreatRoman` — the result goes into `SetXForm`, so it is a physics body angle and lands in the digest | `detAcos` in `dettrig.ts`, built on the already-verified `detAtan2` |
| `Math.pow(x, 2)` | rope and chain display geometry | `detPow`, exact repeated multiplication for integer exponents |
| `Math.random` | firefly placement, which `GroundBox` variant draws each tile, decor rotation | a seeded PRNG (`net/rng.ts`) keyed on `(mode, level)` |

None of them moved the digest — `detAcos` happens to agree bit-for-bit with V8
at the one argument `adventure-01` reaches — but each was a live risk, and the
random one is why two peers would otherwise have looked at visibly different
terrain.

One trap worth recording, because it wasted a cycle and mimics a real desync:
the first attempt generated the input log from an LCG *in each host*.
`s * 1103515245` exceeds 2^53, so JavaScript's floats silently lose precision
where Python's integers do not, and the two sides ran **different inputs**. The
hashes diverged and it looked exactly like a physics bug. Always ship the input
log as data; never regenerate it per host.

## Instance names are not unique

`MainMenu` places **eight different clips all called `node_1`** -- three
decorative markers and five real map nodes, characters 569, 571, 573, 589, 591
and 607. Flash's IDE normally prevents that; a published SWF does not care.

This broke the same way twice, in two different programs, and both are worth
remembering because the symptom was silent and plausible:

1. `gen_symbols.py` looked up a child's character id and placement matrix **by
   name**, so seven of the eight got the wrong art at the wrong offset.
2. The renderer then matched a child to its per-frame placement **by name**
   too. `Array.find` returns the first match, so every clip called `node_1`
   was drawn at the first one's position -- the real level-1 node landed at
   x = -235, off the side of the stage, and the map showed an empty hexagonal
   socket where its medal should be.

Both now match by **placement index**. `gen_symbols.py` zips the two
extractors' child lists and fails loudly if they disagree; the renderer stamps
each child with its index at construction (`__place`) and checks the name still
agrees before trusting it, so a future drift degrades to the old lookup rather
than silently drawing the wrong art. `mousetest` asserts that no two clips
share a placement and that the completed node really draws its medal.

The general lesson: **a name is not an identifier in this SWF.** Anything that
resolves display objects by name needs a tie-break, and `find()` is the wrong
one.

## A bug worth remembering

Diamonds were never collected. The cause was not game logic but the
transliterator: `qualify()` prefixed bare identifiers with `this.` using a
regex over whole lines, and did not skip **string literals**. Since `pers1` is
a field of `level`, `userData.name = "pers1"` was emitted as `"this.pers1"`,
and `ContactListener` compares against `"pers1"`. Eight literals were affected,
all in `game.ts`. `split_code_strings()` in `as3_to_ts.py` now isolates strings
and comments from every rewrite, and `diamonds.ts` is the regression test.

The second half of the symptom was mine, not the original's: a collected
diamond's *sensor shape survives*, because `ContactListener` runs inside
`world.Step()` where `b2World.m_lock` is true and `b2Body.DestroyShape` returns
early. The original behaves identically — it relies on `removeChild` for the
visual and on renaming the body to stop a second collection. The debug renderer
was drawing shapes rather than the display list, so it kept showing a diamond
the game considered gone. **The display list, not the shape list, is the truth
about what is on screen.**

## Audio

17 effects plus three soundtracks, all decoded to WAV so the two clips that
exported as `.flv` still play. `Menu_Sound` plays on the intro and the level
map, `Adv_Sound` in adventure and puzzle levels, `Speed_Sound` in speed levels
— exactly as `Game.as` chooses them.

There is no special "music channel". `Game.as` starts the soundtrack the same
way it starts wind or a moving platform (`play(0, 999)`) and keeps a
`SoundChannel` so it can duck or stop it, so the player models that directly:
every looping sound gets its own gain node keyed by symbol, and the ported
code's `soundTransform` and `stop()` arrive as control events naming it. That
is what makes `PauseMenu.Update`'s duck from 1.0 to 0.2 work without a special
case.

Two ordering traps, both fixed, both invisible at a steady frame rate:

- **Plays and controls share one ordered queue.** Keeping them apart and
  applying every control before every play reorders them whenever more than one
  frame is drained at once. Finishing a level queues "stop `Adv_Sound`" and
  then "play `Menu_Sound`"; handling the stop first left the in-game track
  running underneath the menu music.
- **Looping requests survive a sleeping `AudioContext`.** Browsers will not
  start one without a user gesture, and one-shot effects are still dropped
  until then — a burst of stale effects is worse than silence. But the
  soundtrack is started *once*, on the intro menu, long before any gesture, so
  discarding it meant the music simply never played.

## Fireflies, and the rest of the cosmetic randomness

The drifting grey glows are the `bug` sprite, ambient decoration from the
original. `level.as` places them with `Math.random()`, and does the same to
choose which of `GroundBox1..4` draws each terrain tile and how the decor is
rotated. None of it touches the physics world, so none of it was ever in the
determinism digest -- but it is exactly why two peers would have looked at
visibly different levels and reasonably concluded they had desynced.

`Math.random()` is now a seeded generator (`net/rng.ts`) keyed on
`(mode, level)`, so both peers build the same scenery from the same level id
with no extra bytes on the wire. The arithmetic is deliberately all 32-bit:
an earlier LCG here used `s * 1103515245`, which exceeds 2^53 and silently
produced *different numbers per host* -- indistinguishable from a physics
desync, and not one.

## The shell

`Game.as` is ported (`tools/gen_game.py`, alongside `PauseMenu.as`,
`Recuento.as`, `GameOvero.as`, `FPSCounter.as`, `deadFire.as` and
`WaterGirlStairs.as`): intro menu, the level-node map with its medals, golden
road and firefly cursor, the pause tray, the results board, game over, the
timer and the mute button. `shelltest.ts` drives the whole loop headlessly.

Dropped, as dead 2009 plumbing: the CPMStar ad preloader, the Armor Games
teaser, and the hiscore endpoints. Their *methods* are kept with empty bodies
rather than deleted, because `CreateIntroMenu` still wires buttons to them —
emptying them leaves the surrounding control flow literal. Their button art
still draws, so the intro menu reads exactly as it did.

Four things about AS3 that had to be modelled properly before any of it worked:

- **Frame scripts can do more than `stop()`.** `deadFire` frame 32 calls
  `Game.GameOver()` and `WaterGirlStairs` frame 35 calls `Game.Recuent()`.
  Those two clips are the *only* triggers for the death and results screens in
  the entire game, so a shim that only honoured `stop()` would let you build
  the whole shell and never see either.
- **Method references are bound.** `Rboard.addEventListener(ENTER_FRAME, Ease)`
  inside `Recuento` must call `Ease` with the Recuento as `this`, not the board
  the listener is attached to. The generator wraps every method reference
  passed to add/removeEventListener in `DisplayObject.__bind`, which memoises
  so removal still matches by identity.
- **Anonymous functions capture the lexical `this`.** The results board's back
  button is an inline closure calling `EndGame()`. They are emitted as arrow
  functions.
- **The display-list walk must descend through plain Sprites.** `level` is a
  Sprite, so a MovieClip-only recursion stopped dead at it and nothing inside a
  level ever animated — doors frozen shut, `deadFire` stuck on frame 1.

### The timer: one deliberate divergence

`TimerUpdate` reads `getTimer()`, a wall clock. Two peers in lockstep have to
award the same medal from the same `TimeTable` thresholds, and a wall clock
makes that a race with whichever machine stutters. The ported `getTimer()` is
derived from the frame counter instead (`frames * 1000 / 26`), which equals
real time except during a stall — exactly the case where the original would
have disagreed anyway.

### Progress

`The_cookie` (a `SharedObject`) is behind `game/save.ts`, keeping the same
shape the ported code reads: `stats[32]`, `times[32]`, `timesString[32]`.
localStorage today, memory in tests. Online play needs progress keyed to a
*pair* rather than a browser, and a Supabase store slots in behind the same
interface without touching the ported code.

## Text

The 56 static `DefineText` characters need nothing — JPEXS bakes them into the
sprite art as glyph outlines, and they were already on screen. The 35
`DefineEditText` fields are the live ones (`tools/extract_text.py`): the timer,
the diamond counters, the results time, the per-level best times on the map.
Each is placed as a *named* child, so the base-art stripping had already left a
hole to draw into; `gen_symbols.py` builds a `TextField` for it and
`render/sprites.ts` draws it.

The five embedded fonts are exported as TTF and registered by **character id**
(`swf-font-767`), never by name: characters 49 and 767 are different faces
("Trajan Pro Bold" and "Trajan Pro") that both carry the internal TTF name
"Trajan Pro", so a name-keyed family would silently collide and the timer would
render in the wrong weight.

## Buttons

Menus take the mouse and the keyboard, and neither path calls a handler
directly. Each decides which button is meant and dispatches a real `MouseEvent`
at that clip, so every listener `Game.as` registered fires as it would have on
a click — `StartGameBtn` still parses the level out of `e.target.name`, and
`Glowin` still positions the firefly cursor from `e.target.x/y`.

- **Mouse.** `SpriteRenderer.hitTest` walks the display list and returns the
  topmost button under a stage point. Hovering rolls over, so the node lights
  up, the firefly chases the pointer and the roll-over sound plays, exactly as
  in 2009. `main.ts` converts pointer coordinates back through whatever CSS
  scale the canvas has, and sets the cursor.
- **Keyboard** (`game/shellinput.ts`): arrows move, Enter selects, Esc goes
  back, M mutes, P pauses. Map navigation walks the `Adjacencies` graph the
  game already builds to decide what a win unlocks, so it follows the drawn
  paths. Picking a node with the mouse moves the keyboard cursor to it, so the
  two never disagree.

`tools/extract_buttons.py` recovers each `DefineButton2`'s **up** and **hit**
states. Both are needed, for different reasons:

- the up state is the art. Without it the intro menu showed a temple and a
  title and nothing where "Play" should be — JPEXS exports DefineSprite, and a
  button is not one.
- the hit state is what is clickable, and it is **not** the same shape. The
  level map's node buttons (624, 626, 628) have an *empty* up state: the
  visible hexagon is a separate `node_N` clip and the button is a bare
  invisible hit area over it. Hit-testing the drawn state would have left all
  32 levels unclickable.

The hit box is computed at export time — each hit placement's art rectangle,
transformed by its matrix, unioned — and stored in the button's own
coordinates. `hitTest` maps the stage point back through the node's transform
to compare against it, so a rotated button would still be exact.

`buttonBoxes` is the shared walk behind both drawing and hit-testing, and it
deliberately mirrors `drawNode`: same skip rules, same transform order, same
per-frame child matrices. A button that draws in one place and is clickable in
another is worse than one that is not clickable at all, and it looks fine in a
screenshot — which is why `engine/test/mousetest.mjs` drives Playwright's real
mouse through Play, choosing a level, Retry Level and Main Menu rather than
trusting the geometry.

`enabled = false` is honoured: `CreateMainMenu` sets it on every level the
player has not reached, and those nodes are not hit-testable at all.

All three drawn states are recovered, and hover feedback is the SWF's own
rather than anything invented:

- **Play** places its label character *twice* at the same matrix when hovered,
  so the text draws over itself and reads brighter; pressing scales that to
  0.9 so it shrinks under the click.
- **Retry Level**, **Main Menu** and **Continue** swap in a different label
  character entirely, and Main Menu swaps its plaque too.
- the map's nodes have no art of their own in any state — their highlight is
  the `Glower` clip the game itself toggles — so they fall back to `up`.

15 of the 29 buttons change on hover. The state lives on the clip
(`__btnState`), not in the input layer, so the keyboard lights a button exactly
as the mouse does. That last part is a small liberty: the original only ever
highlighted under the pointer, because it had no keyboard navigation to
highlight for.

## Ropes, and three things that had to be true at once

`level.as` grows a rope by setting `chain.y` and `ropeMask.height` together to
the distance between its anchors. Getting that on screen needed three separate
recoveries, and any one of them missing left the rope silently static:

1. **The chain is a named child JPEXS nests one group deeper.** A strictly
   top-level scan of the exported SVG missed it, so it stayed baked into the
   composite at its authored length. `parse_svg_frame` now takes a named
   `<use>` at any depth when the SWF says the symbol really has a child of that
   name — and refuses outright if an ancestor group carries a transform, since
   the matrix would then not be in the sprite's coordinates.
2. **The mask is invisible in every sense.** Nothing in the ActionScript says
   `ropeMask` is a mask; the SWF marks it with a **ClipDepth** on its
   PlaceObject, which is how the Flash IDE records a mask layer. JPEXS does not
   export mask art either — but the mask is a DefineSprite, so it was already
   in the sprite export under its character id.
3. **`height` is a scale.** Flash's `height` sets an object's rendered height
   by scaling it. The shim cannot know how tall a clip's art is, so the
   conversion happens in the renderer, where the manifest does.

That work also turned up a real bug in the matrix decomposition. `[-1, 0, 0,
-1]` is a pure half turn, but taking the scale signs from `a` and `d`
individually read it as a 180-degree rotation *and* a (-1, -1) scale, which
cancel to the identity. The scale signs now come from the determinant. Two
placements in the whole SWF were affected: the rope's chain, which hung
downwards from its anchor and so never overlapped its own mask, and `Roman`'s
`tri1`, which was mirrored vertically instead of horizontally.

## Loading

Each frame of a sprite is a separate file, and the renderer used to request one
only when that frame first appeared. A 69-frame clip like the menu's fireflies
therefore popped in and out for its first two and a half seconds, and a
character's run cycle flickered the first time it ran. Drawing any frame of a
multi-frame sprite now requests the whole animation, which costs one burst of
requests per clip.

This also made two bugs look like other bugs: a freshly opened screen renders
black for a frame or two, which is easy to mistake for something not drawing at
all. Two of the hunts in this file started that way.

## Netplay

Lockstep. Both peers run the same simulation on the same inputs and never
exchange state -- only the **three bits** each player presses, about 10 bytes a
second. `engine/src/net/session.ts` is the whole of it.

Three measurements decided the design:

| | |
|---|---|
| Replay speed | **600-1600x realtime** -- 3 minutes of play re-simulates in ~200 ms |
| `hashLevel` | **8.1 us**, so peers can compare digests every few frames for nothing |
| Determinism over a level | 7800 frames x 5 levels, replayed twice, identical |

Because the simulation is a pure function of `(mode, level, input log)` and
replays that fast, **nothing here serialises the physics world**. A peer that
falls out of step rebuilds the level and replays the log. The same path is
late join, reconnect and spectating, and none of it needs a Box2D serialiser.

Four things that are less obvious than they look:

- **Input runs ahead.** A peer decides its input for frame `F + 3` and sends it
  at frame `F`, so it lands before it is due. The cost is a constant ~115 ms
  between key and character; the benefit is that neither peer waits.
- **A frame's input is decided once.** Even if the session then stalls for a
  second, the peer has already been told what frame `F + 3` holds; revising it
  would mean the two simulations disagree.
- **Every packet repeats the last 16 frames.** 48 bits of redundancy removes
  acknowledgement, retransmission and ordering from the protocol entirely. At
  25% packet loss the sessions still never desync.
- **Pause, retry and quit ride the same channel as input**, taking effect on an
  agreed frame. Applying one locally the moment the key is pressed is the
  easiest way to desync this game, and it is the one place local UI touches
  shared state.

Solo play runs through the same session with a `NullTransport`, so there is one
stepping path rather than two, and a netcode bug shows up in single-player too.

### Transports

Everything above the transport is one code path; the `Transport` interface is
one method each way.

| | |
|---|---|
| `BroadcastTransport` | two tabs of one browser, no server at all. What `twotabs` drives |
| `connectWebRTC` | an RTCDataChannel, **unreliable and unordered** |
| the rendezvous channel | the fallback, when a peer connection cannot be had |

The data channel is unreliable on purpose. Retransmission is the wrong tool
when every packet already repeats the last 16 frames: SCTP would hold newer
input behind older input that no longer matters, and head-of-line blocking is
exactly what a lockstep session cannot afford.

**There is no TURN server, and no cost.** `connect()` tries a direct connection
and otherwise keeps using the channel the peers already found each other on --
which carries ten bytes a second perfectly well, for a hop of extra latency.
The 10-20% of pairs behind a strict NAT still play. What they do not get is cam
and mic, which need the direct connection; that is the honest price of not
renting a relay, and adding TURN later changes nothing above `connect()`.

Signalling rides that same rendezvous channel under its own leading byte, so a
session needs exactly one place to meet and no dedicated signalling server.

The engine deliberately does **not** depend on Supabase. `connect()` takes the
rendezvous as a `Transport`, so the Realtime implementation lives with the app
and is handed in.

One thing the tests pinned down that is easy to misread as a bug: **lockstep
peers are not instantaneously on the same frame.** One may run up to `delay + 1`
frames ahead, because it already holds input for frames the other has not
consumed. They converge whenever the leader has to wait. Comparing digests is
only meaningful once both are on the same frame.

## Not done yet

- a Supabase Realtime `Transport`, so two people rather than two tabs can find
  each other. Everything it plugs into is done and tested
- Supabase: accounts, friends, presence, pair progress behind `SaveStore`
- cam and mic
