"""Recover the display-list shape of every exported SWF symbol.

level.as does not only draw MovieClips, it reads them: the exit door's
`currentFrame` gates level completion, and levers/characters address named
children (`light`, `mc_1`..`mc_5`, `head`). So the TypeScript port needs a
scene graph with the same frame counts and the same named children as the
original, or that logic silently breaks.

Walks DefineSprite tags, recording each symbol's frame count and the
PlaceObject2/3 children that carry a Name.
"""
import json
import os
import struct

import swfabc as A

HERE = os.path.dirname(os.path.abspath(__file__))
SWF = os.path.join(HERE, "..", "Fireboy & Watergirl - The Forest Temple.swf")
OUT = os.path.join(HERE, "..", "extracted", "symbols.json")


def placements(buf, off, ln):
    """Named children of one sprite: [(name, character_id, clip_depth)].

    `clip_depth` is set when the child is a MASK. Flash's IDE marks a mask
    layer by giving its PlaceObject a ClipDepth: the child clips everything
    placed above it up to that depth. Nothing in the ActionScript says so --
    `level.as` just sets `ropeMask.height` and expects the rope to grow -- so
    without reading it the rope's chain slides around at a fixed length
    instead of stretching.
    """
    out = []
    for code, s, l in A.tags(buf, off, off + ln):
        if code not in (26, 70):
            continue
        p = buf[s:s + l]
        flags = p[0]
        has_char = bool(flags & 0x02)
        has_matrix = bool(flags & 0x04)
        has_cxform = bool(flags & 0x08)
        has_ratio = bool(flags & 0x10)
        has_name = bool(flags & 0x20)
        has_clip = bool(flags & 0x40)
        if not has_name:
            continue
        q = 3 if code == 26 else 4
        cid = None
        if has_char:
            cid = struct.unpack("<H", p[q:q + 2])[0]
            q += 2
        # skip MATRIX (bit-packed), CXFORM, ratio to reach the name
        if has_matrix:
            q = skip_matrix(p, q)
        if has_cxform:
            q = skip_cxform(p, q)
        if has_ratio:
            q += 2
        try:
            e = p.index(b"\0", q)
        except ValueError:
            continue
        name = p[q:e].decode("utf8", "replace")
        q = e + 1
        clip = None
        if has_clip and q + 2 <= len(p):
            clip = struct.unpack("<H", p[q:q + 2])[0]
        if name:
            out.append((name, cid, clip))
    return out


def skip_matrix(p, byte_off):
    """MATRIX is bit-packed; return the byte offset just past it."""
    bit = byte_off * 8

    def read(n):
        nonlocal bit
        v = 0
        for _ in range(n):
            byte = p[bit >> 3]
            v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1)
            bit += 1
        return v

    if read(1):                 # HasScale
        nb = read(5)
        read(nb * 2)
    if read(1):                 # HasRotate
        nb = read(5)
        read(nb * 2)
    nb = read(5)                # translate
    read(nb * 2)
    return (bit + 7) // 8


def skip_cxform(p, byte_off):
    bit = byte_off * 8

    def read(n):
        nonlocal bit
        v = 0
        for _ in range(n):
            byte = p[bit >> 3]
            v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1)
            bit += 1
        return v

    has_add = read(1)
    has_mult = read(1)
    nb = read(4)
    if has_mult:
        read(nb * 4)
    if has_add:
        read(nb * 4)
    return (bit + 7) // 8


def main():
    buf = A.inflate(SWF)
    names = A.symbol_names(buf)

    sprites = {}
    for code, s, ln in A.tags(buf, A.body_start(buf)):
        if code == 39:
            sid, frames = struct.unpack("<HH", buf[s:s + 4])
            sprites[sid] = (s + 4, ln - 4, frames)

    out = {}
    for sid, (off, ln, frames) in sprites.items():
        nm = names.get(sid)
        if not nm:
            continue
        kids = []
        clip_mask = None
        for cname, cid, clip in placements(buf, off, ln):
            kids.append({"name": cname, "symbol": names.get(cid), "id": cid})
            if clip is not None:
                # A ClipDepth mask covers every depth above it up to `clip`.
                # In this SWF that is always the whole rest of the symbol, so
                # it is recorded as "this child masks its siblings" rather than
                # modelling depth ranges nothing here needs.
                clip_mask = cname
        entry = {"id": sid, "frames": frames, "children": kids}
        if clip_mask:
            entry["clipMask"] = clip_mask
        out[nm] = entry

    # symbols with no DefineSprite (shapes/sounds) still need a frame count
    for sid, nm in names.items():
        out.setdefault(nm, {"id": sid, "frames": 1, "children": []})

    with open(OUT, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)

    withkids = {k: v for k, v in out.items() if v["children"]}
    masks = {k: v["clipMask"] for k, v in out.items() if v.get("clipMask")}
    print("%d symbols, %d with named children" % (len(out), len(withkids)))
    print("%d with a ClipDepth mask: %s" % (len(masks), masks))
    print("\nsymbols the game logic addresses by child name:")
    for k in ("FireBoy", "WaterGirl", "LeverMc", "FinishBoy", "FinishGirl"):
        if k in out:
            v = out[k]
            kids = ", ".join(c["name"] for c in v["children"]) or "-"
            print("  %-12s frames=%-4d children: %s" % (k, v["frames"], kids))
    print("\nwrote %s" % os.path.abspath(OUT))


if __name__ == "__main__":
    main()
