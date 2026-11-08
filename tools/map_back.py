"""Make the level map's way out read "Back", like every card screen before it.

The map's Main Menu is two things in the SWF. The button (DefineButton 635,
`BackToIntro`) draws gold Trajan Pro lettering (DefineText 630 dim, 632 lit)
over a thick, hand-roughened dark outline of the same words (shapes 629/631/633,
#5e4713), which is what lifts them off the parchment. And the parchment under it
(shape 500, sprite 638's background) has the same silhouette engraved in
#3a2d0c, so hiding the button alone leaves "MAIN MENU" standing in the art.

The pause tray's End Game is the same DefineButton, and it keeps saying Main
Menu. So 635 is left alone and the art goes into a new button, "635-back",
which the map's BackToIntro draws from (Game.CreateMainMenu sets its spriteId).

This removes the engraving and gives that button art saying "Back":

  * the lettering is Trajan Pro from the SWF's own font 49 (fonts/49.ttf), the
    face the map's text and the cards' Back already use, at DefineText 632's
    size, baseline, colour and left edge;
  * the outline is the same glyphs grown by a round 2.5 px and dropped 0.5 px,
    in the original's #5e4713. Those two numbers are measured: of the spreads
    and drops tried, they overlap shape 631 best around "MAIN MENU" (IoU 0.79;
    the rest is the original's hand-roughened edge);
  * every state draws the lit art, since Back is always lit.

The clip keeps its handlers, keyboard shortcut (Escape) and intent; only the
art it is drawn and hit-tested from changes. Its hit box is the new art's, so
the space "MENU" used to fill no longer answers clicks.

Run standalone to patch the shipped assets in place:

    python tools/map_back.py

export_assets.py calls `apply` after the button parts, so a full re-export
stays patched. Running it twice changes nothing.
"""
import json
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "..", "extracted", "assets")
FONT = os.path.join(ASSETS, "fonts", "49.ttf")
MAP_BASE = os.path.join(ASSETS, "sprites", "638", "1_base.svg")
BUTTONS = os.path.join(ASSETS, "buttons.json")
PARTS = os.path.join(ASSETS, "parts")

BUTTON = "635-back"
ENGRAVING = 'fill="#3a2d0c"'
WORD = "Back"
GOLD = "#ffcc00"
SHADOW = "#5e4713"
# DefineText 632: 0.04 px per font unit, baseline at y=40, placed at this
# matrix inside the button.
GLYPH = 0.04
BASELINE = 40.0
PLACE = [0.4897918701171875, 0.0, 0.0, 0.4897918701171875, -111.9, -18.1]
GROW = 2.5   # button px, the outline's spread
DROP = 0.5   # button px, the outline's offset
TEXT_ID, SHADOW_ID = "635-back-text", "635-back-shadow"


