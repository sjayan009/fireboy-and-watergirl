"""Put the letters back into masks whose mask layer is a DefineText.

The title wordmarks are a texture seen through a word: sprite 66 places the
text "Watergirl" (DefineText 64) at depth 1 with ClipDepth 3 and the bubbly
water fill (shape 65) above it, and sprite 70 does the same with "FireBoy"
(text 68) over the lava (shape 69). JPEXS's raster export clips them correctly.
Its SVG export does not: it cannot turn a text character into clip geometry, so
it writes the text's BOUNDS RECTANGLE as the <clipPath>, and every browser then
draws the whole texture as a solid block. That SVG is exactly what the renderer
draws for any sprite with named children -- IntroMenu and the loader's
LoaderHolder both place the title -- so the menu showed two coloured slabs
where the words should be.

This rewrites each such <clipPath> with the glyph outlines from JPEXS's text
export, under the same placement matrix the SWF gives the mask. Nothing is
guessed: the rectangle being replaced must equal the text's bounds under that
matrix, or the rewrite refuses.

Run standalone to patch the shipped base SVGs in place:

    python tools/text_masks.py [--raw <extracted/assets/_raw>]

export_assets.py calls `restore_text_masks` on every base SVG it writes, so a
full re-export stays fixed.
"""
import os
import re
import struct
import sys

import swfabc as A
from extract_buttons import read_matrix
from extract_symbols import skip_cxform, skip_matrix

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
SWF = os.path.join(ROOT, "Fireboy & Watergirl - The Forest Temple.swf")
SPRITES = os.path.join(ROOT, "extracted", "assets", "sprites")
RAW = os.path.join(ROOT, "extracted", "assets", "_raw")

TEXT_TAGS = (11, 33)          # DefineText, DefineText2
NUM = r"(-?[\d.]+(?:[eE]-?\d+)?)"
RE_MATRIX = re.compile(r'transform="matrix\(%s\)"' % ", ".join([NUM] * 6))
RE_SIZE = re.compile(r'<svg[^>]*height="([\d.]+)px"[^>]*width="([\d.]+)px"')


def text_masks(buf=None):
    """{sprite id: (text id, placement matrix)} for every DefineText mask."""
    buf = buf if buf is not None else A.inflate(SWF)
    texts = set()
    sprites = {}
    for code, s, ln in A.tags(buf, A.body_start(buf)):
        if code in TEXT_TAGS:
            texts.add(struct.unpack("<H", buf[s:s + 2])[0])
        elif code == 39:
            sprites[struct.unpack("<H", buf[s:s + 2])[0]] = (s + 4, ln - 4)

    out = {}
    for sid, (off, ln) in sprites.items():
        for code, s, l in A.tags(buf, off, off + ln):
            if code not in (26, 70):
                continue
            p = buf[s:s + l]
            flags = p[0]
            if not flags & 0x40 or not flags & 0x02:      # ClipDepth + char
                continue
            q = 3 if code == 26 else 4
            cid = struct.unpack("<H", p[q:q + 2])[0]
            if cid not in texts:
                continue
            q += 2
            m = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
            if flags & 0x04:
                m, _ = read_matrix(p, q)
            if sid in out:
                raise SystemExit("sprite %d has two text masks; only one is "
                                 "handled" % sid)
            out[sid] = (cid, m)
    return out


def mul(m, n):
    """m . n for [a, b, c, d, tx, ty] affine matrices."""
    a, b, c, d, tx, ty = m
    e, f, g, h, ux, uy = n
    return [a * e + c * f, b * e + d * f, a * g + c * h, b * g + d * h,
            a * ux + c * uy + tx, b * ux + d * uy + ty]


def fmt(m):
    return "matrix(%s)" % ", ".join("%.6g" % v for v in m)


