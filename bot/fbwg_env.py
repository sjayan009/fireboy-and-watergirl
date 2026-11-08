"""The Python side of the training env: a client for the Node env server, the
BFS distance-to-door fields, and the observation encoder.

The wire format is documented at the top of engine/src/bot/envserver.ts; the
constants below must match it. Build the server first:

    npm --prefix engine run build

Then `python bot/check_env.py` runs the invariant tests.
"""
from __future__ import annotations

import json
import math
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROWS, COLS = 29, 39
LEVER_SLOTS = PUSHER_SLOTS = 12
MOVER_SLOTS = 24
MOVER_FIELDS = ("x", "y", "angle", "vx", "vy", "spin")
FAN_SLOTS = 6
FAN_FIELDS = ("x0", "y0", "x1", "y1", "dx", "dy", "on")
STATE_FLOATS = (31 + LEVER_SLOTS + PUSHER_SLOTS + MOVER_SLOTS * len(MOVER_FIELDS)
                + FAN_SLOTS * len(FAN_FIELDS))
STATE_BYTES = STATE_FLOATS * 4 + 4 + ROWS * COLS
OP_RESET, OP_STEP, OP_INFO, OP_HELLO = 1, 2, 3, 4
DYN_MOVING, DYN_RED, DYN_BLUE, DYN_GREEN = 1, 2, 4, 8
DYN_WIND_UP, DYN_WIND_RIGHT, DYN_WIND_DOWN, DYN_WIND_LEFT = 16, 32, 64, 128

# Order of the floats in a STATE record. Must equal STATE_NAMES in
# engine/src/bot/envstate.ts, which fills them, and the constants above and
# the hazard sets below must equal envstate.ts's; check_env.py checks. The
# meanings are in envserver.ts's header. End an episode on "won", the game's
# own end of a win; "complete" comes 34 frames later.
STATE_FIELDS = (
    "fire_x", "fire_y", "fire_vx", "fire_vy",
    "water_x", "water_y", "water_vx", "water_vy",
    "fire_grounded", "water_grounded", "fire_jump_latched", "water_jump_latched",
    "dead_fire", "dead_water", "finish1", "finish2",
    "fire_door_open", "water_door_open",
    "red_count", "blue_count", "green_count",
    "timecount", "complete", "game_over", "won",
    "fire_left", "fire_right", "fire_up", "water_left", "water_right", "water_up",
    *(f"lever{i}" for i in range(LEVER_SLOTS)),
    *(f"pusher{i}" for i in range(PUSHER_SLOTS)),
    *(f"mover{i}_{f}" for i in range(MOVER_SLOTS) for f in MOVER_FIELDS),
    *(f"fan{i}_{f}" for i in range(FAN_SLOTS) for f in FAN_FIELDS),
)

# Tile codes in LevelArray.
SOLID = 1
SLOPES = (-1, -2, -3, -4)
WATER = (5, 51, 52)
LAVA = (6, 61, 62)
GOO = (7, 71, 72)
FIRE_HAZARDS = WATER + GOO      # what kills Fireboy
WATER_HAZARDS = LAVA + GOO      # what kills Watergirl

# Bump whenever CHANNELS, the vector, or their meaning changes, here and in
# envstate.ts; the client refuses a server whose version or STATE names
# differ. Every trained model records the version it was trained on.
SCHEMA_VERSION = 7

# timecount is divided by this in encode() and clipped at 1. 150 s at the
# game's 26 frames a second: the longest medal time (TimeTable) is 145 s, so 1
# means "past every medal". Clipped because Local Play has no time limit: a
# player who takes ten minutes must not show the policy a value it never saw.
TIME_SCALE = 26 * 150

# Which character the bot plays: reset's `side`, encode()'s last float.
FIREBOY, WATERGIRL = 0, 1

# encode() divides by these, measured over random play on every level:
# character speeds are under 16 in 99.9% of frames (a jump starts at 13.5),
# body spin under 2.4 rad/s in 99%, and no level has more than 13 diamonds of
# one colour.
VEL_SCALE = 15
SPIN_SCALE = 5
COUNT_SCALE = 13

# The medal times, copied from the Game constructor (game.ts): TimeTable[i] is
# the A-grade time in seconds for map node i + 1, and TRANSLATION[i] names that
# node "<mode>_<level>", mode 1 adventure, 2 puzzle, 3 speed. check_env.py
# reads both from game.ts. Adventure and speed: one point for
# graded_seconds(timecount at won) <= MEDAL_SECONDS, one for every red and blue
# diamond; 2 points A, 1 B, 0 C. Puzzle ignores the time: A with the green
# diamond, F without.
TRANSLATION = (
    "1_1", "1_2", "3_1", "1_3", "1_4", "3_2", "2_1", "1_5", "1_6", "1_7", "2_2", "3_3", "2_3",
    "3_5", "1_13", "3_6", "2_4", "1_14", "1_16", "2_5", "1_15", "1_17", "2_6", "1_10", "1_11",
    "3_4", "2_7", "1_12", "2_8", "1_8", "1_9", "2_9",
)
TIME_TABLE = (80, 60, 28, 50, 50, 20, 70, 70, 47, 60, 60, 40, 80, 33, 145, 60, 85, 75, 90, 120,
              50, 100, 90, 80, 70, 21, 55, 48, 85, 55, 60, 90)
