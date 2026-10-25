"""The Python side of the training env: a client for the Node env server, the
BFS distance-to-door fields, and the observation encoder.

The wire format is documented at the top of engine/src/bot/envserver.ts; the
constants below must match it. Build the server first:

    npm --prefix engine run build

Then `python bot/check_env.py` runs the invariant tests.
"""
from __future__ import annotations

import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROWS, COLS = 29, 39
DELAY = 4
STATE_FLOATS = 13
STATE_BYTES = STATE_FLOATS * 4 + 4 + ROWS * COLS
OP_RESET, OP_STEP, OP_INFO = 1, 2, 3
DYN_MOVING, DYN_RED, DYN_BLUE, DYN_GREEN = 1, 2, 4, 8

# Order of the floats in a STATE record.
STATE_FIELDS = (
    "fire_x", "fire_y", "fire_vx", "fire_vy",
    "water_x", "water_y", "water_vx", "water_vy",
    "dead_fire", "dead_water", "finish1", "finish2", "clock",
)

# Tile codes in LevelArray.
SOLID = 1
SLOPES = (-1, -2, -3, -4)
WATER = (5, 51, 52)
LAVA = (6, 61, 62)
GOO = (7, 71, 72)
FIRE_HAZARDS = WATER + GOO      # what kills Fireboy
WATER_HAZARDS = LAVA + GOO      # what kills Watergirl

# Bump whenever CHANNELS, the vector, or their meaning changes. Every trained
# model records the version it was trained on.
SCHEMA_VERSION = 1

# Channel order of the tile tensor. encode() must produce exactly these.
CHANNELS = (
    "solid", "slope1", "slope2", "slope3", "slope4",
    "water", "lava", "goo",
    "red_diamond", "blue_diamond", "green_diamond",
    "fire_door", "water_door",
    "moving",
)

SERVER = Path(__file__).resolve().parent.parent / "engine" / "dist" / "bot" / "envserver.js"


@dataclass
class State:
    vec: np.ndarray    # float32, STATE_FLOATS, in STATE_FIELDS order
    hash: int          # hashLevel(lv) as an unsigned 32-bit int
    dyn: np.ndarray    # uint8, (ROWS, COLS), DYN_* bit flags


@dataclass
class LevelInfo:
    grid: np.ndarray            # int8, (ROWS, COLS)
    fire_door: tuple[int, int]  # (row, col)
    water_door: tuple[int, int]