def glyph_paths(text_svg):
    """The text's glyphs as [(path d, matrix in the text's own space)].

    The export's root <g> only moves the text onto its canvas, so it is
    dropped; every group below it (the text record's matrix) and each glyph's
    own <use> transform are composed.
    """
    txt = open(text_svg, encoding="utf-8").read()
    defs = {m.group(1): re.findall(r'<path\b[^>]*\bd="([^"]*)"', m.group(2))
            for m in re.finditer(r'<g id="([^"]+)">(.*?)</g>', txt, re.S)}
    body = txt[:txt.find("<defs")] if "<defs" in txt else txt
    stack = []
    out = []
    for m in re.finditer(r"<g\b[^>]*>|</g>|<use\b[^>]*>", body):
        tok = m.group(0)
        if tok == "</g>":
            stack.pop()
            continue
        mm = RE_MATRIX.search(tok)
        local = [float(v) for v in mm.groups()] if mm else [1, 0, 0, 1, 0, 0]
        if tok.startswith("<g"):
            # the first group is the canvas offset, not part of the text
            stack.append(local if stack else [1, 0, 0, 1, 0, 0])
            continue
        ref = re.search(r'xlink:href="#([^"]+)"', tok).group(1)
        acc = [1, 0, 0, 1, 0, 0]
        for g in stack:
            acc = mul(acc, g)
        acc = mul(acc, local)
        for d in defs[ref]:
            out.append((d, acc))
    if not out:
        raise SystemExit("%s: no glyphs found" % text_svg)
    return out


def text_bounds(text_svg):
    """(xmin, ymin, xmax, ymax) of the text character, from its export."""
    txt = open(text_svg, encoding="utf-8").read()
    h, w = (float(v) for v in RE_SIZE.search(txt).groups())
    root = RE_MATRIX.search(txt)
    ox, oy = float(root.group(5)), float(root.group(6))
    return -ox, -oy, w - ox, h - oy


def restore_text_masks(txt, masks, raw_text_dir):
    """Rewrite the bounds-rectangle clipPaths in one exported SVG.

    `masks` is text_masks(). A sprite is found by the <use> that places it
    (ffdec:characterId -> xlink:href="#spriteN"), and its clipPath is the one
    inside that <g id="spriteN">. Returns the new text and how many were fixed.
    """
    fixed = 0
    for sid, (tid, place) in sorted(masks.items()):
        refs = set(re.findall(
            r'<use\b[^>]*\bffdec:characterId="%d"[^>]*\bxlink:href="#([^"]+)"'
            % sid, txt))
        for ref in refs:
            start = txt.find('<g id="%s">' % ref)
            if start < 0:
                continue
            clip = re.compile(r'(<clipPath id="[^"]+">)\s*<path d="([^"]*)"/>'
                              r'\s*(</clipPath>)').search(txt, start)
            if not clip:
                continue          # already restored, or not a bare rect
            src = os.path.join(raw_text_dir, "%d.svg" % tid)
            x0, y0, x1, y1 = text_bounds(src)
            a, b, c, d, tx, ty = place
            if b or c:
                raise SystemExit("text mask %d in sprite %d is rotated; its "
                                 "bounds are not a rectangle" % (tid, sid))
            xs = sorted((a * x0 + tx, a * x1 + tx))
            ys = sorted((d * y0 + ty, d * y1 + ty))
            want = "M %s %s L %s %s L %s %s L %s %s Z" % tuple(
                "%g" % round(v, 2) for v in
                (xs[0], ys[0], xs[0], ys[1], xs[1], ys[1], xs[1], ys[0]))
            have = " ".join("%g" % float(v) if re.match(NUM + "$", v) else v
                            for v in clip.group(2).split())
            if have != want:
                raise SystemExit(
                    "sprite %d: clipPath %r is not text %d's bounds %r; "
                    "refusing to replace it" % (sid, have, tid, want))
            paths = "".join(
                '<path clip-rule="evenodd" d="%s" transform="%s"/>'
                % (dd, fmt(mul(place, m)))
                for dd, m in glyph_paths(src))
            txt = (txt[:clip.start()] + clip.group(1) + paths
                   + clip.group(3) + txt[clip.end():])
            fixed += 1
    return txt, fixed


def main():
    raw = RAW
    if "--raw" in sys.argv:
        raw = sys.argv[sys.argv.index("--raw") + 1]
    masks = text_masks()
    print("text masks in the SWF: %s" % ", ".join(
        "sprite %d <- text %d" % (s, t) for s, (t, _) in sorted(masks.items())))
    total = 0
    for sid in sorted(os.listdir(SPRITES), key=lambda s: (len(s), s)):
        d = os.path.join(SPRITES, sid)
        for f in sorted(os.listdir(d)):
            if not f.endswith("_base.svg"):
                continue
            path = os.path.join(d, f)
            txt = open(path, encoding="utf-8").read()
            new, n = restore_text_masks(txt, masks, os.path.join(raw, "text"))
            if n:
                with open(path, "w", encoding="utf-8", newline="") as fh:
                    fh.write(new)
                print("  %s/%s: %d mask(s) restored" % (sid, f, n))
                total += n
    print("restored %d text mask(s)" % total)


if __name__ == "__main__":
    main()
