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
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fbwg_env import (  # noqa: E402
    CHANNELS, COLS, DYN_BLUE, DYN_GREEN, DYN_MOVING, DYN_RED, FIRE_HAZARDS,
    ROWS, SCHEMA_VERSION, SERVER, STATE_FIELDS, STATE_FLOATS, WATER_HAZARDS,
    EnvClient, LevelInfo, State, bfs_field, encode,
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
    vec = np.arange(STATE_FLOATS, dtype=np.float32)
    return LevelInfo(grid, (20, 3), (20, 30)), State(vec, 0, dyn)


@check("encode: shapes, dtypes, one-hot")
def _():
    info, st = fake_level()
    bf = np.full((ROWS, COLS), .5, np.float32)
    bw = np.full((ROWS, COLS), .25, np.float32)
    obs = encode(info, st, bf, bw)
    assert isinstance(SCHEMA_VERSION, int)
    t, b, v = obs["tiles"], obs["bfs"], obs["vec"]
    assert t.shape == (len(CHANNELS), ROWS, COLS) and t.dtype == np.float32, (t.shape, t.dtype)
    assert b.shape == (2, ROWS, COLS) and b.dtype == np.float32, (b.shape, b.dtype)
    assert np.all(b[0] == .5) and np.all(b[1] == .25), "bfs must be fire then water"
    assert v.dtype == np.float32 and v.ndim == 1 and np.all(np.isfinite(v)), (v.dtype, v.shape)
    assert set(np.unique(t)) <= {0.0, 1.0}, "tiles must be 0 or 1"


@check("encode: every channel in the right place")
def _():
    info, st = fake_level()
    t = encode(info, st, np.zeros((ROWS, COLS), np.float32),
               np.zeros((ROWS, COLS), np.float32))["tiles"]
    ch = {name: t[i] for i, name in enumerate(CHANNELS)}
    want = {
        "solid": [(0, c) for c in range(COLS)],
        "slope1": [(5, 2)], "slope2": [(5, 3)], "slope3": [(5, 4)], "slope4": [(5, 5)],
        "water": [(5, 6), (5, 7), (5, 8)],
        "lava": [(5, 9), (5, 10), (5, 11)],
        "goo": [(5, 12), (5, 13), (5, 14)],
        "red_diamond": [(10, 3), (12, 9)], "blue_diamond": [(10, 4)],
        "green_diamond": [(10, 5)],
        "fire_door": [(20, 3)], "water_door": [(20, 30)],
        "moving": [(12, 6), (12, 7), (12, 8), (12, 9)],
    }
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
        f = bfs_field(info.grid, info.fire_door, FIRE_HAZARDS)
        cell = (round(float(st.vec[F["fire_y"]])), round(float(st.vec[F["fire_x"]])))
        assert f[info.fire_door] == 0 and f[cell] < 1, "Fireboy's spawn cannot reach his door"
    finally:
        c.close()


@server_check("server: the dyn grid puts each diamond on exactly its own cell")
def _():
    c = EnvClient(1)
    try:
        for mode, num in [("adventure", 1), ("puzzle", 3), ("speed", 2)]:
            dyn = c.reset(0, mode, num).dyn
            grid = json.loads((LEVEL_DIR / f"{mode}-{num:02d}.json").read_text())["grid"]
            for code, bit in [("rd", DYN_RED), ("bd", DYN_BLUE), ("gr", DYN_GREEN)]:
                want = sorted((r, col) for r, row in enumerate(grid)
                              for col, v in enumerate(row) if v == code)
                got = sorted((int(r), int(col)) for r, col in np.argwhere(dyn & bit))
                assert got == want, f"{mode} {num} {code}: got {got[:6]}, want {want[:6]}"
    finally:
        c.close()


@server_check("invariant: same actions, same digests")
def _():
    c = EnvClient(1)
    try:
        bits = rand_bits(1, 200)
        runs = []
        for _ in range(2):
            c.reset(0, "adventure", 1)
            runs.append([s[0].hash for s in run(c, [bits])])
        assert len(set(runs[0])) > 10, "the hash barely changes; is it really hashLevel?"
        assert runs[0] == runs[1], "two runs of the same inputs diverged"
    finally:
        c.close()


@server_check("invariant: a restore equals a rebuild")
def _():
    bits = rand_bits(2, 60)
    a, b = EnvClient(1), EnvClient(1)
    try:
        a.reset(0, "puzzle", 3)
        run(a, [rand_bits(3, 100)])          # play, then restore
        ha = [a.reset(0, "puzzle", 3).hash] + [s[0].hash for s in run(a, [bits])]
        hb = [b.reset(0, "puzzle", 3).hash] + [s[0].hash for s in run(b, [bits])]
        assert ha == hb, f"diverged at step {next(i for i in range(len(ha)) if ha[i] != hb[i])}"
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
        ha = [a.reset(0, "adventure", 1).hash] + [s[0].hash for s in run(a, [bits])]
        hb = [b.reset(0, "adventure", 1).hash] + [s[0].hash for s in run(b, [bits])]
        assert ha == hb, "restoring a level after playing another one diverged"
    finally:
        a.close()
        b.close()


@server_check("invariant: the observation survives a snapshot round-trip")
def _():
    c = EnvClient(1)
    try:
        st1 = c.reset(0, "adventure", 3)
        info = c.info(0)
        bf = bfs_field(info.grid, info.fire_door, FIRE_HAZARDS)
        bw = bfs_field(info.grid, info.water_door, WATER_HAZARDS)
        o1 = encode(info, st1, bf, bw)
        run(c, [rand_bits(4, 150)])
        o2 = encode(info, c.reset(0, "adventure", 3), bf, bw)
        for k in o1:
            assert np.array_equal(o1[k], o2[k]), f"{k} differs after restore"
    finally:
        c.close()


@server_check("invariant: the input delay is exactly 4 frames, and reset clears it")
def _():
    c = EnvClient(2)
    try:
        c.reset(0, "adventure", 1)
        c.reset(1, "adventure", 1)
        run(c, [[0] * 20, [0] * 20])
        steps = run(c, [[RIGHT_FIRE] * 8, [0] * 8])
        moved = [s[0].vec[F["fire_x"]] != s[1].vec[F["fire_x"]] for s in steps]
        assert moved == [False] * 4 + [True] * 4, f"first moved at step {moved.index(True) if True in moved else None}, want 4"
        run(c, [[RIGHT_FIRE] * 3, [0] * 3])   # presses still in the queue...
        c.reset(0, "adventure", 1)
        c.reset(1, "adventure", 1)
        steps = run(c, [[0] * 6, [0] * 6])    # ...must not leak past the reset
        assert all(s[0].vec[F["fire_x"]] == s[1].vec[F["fire_x"]] for s in steps), \
            "presses from before the reset still came out"
    finally:
        c.close()


@server_check("invariant: repeat=3 is three repeat=1 steps")
def _():
    bits = rand_bits(5, 30)
    a, b = EnvClient(1), EnvClient(1)
    try:
        a.reset(0, "speed", 2)
        b.reset(0, "speed", 2)
        ha = [s[0].hash for s in run(a, [bits], repeat=3)]
        hb = [s[0].hash for s in run(b, [[x for x in bits for _ in range(3)]])][2::3]
        assert ha == hb, "action repeat does not match repeated single steps"
    finally:
        a.close()
        b.close()


@server_check("invariant: envs in one process do not share a clock")
def _():
    levels = [("adventure", 1), ("puzzle", 3)]
    bits = [rand_bits(6, 120), rand_bits(7, 120)]
    together = EnvClient(2)
    solo = [EnvClient(1), EnvClient(1)]
    try:
        start = [together.reset(i, *lv).vec[F["clock"]] for i, lv in enumerate(levels)]
        both = run(together, bits)
        for i, lv in enumerate(levels):
            solo[i].reset(0, *lv)
            alone = run(solo[i], [bits[i]])
            assert [s[i].hash for s in both] == [s[0].hash for s in alone], \
                f"env {i} diverged when run beside another env"
            assert both[-1][i].vec[F["clock"]] == start[i] + 120, \
                f"env {i} clock is {both[-1][i].vec[F['clock']]}, want {start[i] + 120}"
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
                c.reset(i, *level[i])
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
                    won = v[F["finish1"]] > 0 and v[F["finish2"]] > 0
                    if dead or won or age[i] >= limit:
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