def ttf_glyphs(path, chars):
    """{char: (svg path in font units, y down; advance; (x0, y0, x1, y1))}."""
    d = open(path, "rb").read()
    tables = {}
    for i in range(struct.unpack(">H", d[4:6])[0]):
        tag, _, off, ln = struct.unpack(">4sIII", d[12 + 16 * i:28 + 16 * i])
        tables[tag.decode()] = (off, ln)

    head = tables["head"][0]
    long_loca = struct.unpack(">h", d[head + 50:head + 52])[0] == 1
    n_hmetrics = struct.unpack(">H", d[tables["hhea"][0] + 34:][:2])[0]

    def loca(gid):
        o = tables["loca"][0]
        if long_loca:
            return struct.unpack(">II", d[o + 4 * gid:o + 4 * gid + 8])
        a, b = struct.unpack(">HH", d[o + 2 * gid:o + 2 * gid + 4])
        return a * 2, b * 2

    def advance(gid):
        o = tables["hmtx"][0] + 4 * min(gid, n_hmetrics - 1)
        return struct.unpack(">H", d[o:o + 2])[0]

    def cmap(ch):
        o = tables["cmap"][0]
        for i in range(struct.unpack(">H", d[o + 2:o + 4])[0]):
            pid, eid, sub = struct.unpack(">HHI", d[o + 4 + 8 * i:o + 12 + 8 * i])
            s = o + sub
            if struct.unpack(">H", d[s:s + 2])[0] != 4:
                continue
            segs = struct.unpack(">H", d[s + 6:s + 8])[0] // 2
            arr = lambda k: struct.unpack(">%dH" % segs, d[s + 14 + k * 2 * segs + (2 if k else 0):][:2 * segs])
            ends, starts = arr(0), arr(1)
            deltas = struct.unpack(">%dh" % segs, d[s + 16 + 4 * segs:][:2 * segs])
            ro = s + 16 + 6 * segs
            offs = struct.unpack(">%dH" % segs, d[ro:ro + 2 * segs])
            c = ord(ch)
            for k in range(segs):
                if starts[k] <= c <= ends[k]:
                    if offs[k] == 0:
                        return (c + deltas[k]) & 0xFFFF
                    g = struct.unpack(">H", d[ro + 2 * k + offs[k] + 2 * (c - starts[k]):][:2])[0]
                    return (g + deltas[k]) & 0xFFFF if g else 0
        raise KeyError(ch)

    out = {}
    glyf = tables["glyf"][0]
    for ch in chars:
        gid = cmap(ch)
        a, b = loca(gid)
        g = glyf + a
        n, x0, y0, x1, y1 = struct.unpack(">hhhhh", d[g:g + 10])
        if n < 0 or b <= a:
            raise ValueError("glyph %r is not a simple outline" % ch)
        ends = struct.unpack(">%dH" % n, d[g + 10:g + 10 + 2 * n])
        p = g + 10 + 2 * n
        p += 2 + struct.unpack(">H", d[p:p + 2])[0]
        count = ends[-1] + 1
        flags = []
        while len(flags) < count:
            f = d[p]; p += 1
            flags.append(f)
            if f & 8:
                flags.extend([f] * d[p]); p += 1
        coords = []
        for short, same in ((2, 16), (4, 32)):
            v, vals = 0, []
            for f in flags:
                if f & short:
                    v += d[p] if f & same else -d[p]; p += 1
                elif not f & same:
                    v += struct.unpack(">h", d[p:p + 2])[0]; p += 2
                vals.append(v)
            coords.append(vals)
        pts = [(x, -y, f & 1) for x, y, f in zip(coords[0], coords[1], flags)]

        cmds, start = [], 0
        for end in ends:
            c = pts[start:end + 1]
            start = end + 1
            # Begin on an on-curve point; between two off-curve points the
            # on-curve one is implied at their midpoint.
            k = next((i for i, q in enumerate(c) if q[2]), None)
            if k is None:
                c = [((c[0][0] + c[-1][0]) / 2, (c[0][1] + c[-1][1]) / 2, 1)] + c
                k = 0
            c = c[k:] + c[:k]
            cmds.append("M%g %g" % c[0][:2])
            ctrl = None
            for q in c[1:] + c[:1]:
                if q[2]:
                    cmds.append(("Q%g %g %g %g" % (ctrl + q[:2])) if ctrl else "L%g %g" % q[:2])
                    ctrl = None
                elif ctrl:
                    mid = ((ctrl[0] + q[0]) / 2, (ctrl[1] + q[1]) / 2)
                    cmds.append("Q%g %g %g %g" % (ctrl + mid))
                    ctrl = q[:2]
                else:
                    ctrl = q[:2]
            cmds.append("Z")
        out[ch] = (" ".join(cmds), advance(gid), (x0, -y1, x1, -y0))
    return out