MODES = {"1": "adventure", "2": "puzzle", "3": "speed"}
MEDAL_SECONDS = {(MODES[n.split("_")[0]], int(n.split("_")[1])): t
                 for n, t in zip(TRANSLATION, TIME_TABLE) if not n.startswith("2_")}


def graded_seconds(timecount: float) -> int:
    """The seconds the game grades a win at, from timecount once won is 1
    (it stops there). Measured against the medal timer from any start clock."""
    return (int(timecount) - 1) // 26


# Channel order of the tile tensor. encode() must produce exactly these.
CHANNELS = (
    "solid", "slope1", "slope2", "slope3", "slope4",
    "water", "lava", "goo",
    "red_diamond", "blue_diamond", "green_diamond",
    "fire_door", "water_door",
    "moving",
    "wind_up", "wind_right", "wind_down", "wind_left",
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
    # bool, (ROWS, COLS): solid static bodies the grid leaves out (the seesaw
    # bases). Pass it to bfs_field as `walls`; encode() adds it to "solid".
    obstacles: np.ndarray


def cell(x: float, y: float) -> tuple[int, int]:
    """The (row, col) of a world position, rounded the way JS Math.round does
    (half up), which is how the server puts bodies in cells. Python's round()
    rounds half to even, so 2.5 would land in a different cell."""
    return math.floor(y + 0.5), math.floor(x + 0.5)


class EnvClient:
    """N envs in one Node process."""

    def __init__(self, n: int, node: str = "node", cache: int = 4):
        """`cache` is how many levels each env keeps built; a reset to one
        it dropped builds it again, which costs time but not exactness."""
        self.n = n
        self.proc = subprocess.Popen([node, str(SERVER), str(n), str(cache)],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        hello = json.loads(self._call(bytes([OP_HELLO])))
        same_names = tuple(hello["state"]) == STATE_FIELDS
        if hello["schema"] != SCHEMA_VERSION or not same_names:
            self.close()
            raise RuntimeError(f"server speaks schema {hello['schema']}, this client {SCHEMA_VERSION}"
                               + ("" if same_names else ", and their STATE field names differ")
                               + "; rebuild the server or update fbwg_env.py")
        self.engine_version: str = hello["engine"]

    def _call(self, payload: bytes, want: int | None = None) -> bytes:
        """Send one framed request, return the reply payload, which must be
        `want` bytes if given: a server built from other constants fails here,
        not as misread floats."""
        self.proc.stdin.write(struct.pack("<I", len(payload)) + payload)
        self.proc.stdin.flush()
        head = self.proc.stdout.read(4)
        if len(head) < 4:
            raise RuntimeError("env server exited; run it by hand to see its error")
        (length,) = struct.unpack("<I", head)
        reply = self.proc.stdout.read(length)
        if len(reply) != length or want is not None and length != want:
            raise RuntimeError(f"reply is {length} bytes ({len(reply)} read), want {want}; "
                               "rebuild the server or update fbwg_env.py")
        return reply

    @staticmethod
    def parse_state(buf: bytes, off: int = 0) -> State:
        """One STATE record starting at `off`."""
        vec = np.frombuffer(buf, "<f4", STATE_FLOATS, off).astype(np.float32)
        (h,) = struct.unpack_from("<I", buf, off + STATE_FLOATS * 4)
        dyn = np.frombuffer(buf, np.uint8, ROWS * COLS, off + STATE_FLOATS * 4 + 4)
        return State(vec, h, dyn.reshape(ROWS, COLS).copy())

    def reset(self, env: int, mode: str, num: int, delay: int = 0, side: int = FIREBOY) -> State:
        """Start an episode with the bot playing `side` (FIREBOY or WATERGIRL).
        `delay` frames pass between sending the bot's press and it taking
        effect; 0, the default, is the bot on the main thread. The partner's
        bits always apply at once, as a human's keys do in Local Play."""
        if side not in (FIREBOY, WATERGIRL):
            raise ValueError(f"side must be FIREBOY or WATERGIRL, got {side}")
        m = mode.encode("ascii")
        reply = self._call(struct.pack("<BHB", OP_RESET, env, len(m)) + m + bytes([num, delay, side]),
                           STATE_BYTES)
        return self.parse_state(reply)

    def step(self, bits: list[int], repeat: int = 1) -> list[State]:
        """`bits[i]` is env i's 6-bit input: 1/2/4 Fireboy left/right/up,
        8/16/32 Watergirl left/right/up."""
        if len(bits) != self.n:
            raise ValueError(f"{len(bits)} inputs for {self.n} envs")
        reply = self._call(bytes([OP_STEP, repeat]) + bytes(bits), STATE_BYTES * self.n)
        return [self.parse_state(reply, i * STATE_BYTES) for i in range(self.n)]

    def info(self, env: int) -> LevelInfo:
        reply = self._call(struct.pack("<BH", OP_INFO, env), 2 * ROWS * COLS + 4)
        grid = np.frombuffer(reply, np.int8, ROWS * COLS).reshape(ROWS, COLS).copy()
        fr, fc, wr, wc = reply[ROWS * COLS:ROWS * COLS + 4]
        obstacles = np.frombuffer(reply, np.uint8, ROWS * COLS, ROWS * COLS + 4).reshape(ROWS, COLS) > 0
        return LevelInfo(grid, (fr, fc), (wr, wc), obstacles)

    def close(self) -> None:
        self.proc.stdin.close()
        self.proc.wait()


def bfs_field(grid: np.ndarray, door: tuple[int, int], hazards: tuple[int, ...],
              walls: np.ndarray | None = None) -> np.ndarray:
    """Distance from every cell to `door`, 4-connected, normalised to [0, 1].

    Passable: any cell that is not SOLID, not in `hazards` and not True in
    `walls` (bool, (ROWS, COLS); pass LevelInfo.obstacles). The door cell
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
    if walls is not None:
        passable &= ~walls
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


_X, _Y, _VEL, _SPIN, _COUNT, _ANGLE = (
    [i for i, n in enumerate(STATE_FIELDS) if n.endswith(ends)]
    for ends in (("_x", "_x0", "_x1"), ("_y", "_y0", "_y1"), ("_vx", "_vy"), ("_spin",), ("_count",),
                 ("_angle",)))


def encode(info: LevelInfo, state: State, bfs_fire: np.ndarray,
           bfs_water: np.ndarray, side: int) -> dict[str, np.ndarray]:
    """One observation.

    tiles: float32, (len(CHANNELS), ROWS, COLS), one-hot, in CHANNELS order.
           Static channels come from info.grid, and solid adds
           info.obstacles; diamonds, moving and wind from state.dyn; doors
           are a single 1 at each door cell.
    bfs:   float32, (2, ROWS, COLS): fire then water.
    vec:   float32, 1-D: state.vec with positions and fan bounds divided by
           COLS/ROWS, velocities by VEL_SCALE, spin by SPIN_SCALE, diamond
           counts by COUNT_SCALE, mover angles wrapped and divided by pi, and
           timecount by TIME_SCALE and clipped at 1, so nearly every value
           stays in [-1, 1]; the six key fields stay 0/1, both characters',
           so the bot sees what its partner pressed last frame. Then sin and
           cos of (timecount + 1) / 10, then `side` (FIREBOY 0, WATERGIRL 1).
    """
    g, d = info.grid, state.dyn
    fire_door = np.zeros(g.shape, bool)
    fire_door[info.fire_door] = True
    water_door = np.zeros(g.shape, bool)
    water_door[info.water_door] = True
    planes = {
        "solid": (g == SOLID) | info.obstacles,
        "slope1": g == SLOPES[0], "slope2": g == SLOPES[1],
        "slope3": g == SLOPES[2], "slope4": g == SLOPES[3],
        "water": np.isin(g, WATER), "lava": np.isin(g, LAVA), "goo": np.isin(g, GOO),
        "red_diamond": (d & DYN_RED) > 0, "blue_diamond": (d & DYN_BLUE) > 0,
        "green_diamond": (d & DYN_GREEN) > 0,
        "fire_door": fire_door, "water_door": water_door,
        "moving": (d & DYN_MOVING) > 0,
        "wind_up": (d & DYN_WIND_UP) > 0, "wind_right": (d & DYN_WIND_RIGHT) > 0,
        "wind_down": (d & DYN_WIND_DOWN) > 0, "wind_left": (d & DYN_WIND_LEFT) > 0,
    }
    vec = state.vec.astype(np.float32)
    vec[_X] /= COLS
    vec[_Y] /= ROWS
    vec[_VEL] /= VEL_SCALE
    vec[_SPIN] /= SPIN_SCALE
    vec[_COUNT] /= COUNT_SCALE
    vec[_ANGLE] = (vec[_ANGLE] + np.pi) % (2 * np.pi) / np.pi - 1
    t = float(state.vec[STATE_FIELDS.index("timecount")])
    vec[STATE_FIELDS.index("timecount")] = min(t / TIME_SCALE, 1.0)
    # The fan-strength phase: every fan pushes with 20 * (sin(timecount / 10)
    # + 1) on top of its size (game.ts Update), so a jump through one depends
    # on where in the cycle it is. The game adds 1 to timecount before the
    # fans push, so the push the next action meets is at t + 1. Cos too, to
    # tell rising from falling.
    if side not in (FIREBOY, WATERGIRL):
        raise ValueError(f"side must be FIREBOY or WATERGIRL, got {side}")
    vec = np.append(vec, np.float32([math.sin((t + 1) / 10), math.cos((t + 1) / 10), side]))
    return {
        "tiles": np.stack([planes[c] for c in CHANNELS]).astype(np.float32),
        "bfs": np.stack([bfs_fire, bfs_water]).astype(np.float32),
        "vec": vec,
    }
