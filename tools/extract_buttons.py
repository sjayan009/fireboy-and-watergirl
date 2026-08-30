"""Recover every state of every DefineButton2 in the SWF.

A button is art the sprite export skips -- JPEXS exports DefineSprite, and a
button is not one. Without this the intro menu draws its temple and its title
and then nothing where "Start Game", "Instructions" and "Credits" should be.
It is also the only record of where a button can be clicked.

So this recovers what is needed to draw a button at rest, and what is needed to
click one: which characters the up and hit states place, and where. Those
characters are ordinary shapes and text that the existing export already wrote
out, so the renderer draws them through the same path it uses for a sprite's
named children.

The hit state is not a nicety. The level map's node buttons (624, 626, 628)
have an EMPTY up state -- the visible hexagon is a separate `node_N` clip, and
the button is a bare invisible hit area sitting on top of it. Hit-testing the
up state would make every one of the 32 levels unclickable.

The over and down states are where the menus' hover feedback lives, and each
button does it differently:

  * "Play" places the SAME character twice at the same matrix when hovered, so
    the label draws over itself and reads brighter; pressing it scales that to
    0.9 so the text shrinks under the click.
  * "Retry Level", "Main Menu" and "Continue" swap in an entirely different
    label character, and Main Menu swaps its plaque too.

None of that is guessable, which is why it is read out of the file rather than
approximated with a tint.

Output: extracted/assets/buttons.json, keyed by character id.

Run this through `export_assets.py` rather than on its own. This writes only
the raw placements; `export_button_parts` then enriches the same file in place
with each character's geometry and each button's hit box, and the renderer
needs all of it. Running this script alone would leave a file the game cannot
click.
"""
import json
import os
import struct

import swfabc as A

HERE = os.path.dirname(os.path.abspath(__file__))
SWF = os.path.join(HERE, "..", "Fireboy & Watergirl - The Forest Temple.swf")
OUT = os.path.join(HERE, "..", "extracted", "assets", "buttons.json")

STATE_UP = 0x01
STATE_OVER = 0x02
STATE_DOWN = 0x04
STATE_HIT = 0x08
HAS_FILTERS = 0x10
HAS_BLEND = 0x20

TWIPS = 20.0