class EnvClient:
    """N envs in one Node process."""

    def __init__(self, n: int, node: str = "node"):
        self.n = n
        self.proc = subprocess.Popen([node, str(SERVER), str(n)],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def _call(self, payload: bytes) -> bytes:
        """Send one framed request, return the reply payload. Done for you."""
        self.proc.stdin.write(struct.pack("<I", len(payload)) + payload)
        self.proc.stdin.flush()
        head = self.proc.stdout.read(4)
        if len(head) < 4:
            raise RuntimeError("env server exited; run it by hand to see its error")
        (length,) = struct.unpack("<I", head)
        return self.proc.stdout.read(length)

    @staticmethod
    def parse_state(buf: bytes, off: int = 0) -> State:
        """One STATE record starting at `off`."""
        vec = np.frombuffer(buf, "<f4", STATE_FLOATS, off).astype(np.float32)
        (h,) = struct.unpack_from("<I", buf, off + STATE_FLOATS * 4)
        dyn = np.frombuffer(buf, np.uint8, ROWS * COLS, off + STATE_FLOATS * 4 + 4)
        return State(vec, h, dyn.reshape(ROWS, COLS).copy())

    def reset(self, env: int, mode: str, num: int) -> State:
        m = mode.encode("ascii")
        reply = self._call(struct.pack("<BHB", OP_RESET, env, len(m)) + m + bytes([num]))
        return self.parse_state(reply)

    def step(self, bits: list[int], repeat: int = 1) -> list[State]:
        """`bits[i]` is env i's 6-bit input: 1/2/4 Fireboy left/right/up,
        8/16/32 Watergirl left/right/up."""
        if len(bits) != self.n:
            raise ValueError(f"{len(bits)} inputs for {self.n} envs")
        reply = self._call(bytes([OP_STEP, repeat]) + bytes(bits))
        return [self.parse_state(reply, i * STATE_BYTES) for i in range(self.n)]

    def info(self, env: int) -> LevelInfo:
        reply = self._call(struct.pack("<BH", OP_INFO, env))
        grid = np.frombuffer(reply, np.int8, ROWS * COLS).reshape(ROWS, COLS).copy()
        fr, fc, wr, wc = reply[ROWS * COLS:ROWS * COLS + 4]
        return LevelInfo(grid, (fr, fc), (wr, wc))

    def close(self) -> None:
        self.proc.stdin.close()
        self.proc.wait()


def bfs_field(grid: np.ndarray, door: tuple[int, int], hazards: tuple[int, ...]) -> np.ndarray:
    """Distance from every cell to `door`, 4-connected, normalised to [0, 1].

    Passable: any cell that is not SOLID and not in `hazards`. The door cell
    is 0. Reachable cells are divided by (largest reachable distance + 1), so
    they stay below 1.0 and unreachable and impassable cells, at exactly 1.0,
    are distinguishable from the farthest reachable one. Returns float32,
    (ROWS, COLS).

    Vectorise it: keep a boolean frontier, grow it by shifting it one cell in
    each direction (slices, not np.roll, which wraps around the edges), and
    stop when it stops growing. No Python loop over cells.
    """
    # ponytail: ignores moving platforms and jump height; it is a shaping
    # potential, not a planner. Rasterise movers in if lever levels need it.
    passable = (grid != SOLID) & ~np.isin(grid, hazards)
    dist = np.full(grid.shape, -1, np.int32)
    dist[door] = 0
    frontier = np.zeros(grid.shape, bool)
    frontier[door] = True
    d = 0
    while frontier.any():
        d += 1
        grown = np.zeros_like(frontier)
        grown[1:] |= frontier[:-1]
        grown[:-1] |= frontier[1:]
        grown[:, 1:] |= frontier[:, :-1]
        grown[:, :-1] |= frontier[:, 1:]
        frontier = grown & passable & (dist < 0)
        dist[frontier] = d
    far = int(dist.max()) + 1
    return np.where(dist >= 0, dist / far, 1.0).astype(np.float32)


def encode(info: LevelInfo, state: State, bfs_fire: np.ndarray,
           bfs_water: np.ndarray) -> dict[str, np.ndarray]:
    """One observation.

    tiles: float32, (len(CHANNELS), ROWS, COLS), one-hot, in CHANNELS order.
           Static channels come from info.grid, diamonds and moving from
           state.dyn, doors are a single 1 at each door cell.
    bfs:   float32, (2, ROWS, COLS): fire then water.
    vec:   float32, 1-D. Start with state.vec; scale positions by COLS/ROWS
           so everything is roughly in [-1, 1].
    """
    g, d = info.grid, state.dyn
    fire_door = np.zeros(g.shape, bool)
    fire_door[info.fire_door] = True
    water_door = np.zeros(g.shape, bool)
    water_door[info.water_door] = True
    planes = {
        "solid": g == SOLID,
        "slope1": g == SLOPES[0], "slope2": g == SLOPES[1],
        "slope3": g == SLOPES[2], "slope4": g == SLOPES[3],
        "water": np.isin(g, WATER), "lava": np.isin(g, LAVA), "goo": np.isin(g, GOO),
        "red_diamond": (d & DYN_RED) > 0, "blue_diamond": (d & DYN_BLUE) > 0,
        "green_diamond": (d & DYN_GREEN) > 0,
        "fire_door": fire_door, "water_door": water_door,
        "moving": (d & DYN_MOVING) > 0,
    }
    vec = state.vec.astype(np.float32)
    for name in ("fire_x", "water_x"):
        vec[STATE_FIELDS.index(name)] /= COLS
    for name in ("fire_y", "water_y"):
        vec[STATE_FIELDS.index(name)] /= ROWS
    # ponytail: the clock is raw frames; divide by the episode limit once one is fixed.
    return {
        "tiles": np.stack([planes[c] for c in CHANNELS]).astype(np.float32),
        "bfs": np.stack([bfs_fire, bfs_water]).astype(np.float32),
        "vec": vec,
    }
