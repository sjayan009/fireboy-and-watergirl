# Recovered level format

Extracted from the original `Fireboy & Watergirl - The Forest Temple.swf`
(not distributed in this repository) by `tools/extract_levels.py`. Source of truth is ABC method **782**, which is
`level.<constructor>` — a 72.5 KB method that is 28% of the game's entire
bytecode, almost all of it level literals.

## Where it came from

The constructor is one long guard chain over its two parameters,
`level(CurrentMode:String, CurrentLevel:Number)`:

```as3
if (CurrentMode == 'puzzle') {
    if (CurrentLevel == 8) {
        LevelArray = new Array(
            new Array(1,1,1, ... 39 values ...),
            new Array(1,0,-4, ...),
            ...29 rows...
        );
        ...
        CreateGround(LevelArray);
        CreateFinish(x, y);
        CreateLever(...); CreatePusher(...); ...
    }
}
```

Rows are built with `constructprop Array (39 args)`, values pushed as
`pushbyte` (sign-extended, so 252..255 read as -4..-1) and repeated with `dup`.
Diamonds are referenced through locals the constructor assigns near the top:
local 6 = `'bd'`, local 7 = `'rd'`, local 8 = `'gr'`.

## Shape

- **33 grids**: `puzzle` 1–9, `speed` 1–6, `adventure` 1–17 (= the 32 advertised
  levels) plus a leftover `test-17` dev level.
- Every grid is exactly **29 rows × 39 columns**.
- Stage is 640×480, so a cell is ~16.4 × ~16.6 px.

## Tile values

| Value | Meaning | Class built by `CreateGround` |
|---|---|---|
| `0` | empty | — |
| `1` | solid ground block | `GroundBox1`–`GroundBox4`, `GroundBoxHalf` |
| `-1` `-2` `-3` `-4` | slope triangles, four orientations | `GroundTri_1` (rotated) |
| `4` | rare variant, only in `adventure-05` — **unconfirmed** | — |
| `5` / `51` `52` | **water** pool body / left+right edge | `WaterBox`, `WaterBoxTri` |
| `6` / `61` `62` | **lava** pool body / left+right edge | `FireBox`, `FireBoxTri` |
| `7` / `71` `72` | green goo pool body / left+right edge | `BlackBox`, `BlackBoxTri` |
| `'rd'` | red diamond (Fireboy) | `RedDiamond` |
| `'bd'` | blue diamond (Watergirl) | `BlueDiamond` |
| `'gr'` | green diamond (shared) | `SilverDiamond` |

Pools read as edge, body, body, body, edge.

Note the ordering: **5 is water and 6 is lava**, not the other way round. It is
easy to get backwards, and getting it backwards inverts which character a pool
kills. Confirmed against `CreateGround`, which builds `WaterBox` with userData
`"water"` for 5/51/52 and `FireBox` with userData `"fire"` for 6/61/62, and
against the running engine: walking both characters into the tile-6 pool in
`adventure-01` kills Watergirl.

Mode/collectible split is self-consistent and matches how the game plays:
`puzzle` levels contain **only** `gr`; `adventure` and `speed` contain **only**
`rd` + `bd`.

## Verification

The grids were extracted twice, by two independent paths:

1. `tools/extract_levels.py` — walks raw AVM2 bytecode in method 782, running a
   stack machine over `pushbyte`/`dup`/`constructprop Array`.
2. `tools/parse_source_levels.py` — walks the JPEXS-decompiled `level.as`.

**All 32 real levels came out byte-identical.** The bytecode path additionally
recovers `test-17`, a leftover dev level the source scanner skips; the entity
counts differ by exactly that level's contents (one finish, one ball, one
roman), which reconciles the two totals completely.

## Entity placements

`extracted/entities/<mode>-<NN>.json` holds what the grid does not: spawn points
and mechanisms. 316 placements across the 32 levels, plus 32 spawn pairs.

```json
{
 "spawns": {"StartPosFire": {"x": 2, "y": 27},
            "StartPosWater": {"x": 2, "y": 23}},
 "entities": [
  {"type": "CreateFinish", "args": [{"x":32,"y":4.5}, {"x":35,"y":4.5}]},
  {"type": "CreateLever",  "args": [{"x":10,"y":19}, 6, "l", "r", true]},
  {"type": "CreateMovingBox", "args": [{"x":20,"y":8}, {"x":0.95,"y":0.95}]}
 ]
}
```

Coordinates are in **grid units**, matching the 39 x 29 tile space (so y=27 is
near the floor), not pixels. `CreateFinish` gives both exit doors — Fireboy's
first, then Watergirl's.

| Call | Count | Shape of args |
|---|---|---|
| `CreateSlidePlatform` | 86 | pos, halfW, halfH, axis, limit, ?, ?, trigger kind, trigger id |
| `CreateLever` | 61 | pos, id, dir A, dir B, flag |
| `CreatePusher` | 59 | pos, id, ?, flag |
| `CreateFinish` | 32 | fire door pos, water door pos |
| `CreateWind` | 24 | 6 args |
| `CreateMovingBox` | 13 | pos, half-extents |
| `CreateBall` / `CreateRotPlatform` | 12 each | — |
| `CreateHangingPlatform` | 8 | 4 args |
| `CreatePulley` | 6 | 6 args |
| `CreatRoman` | 3 | 4 args |

Levers and pushers are wired to platforms by the trailing `"lever"`/`"pusher"`
string plus a numeric id. Argument slots marked `?` still need confirming
against each `Create*` method body.

`CreateJumper` exists on the class but is never called — dead code.

## Assets

`extracted/assets/` — 460 shapes as SVG, 20 images as PNG, 28 sounds. Sounds
keep their class names (`904_Jump1_Sound.mp3`, `911_Diamond_Sound.mp3`).
`Door_Sound` and `Wind_Sound` exported as `.flv` because of their original
codec and will need transcoding for the web.

## Physics constants (from the same constructor)

```
m_iterations = 50
m_timeStep   = 1/26     // note: NOT 1/25, despite the 25 fps stage
world_aa     = 100
world_bb     = 100
m_physScale  = 1
```

Input state is six booleans — `l_pressed`, `r_pressed`, `u_pressed` and the
`*_pressed2` set — i.e. **3 bits per player**, which is the whole payload the
netcode has to ship per frame.