class Bits:
    def __init__(self, buf, byte_off=0):
        self.buf = buf
        self.bit = byte_off * 8

    def read(self, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | ((self.buf[self.bit >> 3] >> (7 - (self.bit & 7))) & 1)
            self.bit += 1
        return v

    def signed(self, n):
        v = self.read(n)
        return v - (1 << n) if n and (v >> (n - 1)) else v

    @property
    def byte_off(self):
        return (self.bit + 7) // 8


def read_matrix(p, byte_off):
    """MATRIX -> ([a, b, c, d, tx, ty], next byte offset)."""
    b = Bits(p, byte_off)
    a = d = 1.0
    bb = c = 0.0
    if b.read(1):                      # HasScale
        nb = b.read(5)
        a = b.signed(nb) / 65536.0
        d = b.signed(nb) / 65536.0
    if b.read(1):                      # HasRotate
        nb = b.read(5)
        bb = b.signed(nb) / 65536.0
        c = b.signed(nb) / 65536.0
    nb = b.read(5)
    tx = b.signed(nb) / TWIPS
    ty = b.signed(nb) / TWIPS
    return [a, bb, c, d, tx, ty], b.byte_off


def skip_cxform(p, byte_off):
    """CXFORMWITHALPHA, always present in a DefineButton2 record."""
    b = Bits(p, byte_off)
    has_add = b.read(1)
    has_mult = b.read(1)
    nb = b.read(4)
    if has_mult:
        b.read(nb * 4)
    if has_add:
        b.read(nb * 4)
    return b.byte_off


# Byte length of each fixed-size FILTER body, by filter id.
FILTER_SIZE = {
    0: 23,      # DropShadow: RGBA, blurX, blurY, angle, distance, strength, flags
    1: 9,       # Blur:       blurX, blurY, passes
    2: 15,      # Glow:       RGBA, blurX, blurY, strength, flags
    3: 27,      # Bevel
    5: None,    # Convolution: size depends on the matrix
    6: 80,      # ColorMatrix: 20 floats
}


def skip_filters(p, byte_off):
    """FILTERLIST.

    Buttons in this SWF do carry filters (the menu nodes glow), and every
    record after one is offset by however many bytes it takes -- so a guess
    here would silently corrupt the rest of the button. Sizes are the SWF
    spec's; anything unrecognised stops the extractor rather than producing
    plausible nonsense.
    """
    n = p[byte_off]
    off = byte_off + 1
    for _ in range(n):
        fid = p[off]
        off += 1
        if fid in (4, 7):                       # gradient glow / gradient bevel
            colors = p[off]
            off += 1 + colors * 5               # RGBA + ratio per colour
            off += 4 + 4 + 4 + 4 + 2 + 1        # blur, angle, distance, strength
            continue
        if fid == 5:                            # convolution
            mx, my = p[off], p[off + 1]
            off += 2 + 4 + 4 + mx * my * 4 + 4 + 1
            continue
        size = FILTER_SIZE.get(fid)
        if size is None:
            raise SystemExit("unknown button filter id %d" % fid)
        off += size
    return off


STATES = (("up", STATE_UP), ("over", STATE_OVER),
          ("down", STATE_DOWN), ("hit", STATE_HIT))


def parse_button2(p):
    """The placements of one DefineButton2 body, split by state.

    A record can belong to several states at once -- "Play" shares one
    character between up, over and down -- so all four are collected in a
    single pass rather than parsing the tag once per state. Depth is the draw
    order within a state, and two records can share a depth across states
    without conflicting.
    """
    off = 2                            # ButtonId
    off += 1                           # flags: reserved bits + TrackAsMenu
    off += 2                           # ActionOffset

    out = {name: [] for name, _ in STATES}
    while off < len(p) and p[off] != 0:
        rec = p[off]
        off += 1
        cid, depth = struct.unpack("<HH", p[off:off + 4])
        off += 4
        m, off = read_matrix(p, off)
        off = skip_cxform(p, off)
        if rec & HAS_FILTERS:
            off = skip_filters(p, off)
        if rec & HAS_BLEND:
            off += 1
        for name, bit in STATES:
            if rec & bit:
                out[name].append({"id": cid, "depth": depth, "m": list(m)})
    for name, _ in STATES:
        # a stable sort keeps "Play"'s two identical placements in file order
        out[name].sort(key=lambda r: r["depth"])
    return out


def main():
    if os.environ.get("FBWG_BUTTON_EXPORT") != "1":
        raise SystemExit(
            "refusing to run standalone: this writes only the raw placements "
            "and would strip the hit boxes the renderer needs. "
            "Run tools/export_assets.py instead.")
    buf = A.inflate(SWF)
    buttons = {}
    for code, s, ln in A.tags(buf, A.body_start(buf)):
        if code != 34:                 # DefineButton2
            continue
        bid = struct.unpack("<H", buf[s:s + 2])[0]
        buttons[str(bid)] = parse_button2(buf[s:s + ln])

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(buttons, fh, indent=1, sort_keys=True)

    counts = {name: sum(len(v[name]) for v in buttons.values())
              for name, _ in STATES}
    print("buttons          : %d (%s)"
          % (len(buttons),
             ", ".join("%d %s" % (n, k) for k, n in counts.items())))
    no_hit = [b for b, v in buttons.items() if not v["hit"]]
    if no_hit:
        print("  WARNING: no hit state, so unclickable: %s" % no_hit)
    ids = lambda v, k: [r["id"] for r in v[k]]
    changing = [b for b, v in buttons.items()
                if ids(v, "over") != ids(v, "up")
                or [r["m"] for r in v["over"]] != [r["m"] for r in v["up"]]]
    print("  buttons that change on hover: %d of %d"
          % (len(changing), len(buttons)))
    for bid in ("371", "279", "635", "690"):
        if bid in buttons:
            v = buttons[bid]
            print("  %-5s up=%-12s over=%-12s down=%s"
                  % (bid, ids(v, "up"), ids(v, "over"), ids(v, "down")))
    print("wrote %s" % os.path.abspath(OUT))


if __name__ == "__main__":
    main()