def part_svg(glyphs, word, attrs, pad):
    """A part in DefineText 632's own coordinates, with its geometry entry."""
    x, uses, defs = 0.0, [], {}
    x0 = y0 = float("inf")
    x1 = y1 = float("-inf")
    for ch in word:
        path, adv, (gx0, gy0, gx1, gy1) = glyphs[ch]
        gid = "glyph_%d" % ord(ch)
        defs[gid] = '<g id="%s"><path d="%s" fill-rule="nonzero"/></g>' % (gid, path)
        uses.append('<use transform="matrix(%g, 0, 0, %g, %g, %g)" xlink:href="#%s"/>'
                    % (GLYPH, GLYPH, x, BASELINE, gid))
        x0, x1 = min(x0, x + gx0 * GLYPH), max(x1, x + gx1 * GLYPH)
        y0, y1 = min(y0, BASELINE + gy0 * GLYPH), max(y1, BASELINE + gy1 * GLYPH)
        x += adv * GLYPH
    ox, oy = pad - x0, pad - y0
    w, h = x1 - x0 + 2 * pad, y1 - y0 + 2 * pad
    svg = ('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
           '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
           'width="%.2fpx" height="%.2fpx">\n  <g transform="matrix(1, 0, 0, 1, %.2f, %.2f)" %s>\n    %s\n  </g>\n'
           '  <defs>\n    %s\n  </defs>\n</svg>\n'
           % (w, h, ox, oy, attrs, "\n    ".join(uses), "\n    ".join(defs.values())))
    return svg, {"w": round(w, 2), "h": round(h, 2), "ox": round(ox, 2),
                 "oy": round(oy, 2), "from": "part"}


def erase_engraving(path=MAP_BASE):
    """Drop the engraved words from the map's parchment. True if it changed."""
    svg = open(path, encoding="utf-8").read()
    start = svg.find('id="shape1"')
    end = svg.find("</g>", start)
    paths = [i for i in range(start, end) if svg.startswith("<path", i)
             and ENGRAVING in svg[i:svg.find(">", i)]]
    if not paths:
        return False
    if len(paths) != 1:
        raise ValueError("expected one engraving path in shape1, found %d" % len(paths))
    i = paths[0]
    j = svg.find(">", i) + 1
    # Take the path's own line, so the file keeps its indentation.
    i = svg.rfind("\n", 0, i)
    open(path, "w", encoding="utf-8", newline="").write(svg[:i] + svg[j:])
    return True


def apply():
    glyphs = ttf_glyphs(FONT, set(WORD))
    # Glyph units are px / GLYPH and the part is scaled by PLACE[0], so a
    # button-space stroke of 2 * GROW is this wide in the glyphs' own units.
    stroke = 2 * GROW / (GLYPH * PLACE[0])
    text, text_geom = part_svg(glyphs, WORD, 'fill="%s"' % GOLD, 1)
    shadow, shadow_geom = part_svg(
        glyphs, WORD, 'fill="%s" stroke="%s" stroke-width="%.1f" stroke-linejoin="round"'
        % (SHADOW, SHADOW, stroke), GROW / PLACE[0] + 1)
    os.makedirs(PARTS, exist_ok=True)
    for pid, svg in ((TEXT_ID, text), (SHADOW_ID, shadow)):
        open(os.path.join(PARTS, pid + ".svg"), "w", encoding="utf-8").write(svg)

    manifest = json.load(open(BUTTONS, encoding="utf-8"))
    manifest["parts"][TEXT_ID] = text_geom
    manifest["parts"][SHADOW_ID] = shadow_geom
    dropped = PLACE[:5] + [PLACE[5] + DROP]
    art = [{"depth": 1, "id": SHADOW_ID, "m": dropped},
           {"depth": 2, "id": TEXT_ID, "m": PLACE}]
    button = manifest["buttons"][BUTTON] = {s: art for s in ("up", "over", "down", "hit")}

    # The art's own box, in the button's coordinates.
    xs, ys = [], []
    for r in art:
        g = manifest["parts"][r["id"]]
        a, _, _, dd, tx, ty = r["m"]
        xs += [tx - a * g["ox"], tx + a * (g["w"] - g["ox"])]
        ys += [ty - dd * g["oy"], ty + dd * (g["h"] - g["oy"])]
    button["hitBox"] = {"x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)}
    with open(BUTTONS, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1, sort_keys=True)

    return erase_engraving()


if __name__ == "__main__":
    print("engraving removed" if apply() else "engraving already gone", "; Back art written")
