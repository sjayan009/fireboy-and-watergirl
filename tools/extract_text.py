"""Recover every DefineEditText field from the SWF.

The 56 DefineText characters need no work: they are static, and JPEXS bakes
them into the sprite art it already exports as glyph outlines. The 35
DefineEditText fields are the live ones -- the timer, the diamond counters, the
per-level best times on the menu map -- and the game writes to them at runtime,
so the renderer has to draw them itself.

Each one is placed as a *named* child, which means export_assets.py has already
stripped it out of the "base" art and left a hole for us to draw into. All this
script does is recover what to draw there: font, size, colour, alignment and
the bounding box.

Output: extracted/assets/text.json, keyed by character id.
"""
import json
import os
import struct

import swfabc as A

HERE = os.path.dirname(os.path.abspath(__file__))
SWF = os.path.join(HERE, "..", "Fireboy & Watergirl - The Forest Temple.swf")
OUT = os.path.join(HERE, "..", "extracted", "assets", "text.json")

NUL = bytes([0])
TWIPS = 20.0            # SWF stores coordinates in twentieths of a pixel

ALIGN = {0: "left", 1: "right", 2: "center", 3: "justify"}


class Bits:
    """SWF packs RECT and MATRIX as bit fields, not bytes."""

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


def read_rect(p):
    b = Bits(p)
    nb = b.read(5)
    xmin, xmax, ymin, ymax = (b.signed(nb) for _ in range(4))
    return ({"x": xmin / TWIPS, "y": ymin / TWIPS,
             "w": (xmax - xmin) / TWIPS, "h": (ymax - ymin) / TWIPS},
            b.byte_off)


def font_names(buf):
    """character id -> font name, from DefineFontName (tag 88)."""
    out = {}
    for code, s, ln in A.tags(buf, A.body_start(buf)):
        if code != 88:
            continue
        cid = struct.unpack("<H", buf[s:s + 2])[0]
        e = buf.index(NUL, s + 2)
        out[cid] = buf[s + 2:e].decode("utf8", "replace")
    return out


def parse_edit_text(p):
    """One DefineEditText body, minus the leading character id."""
    bounds, off = read_rect(p)
    flags = struct.unpack("<H", p[off:off + 2])[0]
    off += 2

    has_text = bool(flags & 0x0080)
    has_color = bool(flags & 0x0004)
    has_max_len = bool(flags & 0x0002)
    has_font = bool(flags & 0x0001)
    has_font_class = bool(flags & 0x8000)
    has_layout = bool(flags & 0x2000)

    field = {
        "bounds": bounds,
        "multiline": bool(flags & 0x0020),
        "wordWrap": bool(flags & 0x0040),
        "html": bool(flags & 0x0200),
        "readOnly": bool(flags & 0x0008),
        "autoSize": bool(flags & 0x4000),
        "border": bool(flags & 0x0800),
    }

    if has_font_class:                 # a name rather than a character id
        e = p.index(NUL, off)
        field["fontClass"] = p[off:e].decode("utf8", "replace")
        off = e + 1
        field["size"] = struct.unpack("<H", p[off:off + 2])[0] / TWIPS
        off += 2
    elif has_font:
        fid, fsize = struct.unpack("<HH", p[off:off + 4])
        off += 4
        field["fontId"] = fid
        field["size"] = fsize / TWIPS

    if has_color:
        r, g, b, a = p[off:off + 4]
        off += 4
        field["color"] = (r << 16) | (g << 8) | b
        field["alpha"] = a / 255.0

    if has_max_len:
        off += 2

    if has_layout:
        field["align"] = ALIGN.get(p[off], "left")
        lm, rm, indent = struct.unpack("<HHH", p[off + 1:off + 7])
        field["leftMargin"] = lm / TWIPS
        field["rightMargin"] = rm / TWIPS
        field["indent"] = indent / TWIPS
        field["leading"] = struct.unpack("<h", p[off + 7:off + 9])[0] / TWIPS
        off += 9
    else:
        field.setdefault("align", "left")

    e = p.index(NUL, off)
    field["variable"] = p[off:e].decode("utf8", "replace")
    off = e + 1

    if has_text:
        e = p.index(NUL, off)
        field["initialText"] = p[off:e].decode("utf8", "replace")
    else:
        field["initialText"] = ""

    return field


def main():
    buf = A.inflate(SWF)
    fonts = font_names(buf)

    fields = {}
    for code, s, ln in A.tags(buf, A.body_start(buf)):
        if code != 37:                 # DefineEditText
            continue
        cid = struct.unpack("<H", buf[s:s + 2])[0]
        f = parse_edit_text(buf[s + 2:s + ln])
        if "fontId" in f:
            f["fontName"] = fonts.get(f["fontId"], "")
        fields[str(cid)] = f

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump({"fonts": {str(k): v for k, v in sorted(fonts.items())},
                   "fields": fields}, fh, indent=1, sort_keys=True)

    print("fonts  : %s" % ", ".join("%d=%s" % kv for kv in sorted(fonts.items())))
    print("fields : %d DefineEditText characters" % len(fields))
    for cid in ("768", "769", "771", "659", "684"):
        f = fields.get(cid)
        if f:
            print("  %-4s %-24s %5.1fpt  #%06X  %-6s %r"
                  % (cid, f.get("fontName", "?"), f.get("size", 0),
                     f.get("color", 0), f["align"], f["initialText"]))
    print("wrote %s" % os.path.abspath(OUT))


if __name__ == "__main__":
    main()
