"""Checks for the env server, the BFS fields and the encoder.

    npm --prefix engine run build
    python bot/check_env.py                 # quick
    python bot/check_env.py --episodes 1000 # the Stage 1 milestone

Each check prints PASS, FAIL (with why) or TODO (still NotImplementedError).
The exit code is 0 only when everything passes. BFS and encode are checked on
hand-made grids, so you can finish them before the server works.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fbwg_env  # noqa: E402
from fbwg_env import (  # noqa: E402
    CHANNELS, COLS, DYN_BLUE, FIREBOY, WATERGIRL, DYN_GREEN, DYN_MOVING, DYN_RED, DYN_WIND_LEFT,
    DYN_WIND_UP, FIRE_HAZARDS, LEVER_SLOTS, MEDAL_SECONDS, PUSHER_SLOTS,
    ROWS, SCHEMA_VERSION, SERVER, STATE_FIELDS, STATE_FLOATS, TIME_SCALE, TIME_TABLE, VEL_SCALE,
    TRANSLATION, WATER_HAZARDS, EnvClient, LevelInfo, State, bfs_field, cell, encode, prepare,
)

LEVEL_DIR = SERVER.parents[3] / "extracted" / "levels"
LEVELS = sorted(
    (p.stem.rsplit("-", 1)[0], int(p.stem.rsplit("-", 1)[1]))
    for p in LEVEL_DIR.glob("*.json")
    if not p.stem.startswith("test")
)
F = {name: i for i, name in enumerate(STATE_FIELDS)}
RIGHT_FIRE = 2

results: list[str] = []


def check(name):
    def run(fn):
        try:
            fn()
            results.append("PASS")
            print(f"PASS  {name}")
        except NotImplementedError as e:
            results.append("TODO")
            print(f"TODO  {name}  ({e} not written yet)")
        except Exception as e:  # noqa: BLE001 - any failure is a FAIL
            results.append("FAIL")
            print(f"FAIL  {name}  {type(e).__name__}: {e}")
        return fn
    return run


def rand_bits(seed: int, n: int) -> list[int]:
    rng = random.Random(seed)
    return [rng.randrange(64) for _ in range(n)]


# ---- BFS, on hand-made grids ---------------------------------------------

G = np.array([
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 5, 1],
    [1, 0, 0, 0, 1, 0, 1],
    [1, 1, 1, 1, 1, 1, 1],
], dtype=np.int8)


@check("bfs: distances, hazards, unreachable cells")
def _():
    fire = bfs_field(G, (1, 1), FIRE_HAZARDS)
    water = bfs_field(G, (1, 1), WATER_HAZARDS)
    assert fire.dtype == np.float32 and fire.shape == G.shape, (fire.dtype, fire.shape)
    # Fireboy cannot enter the water at (2,5), so (3,5) is cut off. Max is 4,
    # so reachable cells are d/5 and only cut-off or solid cells reach 1.
    want_fire = {(1, 1): 0, (1, 2): .2, (1, 3): .4, (1, 5): .8, (3, 3): .8,
                 (2, 5): 1, (3, 5): 1, (0, 0): 1, (2, 2): 1}
    # Watergirl walks through water: (2,5) is 5 steps, (3,5) is 6. Max is 6.
    want_water = {(1, 1): 0, (1, 3): 2 / 7, (2, 5): 5 / 7, (3, 5): 6 / 7, (3, 3): 4 / 7}
    for (cell, want), got in [((c, w), fire) for c, w in want_fire.items()] + \
                             [((c, w), water) for c, w in want_water.items()]:
        assert abs(got[cell] - want) < 1e-6, f"cell {cell}: got {got[cell]:.4f}, want {want:.4f}"


@check("bfs: walls block like solid")
def _():
    walls = np.zeros(G.shape, bool)
    walls[1, 3] = True
    # The top corridor is cut at (1,3), so (1,4) and (1,5) are only reachable
    # through the water at (2,5), which Fireboy cannot enter.
    got = bfs_field(G, (1, 1), FIRE_HAZARDS, walls=walls)
    assert got[1, 3] == 1 and got[1, 4] == 1 and got[1, 5] == 1, got[1]
    assert got[3, 3] < 1, "the lower corridor is still open"


@check("bfs: no wrap-around at the edges")
def _():
    got = bfs_field(np.zeros((1, 5), np.int8), (0, 0), FIRE_HAZARDS)
    assert np.allclose(got, [[0, .2, .4, .6, .8]]), f"got {got}  (np.roll wraps; use slices)"


# ---- encode, on a fake level ---------------------------------------------

def fake_level() -> tuple[LevelInfo, State]:
    grid = np.zeros((ROWS, COLS), np.int8)
    grid[0, :] = 1
    for i, code in enumerate((-1, -2, -3, -4, 5, 51, 52, 6, 61, 62, 7, 71, 72)):
        grid[5, 2 + i] = code
    dyn = np.zeros((ROWS, COLS), np.uint8)
    dyn[10, 3] = DYN_RED
    dyn[10, 4] = DYN_BLUE
    dyn[10, 5] = DYN_GREEN
    dyn[12, 6:9] = DYN_MOVING
    dyn[12, 9] = DYN_MOVING | DYN_RED
    dyn[15, 1:3] = DYN_WIND_UP
    dyn[16, 1] = DYN_WIND_UP | DYN_WIND_LEFT
    vec = np.arange(STATE_FLOATS, dtype=np.float32)
    obstacles = np.zeros((ROWS, COLS), bool)
    obstacles[7, 10] = True
    return LevelInfo(grid, (20, 3), (20, 30), obstacles), State(vec, 0, dyn)


@check("encode: shapes, dtypes, one-hot")
def _():
    info, st = fake_level()
    bf = np.full((ROWS, COLS), .5, np.float32)
    bw = np.full((ROWS, COLS), .25, np.float32)
    lvl = prepare(info, bf, bw)
    obs = encode(lvl, st, WATERGIRL)
    assert isinstance(SCHEMA_VERSION, int)
    t, b, v = obs["tiles"], obs["bfs"], obs["vec"]
    assert t.shape == (len(CHANNELS), ROWS, COLS) and t.dtype == np.float32, (t.shape, t.dtype)
    assert b.shape == (2, ROWS, COLS) and b.dtype == np.float32, (b.shape, b.dtype)
    assert np.all(b[0] == .5) and np.all(b[1] == .25), "bfs must be fire then water"
    assert v.dtype == np.float32 and v.ndim == 1 and np.all(np.isfinite(v)), (v.dtype, v.shape)
    assert set(np.unique(t)) <= {0.0, 1.0}, "tiles must be 0 or 1"
    tc = st.vec[F["timecount"]]
    assert v.shape == (STATE_FLOATS + 3,), v.shape
    assert np.isclose(v[F["timecount"]], tc / TIME_SCALE), "timecount not scaled by TIME_SCALE"
    assert np.allclose(v[-3:-1], [np.sin((tc + 1) / 10), np.cos((tc + 1) / 10)]), \
        "fan phase is not sin, cos of (timecount + 1) / 10"
    assert v[-1] == WATERGIRL and encode(lvl, st, FIREBOY)["vec"][-1] == FIREBOY, \
        "side is not the last float"
    for bad in (2, -1):
        try:
            encode(lvl, st, bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"side {bad} was accepted")
    for k in ("fire_left", "water_up"):
        assert v[F[k]] == st.vec[F[k]], f"{k} is changed by encode"
    # Local Play has no time limit: ten minutes reads the same as 150 s.
    late = State(st.vec.copy(), 0, st.dyn)
    late.vec[F["timecount"]] = 26 * 600
    assert encode(lvl, late, FIREBOY)["vec"][F["timecount"]] == 1, "timecount is not clipped at 1"
    # The per-level parts are shared, never written: bfs is the one read-only
    # array, and tiles is a copy, so a state's diamonds do not stay behind.
    assert obs["bfs"] is lvl.bfs and not lvl.bfs.flags.writeable, "bfs is not the level's read-only stack"
    empty = State(st.vec, 0, np.zeros_like(st.dyn))
    assert encode(lvl, empty, FIREBOY)["tiles"][CHANNELS.index("red_diamond")].sum() == 0, \
        "an earlier state's diamonds leaked into the level's static planes"
    for name, scale in (("fire_x", COLS), ("water_y", ROWS), ("mover0_x", COLS), ("mover23_y", ROWS),
                        ("fan0_x0", COLS), ("fan5_y1", ROWS), ("fire_vy", VEL_SCALE),
                        ("mover7_vx", VEL_SCALE), ("mover7_spin", fbwg_env.SPIN_SCALE),
                        ("red_count", fbwg_env.COUNT_SCALE), ("fan2_dx", 1), ("fan2_on", 1)):
        assert np.isclose(v[F[name]], st.vec[F[name]] / scale), f"{name} not divided by {scale}"
    for i in (0, 23):
        a, want = v[F[f"mover{i}_angle"]], st.vec[F[f"mover{i}_angle"]]
        assert -1 <= a < 1 and np.isclose(np.cos(a * np.pi), np.cos(want), atol=1e-4), \
            f"mover{i}_angle {want} encoded as {a}"


@check("encode: every channel in the right place")
def _():
    info, st = fake_level()
    t = encode(prepare(info, np.zeros((ROWS, COLS), np.float32), np.zeros((ROWS, COLS), np.float32)),
               st, FIREBOY)["tiles"]
    ch = {name: t[i] for i, name in enumerate(CHANNELS)}
    want = {
        "solid": [(0, c) for c in range(COLS)] + [(7, 10)],
        "slope1": [(5, 2)], "slope2": [(5, 3)], "slope3": [(5, 4)], "slope4": [(5, 5)],
        "water": [(5, 6), (5, 7), (5, 8)],
        "lava": [(5, 9), (5, 10), (5, 11)],
        "goo": [(5, 12), (5, 13), (5, 14)],
        "red_diamond": [(10, 3), (12, 9)], "blue_diamond": [(10, 4)],
        "green_diamond": [(10, 5)],
        "fire_door": [(20, 3)], "water_door": [(20, 30)],
        "moving": [(12, 6), (12, 7), (12, 8), (12, 9)],
        "wind_up": [(15, 1), (15, 2), (16, 1)], "wind_right": [],
        "wind_down": [], "wind_left": [(16, 1)],
    }
    assert sorted(want) == sorted(CHANNELS), "the test does not cover every channel"
    for name, cells in want.items():
        got = sorted(zip(*np.nonzero(ch[name])))
        got = [(int(r), int(c)) for r, c in got]
        assert got == sorted(cells), f"{name}: got {got[:6]}, want {sorted(cells)[:6]}"


# ---- the server ----------------------------------------------------------

def server_check(name):
    def wrap(fn):
        if not SERVER.exists():
            def missing():
                raise NotImplementedError(f"{SERVER.name} (run npm --prefix engine run build)")
            return check(name)(missing)
        return check(name)(fn)
    return wrap


def run(client: EnvClient, env_bits: list[list[int]], repeat: int = 1) -> list[list[State]]:
    """Step every env through its own bit list; returns states per step."""
    return [client.step([bits[k] for bits in env_bits], repeat) for k in range(len(env_bits[0]))]


def first_difference(a: list[State], b: list[State]) -> int | None:
    """The first step where two runs differ in hash, any STATE float or the
    dyn grid, or None. Not the hash alone: hashLevel leaves out timecount, the
    jump latches, levers, buttons, fans and the ending counters."""
    assert len(a) == len(b), (len(a), len(b))
    return next((i for i, (x, y) in enumerate(zip(a, b))
                 if x.hash != y.hash or not np.array_equal(x.vec, y.vec)
                 or not np.array_equal(x.dyn, y.dyn)), None)


@server_check("STATE_FIELDS, the hazard sets and the constants are envstate.ts's")
def _():
    url = (SERVER.parent / "envstate.js").as_uri()
    js = f"const m = await import({json.dumps(url)}); console.log(JSON.stringify(m));"
    out = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr.strip()[-600:]
    ts = json.loads(out.stdout)
    names = tuple(ts["STATE_NAMES"])
    assert names == STATE_FIELDS, \
        f"first difference at {next((i for i, (a, b) in enumerate(zip(names, STATE_FIELDS)) if a != b), min(len(names), len(STATE_FIELDS)))}"
    assert len(names) == STATE_FLOATS
    # Every number envstate.ts exports by a name fbwg_env.py also uses.
    shared = [k for k, v in ts.items() if isinstance(v, int) and hasattr(fbwg_env, k)]
    assert len(shared) >= 13, shared
    for k in shared:
        assert getattr(fbwg_env, k) == ts[k], f"{k}: Python {getattr(fbwg_env, k)}, envstate.ts {ts[k]}"
    for k in ("FIRE_HAZARDS", "WATER_HAZARDS"):
        assert sorted(getattr(fbwg_env, k)) == sorted(ts[k]), f"{k}: Python {getattr(fbwg_env, k)}, envstate.ts {ts[k]}"
    for kind, codes in ts["POOLS"].items():
        assert tuple(codes) == getattr(fbwg_env, kind.upper()), f"{kind}: envstate.ts {codes}"
    assert tuple(ts["MOVER_FIELDS"]) == fbwg_env.MOVER_FIELDS
    assert tuple(ts["FAN_FIELDS"]) == fbwg_env.FAN_FIELDS


@server_check("handshake: a client of another schema is refused before any reset")
def _():
    c = EnvClient(1)
    assert len(c.engine_version) > 8, c.engine_version
    c.close()
    old = fbwg_env.SCHEMA_VERSION
    fbwg_env.SCHEMA_VERSION = old - 1
    try:
        EnvClient(1).close()
    except RuntimeError as e:
        assert "schema" in str(e), e
    else:
        raise AssertionError("a client of schema %d was accepted" % (old - 1))
    finally:
        fbwg_env.SCHEMA_VERSION = old


@check("grades: MEDAL_SECONDS is game.ts's TimeTable, by the node its level-select button sets")
def _():
    src = (SERVER.parents[2] / "src" / "game" / "game.ts").read_text(encoding="utf-8")
    table = lambda name: re.search(rf"this\.{name} = new Array\(([^)]*)\)", src).group(1)  # noqa: E731
    assert tuple(json.loads(f"[{table('Translation')}]")) == TRANSLATION, "Translation differs"
    assert tuple(json.loads(f"[{table('TimeTable')}]")) == TIME_TABLE, "TimeTable differs"
    # Recuent reads TimeTable[cur_node - 1]; cur_node comes from this switch.
    nodes = dict(re.findall(r'case "(\d_\d+)":\s*this\.cur_node = (\d+);', src))
    assert len(nodes) == 32 and all(int(nodes[n]) == i + 1 for i, n in enumerate(TRANSLATION)), nodes
    assert len(MEDAL_SECONDS) == 23 and MEDAL_SECONDS[("adventure", 13)] == 145, MEDAL_SECONDS
    assert fbwg_env.graded_seconds(1) == 0 and fbwg_env.graded_seconds(27) == 1


@server_check("server: reset and info make sense")
def _():
    c = EnvClient(1)
    try:
        st = c.reset(0, "adventure", 1)
        assert st.vec.shape == (STATE_FLOATS,) and np.all(np.isfinite(st.vec)), st.vec
        assert st.dyn.shape == (ROWS, COLS) and st.dyn.dtype == np.uint8
        assert (st.dyn & (DYN_RED | DYN_BLUE)).any(), "level 1 has diamonds; dyn shows none"
        assert 0 < st.vec[F["fire_x"]] < COLS and 0 < st.vec[F["fire_y"]] < ROWS
        info = c.info(0)
        assert info.grid.shape == (ROWS, COLS) and info.grid.dtype == np.int8
        assert (info.grid[0] == 1).all(), "the top row of every level is solid"
        for door in (info.fire_door, info.water_door):
            assert info.grid[door] != 1, f"door cell {door} is solid"
        f = bfs_field(info.grid, info.fire_door, FIRE_HAZARDS, walls=info.obstacles)
        spawn = cell(st.vec[F["fire_x"]], st.vec[F["fire_y"]])
        assert f[info.fire_door] == 0 and f[spawn] < 1, "Fireboy's spawn cannot reach his door"
    finally:
        c.close()


@server_check("every level: grounded, latch, doors, counts and timecount come through at reset")
def _():
    c = EnvClient(1)
    try:
        for mode, num in LEVELS:
            name = f"{mode} {num}"
            v = c.reset(0, mode, num).vec
            # The one settling frame before the snapshot has already run.
            assert v[F["timecount"]] == 1, f"{name}: timecount {v[F['timecount']]} at reset"
            for k in ("fire_door_open", "water_door_open", "red_count", "blue_count",
                      "green_count", "fire_jump_latched", "water_jump_latched", "won",
                      "fire_left", "fire_right", "fire_up", "water_left", "water_right", "water_up"):
                assert v[F[k]] == 0, f"{name}: {k} is {v[F[k]]} at reset"
            v = run(c, [[0] * 30])[-1][0].vec
            assert v[F["fire_grounded"]] == 1 and v[F["water_grounded"]] == 1, \
                f"{name}: not grounded after settling ({v[F['fire_grounded']]}, {v[F['water_grounded']]})"
            assert v[F["timecount"]] == 31, f"{name}: timecount {v[F['timecount']]} after 30 frames"
    finally:
        c.close()


@server_check("engine: hazards, deaths, jumps, doors, won, diamonds, fans, levers, buttons, movers on every level")
def _():
    out = subprocess.run(["node", str(SERVER.parent / "envfacts.js")],
                         capture_output=True, text=True)
    assert out.returncode == 0, (out.stdout + out.stderr).strip()[-600:]


@server_check("live: the env is the whole game, before and after a restore, and grades as it does")
def _():
    out = subprocess.run(["node", str(SERVER.parent / "envlive.js")],
                         capture_output=True, text=True)
    assert out.returncode == 0, (out.stdout + out.stderr).strip()[-600:]


@server_check("every level: grid, diamonds, doors, spawns, levers, buttons, restore")
def _():
    levers = [F[f"lever{i}"] for i in range(LEVER_SLOTS)]
    pushers = [F[f"pusher{i}"] for i in range(PUSHER_SLOTS)]
    unreached = []
    c = EnvClient(1)
    try:
        for mode, num in LEVELS:
            name = f"{mode} {num}"
            st = c.reset(0, mode, num)
            info = c.info(0)
            raw = json.loads((LEVEL_DIR / f"{mode}-{num:02d}.json").read_text())["grid"]
            want = np.array([[v if isinstance(v, int) else 0 for v in row] for row in raw], np.int8)
            assert np.array_equal(info.grid, want), f"{name}: grid differs from the level file"

            for code, bit in [("rd", DYN_RED), ("bd", DYN_BLUE), ("gr", DYN_GREEN)]:
                want_cells = sorted((r, col) for r, row in enumerate(raw)
                                    for col, v in enumerate(row) if v == code)
                got = sorted((int(r), int(col)) for r, col in np.argwhere(st.dyn & bit))
                assert got == want_cells, f"{name} {code}: got {got[:6]}, want {want_cells[:6]}"

            blocked = {1} | set(FIRE_HAZARDS) | set(WATER_HAZARDS)
            for who, door in (("fire", info.fire_door), ("water", info.water_door)):
                assert info.grid[door] not in blocked, f"{name}: {who} door cell {door} is {info.grid[door]}"
                spawn = cell(st.vec[F[f"{who}_x"]], st.vec[F[f"{who}_y"]])
                assert info.grid[spawn] != 1, f"{name}: {who} spawns inside a wall at {spawn}"
                hazards = FIRE_HAZARDS if who == "fire" else WATER_HAZARDS
                if bfs_field(info.grid, door, hazards, walls=info.obstacles)[spawn] >= 1:
                    unreached.append(f"{name} {who}")

            v = st.vec
            assert np.all(np.isfinite(v)), f"{name}: {v}"
            assert not np.any(v[pushers] >= 1), f"{name}: a button starts pressed"
            assert not v[F["complete"]] and not v[F["game_over"]] and not v[F["won"]], \
                f"{name}: starts finished"

            # The start must already be settled: an idle frame flips no fan or lever.
            idle = c.step([0], 1)[0]
            assert np.array_equal(idle.dyn & 0xF0, st.dyn & 0xF0), \
                f"{name}: fans change on the first idle frame"
            assert np.array_equal(np.sign(idle.vec[levers]), np.sign(v[levers])), \
                f"{name}: a lever flips on the first idle frame"
            st = c.reset(0, mode, num)

            # Whole states, not just the hash: hashLevel leaves out fans, levers,
            # buttons and the level-complete counter.
            bits = rand_bits(num * 31 + len(mode), 60)
            first = [st] + [s[0] for s in run(c, [bits])]
            again = [c.reset(0, mode, num)] + [s[0] for s in run(c, [bits])]
            for k, (a, b) in enumerate(zip(first, again)):
                assert a.hash == b.hash and np.array_equal(a.vec, b.vec) \
                    and np.array_equal(a.dyn, b.dyn), f"{name}: restore + replay diverged at step {k}"
    finally:
        c.close()
    if unreached:
        # Not a failure: the BFS ignores lifts, fans and levers, so on some
        # levels the spawn is cut off from the door until a mechanism moves.
        print(f"      BFS cannot reach the door without a mechanism: {', '.join(unreached)}")


@server_check("obstacles: only adventure 10 and speed 5, never grid-solid, walls to the BFS")
def _():
    # The seesaw bases (twice in adventure 10, once in speed 5) are the only
    # solid statics outside the tile grid; any other level with obstacles
    # means the body filter caught something it should not.
    c = EnvClient(1)
    try:
        for mode, num in LEVELS:
            name = f"{mode} {num}"
            c.reset(0, mode, num)
            info = c.info(0)
            ob = info.obstacles
            assert ob.shape == (ROWS, COLS) and ob.dtype == bool, (ob.shape, ob.dtype)
            want = (mode, num) in (("adventure", 10), ("speed", 5))
            assert ob.any() == want, f"{name}: {int(ob.sum())} obstacle cells"
            if not want:
                continue
            assert not (info.grid[ob] == 1).any(), f"{name}: an obstacle cell is already grid-solid"
            for door, hazards in ((info.fire_door, FIRE_HAZARDS), (info.water_door, WATER_HAZARDS)):
                f = bfs_field(info.grid, door, hazards, walls=ob)
                assert np.all(f[ob] == 1.0), f"{name}: the BFS walks through an obstacle"
    finally:
        c.close()


@server_check("invariant: with cache 2, ten levels cycled twice still restore exactly")
def _():
    # Every reset in the second pass is a level the cache dropped, so this is
    # the rebuild path, checked whole-state against a client that built each
    # level once.
    levels = LEVELS[::3][:10]
    assert len(levels) == 10, levels
    a, b = EnvClient(1, cache=2), EnvClient(1)
    try:
        for lap in range(2):
            for k, (mode, num) in enumerate(levels):
                bits = rand_bits(100 * lap + k, 30)
                got = [a.reset(0, mode, num)] + [s[0] for s in run(a, [bits])]
                if lap == 0:
                    continue
                want = [b.reset(0, mode, num)] + [s[0] for s in run(b, [bits])]
                for i, (x, y) in enumerate(zip(got, want)):
                    assert x.hash == y.hash and np.array_equal(x.vec, y.vec)                         and np.array_equal(x.dyn, y.dyn), f"{mode} {num}: diverged at step {i}"
    finally:
        a.close()
        b.close()


@server_check("invariant: same actions, same digests")
def _():
    c = EnvClient(1)
    try:
        bits = rand_bits(1, 200)
        runs = []
        for _ in range(2):
            c.reset(0, "adventure", 1)
            runs.append([s[0] for s in run(c, [bits])])
        assert len({s.hash for s in runs[0]}) > 10, "the hash barely changes; is it really hashLevel?"
        k = first_difference(*runs)
        assert k is None, f"two runs of the same inputs diverged at step {k}"
    finally:
        c.close()


@server_check("invariant: a restore equals a rebuild")
def _():
    bits = rand_bits(2, 60)
    a, b = EnvClient(1), EnvClient(1)
    try:
        a.reset(0, "puzzle", 3)
        run(a, [rand_bits(3, 100)])          # play, then restore
        ha = [a.reset(0, "puzzle", 3)] + [s[0] for s in run(a, [bits])]
        hb = [b.reset(0, "puzzle", 3)] + [s[0] for s in run(b, [bits])]
        k = first_difference(ha, hb)
        assert k is None, f"diverged at step {k}"
    finally:
        a.close()
        b.close()


@server_check("invariant: switching levels and coming back restores exactly")
def _():
    bits = rand_bits(9, 40)
    a, b = EnvClient(1), EnvClient(1)
    try:
        a.reset(0, "adventure", 1)
        run(a, [rand_bits(10, 80)])
        a.reset(0, "puzzle", 3)              # a second level in the same env
        run(a, [rand_bits(11, 80)])
        ha = [a.reset(0, "adventure", 1)] + [s[0] for s in run(a, [bits])]
        hb = [b.reset(0, "adventure", 1)] + [s[0] for s in run(b, [bits])]
        k = first_difference(ha, hb)
        assert k is None, f"restoring a level after playing another one diverged at step {k}"
    finally:
        a.close()
        b.close()


@server_check("invariant: the observation survives a snapshot round-trip")
def _():
    c = EnvClient(1)
    try:
        st1 = c.reset(0, "adventure", 3)
        info = c.info(0)
        bf = bfs_field(info.grid, info.fire_door, FIRE_HAZARDS, walls=info.obstacles)
        bw = bfs_field(info.grid, info.water_door, WATER_HAZARDS, walls=info.obstacles)
        lvl = prepare(info, bf, bw)
        o1 = encode(lvl, st1, FIREBOY)
        run(c, [rand_bits(4, 150)])
        o2 = encode(lvl, c.reset(0, "adventure", 3), FIREBOY)
        for k in o1:
            assert np.array_equal(o1[k], o2[k]), f"{k} differs after restore"
    finally:
        c.close()


@server_check("invariant: the input delay is exactly what reset asked for, and reset clears it")
def _():
    c = EnvClient(2)
    try:
        # (delay, delay after the reset): the same, longer, and shorter, so a
        # queue that is emptied but not resized, or resized but not emptied,
        # both show up.
        for delay, after in ((0, 0), (1, 2), (2, 2), (2, 0)):
            c.reset(0, "adventure", 1, delay)
            c.reset(1, "adventure", 1, delay)
            run(c, [[0] * 20, [0] * 20])
            steps = run(c, [[RIGHT_FIRE] * 8, [0] * 8])
            moved = [s[0].vec[F["fire_x"]] != s[1].vec[F["fire_x"]] for s in steps]
            assert moved == [False] * delay + [True] * (8 - delay), \
                f"delay {delay}: first moved at step {moved.index(True) if True in moved else None}"
            run(c, [[RIGHT_FIRE] * 3, [0] * 3])   # presses still in the queue...
            c.reset(0, "adventure", 1, after)
            c.reset(1, "adventure", 1, after)
            steps = run(c, [[0] * 6, [0] * 6])    # ...must not leak past the reset
            assert all(s[0].vec[F["fire_x"]] == s[1].vec[F["fire_x"]] for s in steps), \
                f"delay {delay} then {after}: presses from before the reset still came out"
    finally:
        c.close()


@server_check("reset: the partner's first-frame keys count, the bot's are dropped")
def _():
    c = EnvClient(1)
    try:
        idle = c.reset(0, "adventure", 1)
        with_bad = False
        try:
            c.reset(0, "adventure", 1, first=64)
        except ValueError:
            with_bad = True
        assert with_bad, "first=64 was accepted"
        # Fireboy right (2) and Watergirl left (8) in the first frame.
        as_water = c.reset(0, "adventure", 1, side=WATERGIRL, first=2 | 8).vec
        assert as_water[F["fire_right"]] == 1 and as_water[F["water_left"]] == 0, "the keys fields after reset"
        assert as_water[F["fire_x"]] > idle.vec[F["fire_x"]], "the partner's first-frame Right did not move Fireboy"
        assert as_water[F["water_x"]] == idle.vec[F["water_x"]], "the bot's first-frame key was not dropped"
        as_fire = c.reset(0, "adventure", 1, side=FIREBOY, first=2 | 8).vec
        assert as_fire[F["water_left"]] == 1 and as_fire[F["fire_right"]] == 0, "the keys fields after reset"
        assert as_fire[F["fire_x"]] == idle.vec[F["fire_x"]], "the bot's first-frame key was not dropped"
        assert as_fire[F["water_x"]] < idle.vec[F["water_x"]], "the partner's first-frame Left did not move Watergirl"
        again = c.reset(0, "adventure", 1)
        assert again.hash == idle.hash and np.array_equal(again.vec, idle.vec), \
            "a reset after first keys is not the plain reset"
    finally:
        c.close()


@server_check("invariant: only the bot's side waits out the delay, and the key fields show what ran")
def _():
    c = EnvClient(1)
    fire = ("fire_left", "fire_right", "fire_up")
    water = ("water_left", "water_right", "water_up")
    held = {"fire_right": 1, "water_left": 1}   # bits 2 | 8, held every step
    try:
        try:
            c.reset(0, "adventure", 1, 0, 2)
        except ValueError:
            pass
        else:
            raise AssertionError("side 2 was accepted")
        for side, delay in ((FIREBOY, 0), (FIREBOY, 2), (WATERGIRL, 2), (WATERGIRL, 3)):
            c.reset(0, "adventure", 1, delay, side)
            mine, theirs = (fire, water) if side == FIREBOY else (water, fire)
            for k, st in enumerate(run(c, [[2 | 8] * 6])):
                v = st[0].vec
                for n in mine:
                    want = held.get(n, 0) if k >= delay else 0
                    assert v[F[n]] == want, f"side {side} delay {delay} step {k}: bot key {n} reads {v[F[n]]}"
                for n in theirs:
                    assert v[F[n]] == held.get(n, 0), \
                        f"side {side} delay {delay} step {k}: partner key {n} reads {v[F[n]]}"
    finally:
        c.close()


@server_check("invariant: every jump follows a state that said Up would jump")
def _():
    # The game jumps by setting vy to -13.5 (game.ts Update), so vy dropping
    # past -12, by more than 3 within one frame, is a jump; a fan lifts about
    # 1 a frame and crosses -12 gradually. A jump must only ever happen when
    # the state before it read grounded, not latched, and that frame pressed Up.
    up = {"fire": 4, "water": 32}
    n_envs, frames = 8, 400
    rng = random.Random(12)
    jumps, bad = 0, []
    c = EnvClient(n_envs)
    try:
        for first in range(0, len(LEVELS), n_envs):
            levels = [LEVELS[(first + i) % len(LEVELS)] for i in range(n_envs)]
            prev = [c.reset(i, *lv) for i, lv in enumerate(levels)]
            held = [(0, 0)] * n_envs   # (bits, frames left)
            for _ in range(frames):
                held = [h if h[1] else (rng.randrange(64), rng.randint(4, 15)) for h in held]
                bits = [h[0] for h in held]
                held = [(b, n - 1) for b, n in held]
                states = c.step(bits)
                for i, (p, s) in enumerate(zip(prev, states)):
                    for who in ("fire", "water"):
                        vy = F[f"{who}_vy"]
                        if not (p.vec[vy] >= -12 > s.vec[vy] and p.vec[vy] - s.vec[vy] > 3):
                            continue
                        jumps += 1
                        if not (p.vec[F[f"{who}_grounded"]] == 1 and p.vec[F[f"{who}_jump_latched"]] == 0
                                and bits[i] & up[who]):
                            bad.append(f"{levels[i][0]} {levels[i][1]} {who}")
                    if s.vec[F["dead_fire"]] or s.vec[F["dead_water"]] or s.vec[F["won"]]:
                        s = c.reset(i, *levels[i])
                    prev[i] = s
    finally:
        c.close()
    print(f"      {jumps} jumps, {len(bad)} not predicted by the state before")
    assert jumps > 100, f"only {jumps} jumps; the check proves nothing"
    assert not bad, f"{len(bad)} of {jumps} jumps came from a state that could not jump, e.g. {bad[:3]}"


@server_check("invariant: repeat=3 is three repeat=1 steps")
def _():
    bits = rand_bits(5, 30)
    a, b = EnvClient(1), EnvClient(1)
    try:
        a.reset(0, "speed", 2)
        b.reset(0, "speed", 2)
        ha = [s[0] for s in run(a, [bits], repeat=3)]
        hb = [s[0] for s in run(b, [[x for x in bits for _ in range(3)]])][2::3]
        k = first_difference(ha, hb)
        assert k is None, f"action repeat does not match repeated single steps at step {k}"
    finally:
        a.close()
        b.close()


@server_check("invariant: envs in one process stay isolated, and timecount counts their frames")
def _():
    levels = [("adventure", 1), ("puzzle", 3)]
    bits = [rand_bits(6, 120), rand_bits(7, 120)]
    together = EnvClient(2)
    solo = [EnvClient(1), EnvClient(1)]
    try:
        start = [together.reset(i, *lv).vec[F["timecount"]] for i, lv in enumerate(levels)]
        both = run(together, bits)
        for i, lv in enumerate(levels):
            solo[i].reset(0, *lv)
            alone = run(solo[i], [bits[i]])
            k = first_difference([s[i] for s in both], [s[0] for s in alone])
            assert k is None, f"env {i} diverged at step {k} when run beside another env"
            # timecount stops when the level pauses, so the count is only
            # exact if nobody died.
            last = both[-1][i].vec
            assert not (last[F["dead_fire"]] or last[F["dead_water"]]), f"env {i} died; pick other bits"
            assert last[F["timecount"]] == start[i] + 120, \
                f"env {i} timecount is {last[F['timecount']]}, want {start[i] + 120}"
    finally:
        together.close()
        for c in solo:
            c.close()


def random_episodes(n_episodes: int, n_envs: int = 8, limit: int = 3000, repeat: int = 4):
    @server_check(f"milestone: a random agent runs {n_episodes} episodes")
    def _():
        c = EnvClient(n_envs)
        rng = random.Random(8)
        started = done = frames = 0
        level = [None] * n_envs
        age = [0] * n_envs
        t0 = time.perf_counter()
        try:
            def start(i):
                nonlocal started
                level[i] = LEVELS[started % len(LEVELS)]
                c.reset(i, *level[i], side=started % 2)
                age[i] = 0
                started += 1
            for i in range(n_envs):
                start(i)
            while done < n_episodes:
                states = c.step([rng.randrange(64) for _ in range(n_envs)], repeat)
                frames += n_envs * repeat
                for i, s in enumerate(states):
                    assert np.all(np.isfinite(s.vec)), f"{level[i]} produced {s.vec}"
                    age[i] += repeat
                    v = s.vec
                    dead = v[F["dead_fire"]] or v[F["dead_water"]]
                    if dead or v[F["won"]] or age[i] >= limit:
                        done += 1
                        start(i)
        finally:
            c.close()
        dt = time.perf_counter() - t0
        print(f"      {done} episodes, {frames} frames, {frames / dt:,.0f} frames/s")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", type=int, default=64)
    random_episodes(ap.parse_args().episodes)
    passed = results.count("PASS")
    print(f"\n{passed}/{len(results)} passed, {results.count('TODO')} TODO, "
          f"{results.count('FAIL')} failing")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
