"""Watch the env: what the bot sees, frame by frame.

    npm --prefix engine run build
    python bot/view_env.py                          # a window, adventure 1
    python bot/view_env.py --level puzzle-3
    python bot/view_env.py --gif env.gif --steps 200

Three panels: the encoded tile map with both characters, then Fireboy's and
Watergirl's BFS distance-to-door fields (dark = near the door). The agent is
random, but holds each choice for a while so it actually goes somewhere.
"""
from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.animation import FuncAnimation, PillowWriter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fbwg_env import (  # noqa: E402
    CHANNELS, COLS, FIRE_HAZARDS, ROWS, STATE_FIELDS, WATER_HAZARDS,
    EnvClient, bfs_field, encode,
)

# Painted in this order, so later channels sit on top.
COLORS = {
    "wind_up": (.55, .9, .95), "wind_right": (.55, .9, .95),
    "wind_down": (.55, .9, .95), "wind_left": (.55, .9, .95),
    "solid": (.35, .33, .30), "slope1": (.6, .58, .55), "slope2": (.6, .58, .55),
    "slope3": (.6, .58, .55), "slope4": (.6, .58, .55),
    "water": (.2, .5, 1), "lava": (1, .3, .1), "goo": (.2, .7, .2),
    "moving": (.85, .7, .3),
    "red_diamond": (.9, 0, .2), "blue_diamond": (0, .4, .9), "green_diamond": (.6, .6, .6),
    "fire_door": (1, .55, .55), "water_door": (.55, .75, 1),
}
F = {name: i for i, name in enumerate(STATE_FIELDS)}


def tile_image(tiles: np.ndarray) -> np.ndarray:
    img = np.ones((ROWS, COLS, 3))
    for name, rgb in COLORS.items():
        img[tiles[CHANNELS.index(name)] > 0] = rgb
    return img


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", default="adventure-1", help="mode-num, e.g. puzzle-3")
    ap.add_argument("--steps", type=int, default=600)
    ap.add_argument("--repeat", type=int, default=2, help="frames per step")
    ap.add_argument("--gif", help="save to this file instead of opening a window")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    mode, num = args.level.rsplit("-", 1)

    env = EnvClient(1)
    state = env.reset(0, mode, int(num))
    info = env.info(0)
    bf = bfs_field(info.grid, info.fire_door, FIRE_HAZARDS)
    bw = bfs_field(info.grid, info.water_door, WATER_HAZARDS)
    rng = random.Random(args.seed)

    fig, axes = plt.subplots(1, 3, figsize=(15, 4.6))
    tiles = axes[0].imshow(tile_image(encode(info, state, bf, bw)["tiles"]))
    # 1.0 is a wall, a deadly pool or a cell that cannot reach the door: grey.
    for ax, field, cmap, door in [(axes[1], bf, "magma", info.fire_door),
                                  (axes[2], bw, "viridis", info.water_door)]:
        cm = plt.get_cmap(cmap).with_extremes(bad=(.75, .75, .75))
        ax.imshow(np.ma.masked_equal(field, 1.0), cmap=cm, vmin=0, vmax=1)
        ax.plot(door[1], door[0], "*", color="white", mec="k", ms=16)
    axes[1].set_title("Fireboy: distance to his door")
    axes[2].set_title("Watergirl: distance to her door")
    dots = []
    for ax in axes:
        ax.set_xticks([])
        ax.set_yticks([])
        dots.append((ax.plot([], [], "o", color="orangered", mec="k", ms=8)[0],
                     ax.plot([], [], "o", color="deepskyblue", mec="k", ms=8)[0]))
    fig.tight_layout()

    hold = {"bits": 0, "left": 0}

    def frame(_):
        nonlocal state
        if hold["left"] == 0:
            hold["bits"], hold["left"] = rng.randrange(64), rng.randint(4, 15)
        hold["left"] -= 1
        state = env.step([hold["bits"]], args.repeat)[0]
        v = state.vec
        if v[F["dead_fire"]] or v[F["dead_water"]]:
            state = env.reset(0, mode, int(num))
            v = state.vec
        tiles.set_data(tile_image(encode(info, state, bf, bw)["tiles"]))
        for fire, water in dots:
            fire.set_data([v[F["fire_x"]]], [v[F["fire_y"]]])
            water.set_data([v[F["water_x"]]], [v[F["water_y"]]])
        axes[0].set_title(f"{args.level}  frame {int(v[F['clock']])}  "
                          f"doors {int(v[F['finish1']] > 0)}/{int(v[F['finish2']] > 0)}"
                          + ("  COMPLETE" if v[F["complete"]] else ""))
        return [tiles, *[d for pair in dots for d in pair]]

    anim = FuncAnimation(fig, frame, frames=args.steps, interval=40, blit=False, repeat=False)
    try:
        if args.gif:
            anim.save(args.gif, writer=PillowWriter(fps=25))
            print(f"saved {args.gif}")
        else:
            plt.show()
    finally:
        env.close()


if __name__ == "__main__":
    main()
