"""Export the SWF library as per-frame art plus a manifest the renderer can use.

Two JPEXS passes, because each gives us something the other does not:

  * `sprite:png`  -- the pixels. Smaller than SVG here (34 MB vs 64 MB) because
    the art is dense vector work, and the game is a fixed 640x480 stage, so
    resolution independence buys nothing.
  * `sprite:svg`  -- the *structure*. Each frame's SVG records the registration
    offset (the root `<g transform>`) and, crucially, the placement matrix of
    every NAMED child instance (`<use id="mc_1" transform="...">`).

The named children matter because JPEXS bakes them into the composite frame,
while the game picks between them at runtime: FireBoy's five pose clips
`mc_1`..`mc_5` are all present in the exported image, but the game shows one by
toggling `visible`. Drawing the composite would render all five on top of each
other. So for any symbol with named children the renderer skips the composite
and draws the children itself, using the matrices recorded here.

Denylist notes:
  * DefineSprite_912 is the library container -- one instance of every symbol,
    placed off-stage purely to force export. Never rendered.
  * ag_intro_mc / AG_Teaser are the 2009 Armor Games intro, deliberately dropped.
  * LightMask is constructed and named in CreateGround and then never added to
    the display list. It is dead code in the original too, and it is the single
    heaviest sprite (434 frames, 8.9 MB), so skipping it is both faithful and
    a big saving.
"""
import json
import os
import re
import shutil
import subprocess
import sys

import text_masks as TM

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
SWF = os.path.join(ROOT, "Fireboy & Watergirl - The Forest Temple.swf")
OUT = os.path.join(ROOT, "extracted", "assets", "sprites")
MANIFEST = os.path.join(ROOT, "extracted", "assets", "sprites.json")

SKIP_NAMES = {
    "LightMask",        # created, named, never added to the display list
    "ag_intro_mc",      # Armor Games intro
    "AG_Teaser",
}
SKIP_IDS = {912}        # the force-export library container

RE_DIR = re.compile(r"^DefineSprite_(\d+)(?:_(.+))?$")
RE_SVG_SIZE = re.compile(r'<svg[^>]*height="([\d.]+)px"[^>]*width="([\d.]+)px"')
RE_ROOT_G = re.compile(
    r'<g transform="matrix\(([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+), '
    r'([-\d.]+), ([-\d.]+)\)"')
RE_USE = re.compile(
    r'<use\b[^>]*\bid="([^"]+)"[^>]*\btransform="matrix\('
    r'([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+)\)"[^>]*>')
RE_USE_CID = re.compile(r'ffdec:characterId="(\d+)"')
RE_G_MATRIX = re.compile(r'<g\b[^>]*\btransform="matrix\(')


def run_jpexs(ffdec, fmt, kind, outdir):
    if os.path.isdir(outdir) and os.listdir(outdir):
        print("  reusing existing export in %s" % outdir)
        return
    os.makedirs(outdir, exist_ok=True)
    print("  running JPEXS %s ..." % fmt)
    subprocess.run(
        ["java", "-jar", ffdec, "-format", fmt, "-export", kind, outdir, SWF],
        check=True, stdout=subprocess.DEVNULL)


def parse_svg_frame(path, base_out=None, wanted=None, text_masks=None):
    """Registration offset, size, and named child placements for one frame.

    `wanted` is the set of child names the SWF itself says this symbol has,
    from extract_symbols.py. It matters because JPEXS does not always put a
    named instance at the top level: `Connector` and `RopePulley` nest their
    `chain` one group deeper, so a strictly top-level scan missed it, the
    chain stayed baked into the composite at its authored length, and the
    rope never stretched when the game moved it.
    """
    txt = open(path, encoding="utf-8", errors="replace").read()
    size = RE_SVG_SIZE.search(txt)
    g = RE_ROOT_G.search(txt)
    w = float(size.group(2)) if size else 0.0
    h = float(size.group(1)) if size else 0.0
    ox = float(g.group(5)) if g else 0.0
    oy = float(g.group(6)) if g else 0.0

    # A top-level <use> is this sprite's own child. Deeper ones normally
    # belong to a referenced symbol and are already baked into its art --
    # EXCEPT when the SWF says this symbol really does have a child of that
    # name, which is what `wanted` settles. <defs> holds the shape library,
    # including nested instances that carry names of their own ("head" inside
    # the pose clips), so stop before it.
    body = txt[g.end():] if g else txt
    defs = body.find("<defs")
    if defs >= 0:
        body = body[:defs]
    stack = []
    kids = []
    spans = []
    offset = g.end() if g else 0
    for m in re.finditer(r"<g\b[^>]*>|</g>|<use\b[^>]*>", body):
        tok = m.group(0)
        if tok == "</g>":
            if stack:
                stack.pop()
            continue
        if tok.startswith("<g"):
            stack.append(RE_G_MATRIX.search(tok) is not None)
            continue
        um = RE_USE.match(tok)
        if not um:
            continue
        name = um.group(1)
        if stack:
            if not wanted or name not in wanted:
                continue
            # A transformed ancestor would mean this matrix is not in the
            # sprite's own space, and placing the child by it would be wrong.
            # Refuse rather than draw it somewhere plausible but incorrect.
            if any(stack):
                raise SystemExit(
                    "%s: child %r is nested under a transformed group; its "
                    "placement matrix is not in the sprite's coordinates"
                    % (os.path.basename(path), name))
        cid = RE_USE_CID.search(tok)
        kids.append({
            "name": name,
            "id": int(cid.group(1)) if cid else None,
            "m": [float(um.group(i)) for i in range(2, 8)],
        })
        spans.append((offset + m.start(), offset + m.end()))

    geom = {"w": w, "h": h, "ox": ox, "oy": oy, "children": kids}

    # The composite bakes the named children in, but the game controls them
    # (FireBoy shows one of five poses by toggling `visible`). Write a "base"
    # copy with those instances removed, so the renderer can draw the sprite's
    # OWN art -- the running body and legs, the platform plank -- and then the
    # children on top. Without this a running character is a floating head.
    if spans and base_out:
        stripped = []
        prev = 0
        for a, b in spans:
            stripped.append(txt[prev:a])
            prev = b
        stripped.append(txt[prev:])
        base = "".join(stripped)
        # JPEXS writes a text mask as its bounds rectangle; the PNG pass gets
        # it right, but this SVG is what the renderer draws. See text_masks.py.
        if text_masks:
            base, _ = TM.restore_text_masks(
                base, text_masks, os.path.join(ROOT, "extracted", "assets",
                                               "_raw", "text"))
        os.makedirs(os.path.dirname(base_out), exist_ok=True)
        with open(base_out, "w", encoding="utf-8") as fh:
            fh.write(base)
        geom["base"] = os.path.basename(base_out)
    return geom


def export_fonts(ffdec):
    """Export the 5 embedded fonts as TTF, keyed by character id.

    Keying by id rather than name is deliberate: characters 49 and 767 are
    different fonts (DefineFontName calls them "Trajan Pro Bold" and "Trajan
    Pro") but both carry the internal TTF name "Trajan Pro", so a name-keyed
    @font-face family would silently collide and the timer would render in the
    wrong weight.

    These are subsets containing only the glyphs the SWF used. Every field the
    game writes to holds digits, a colon or a space, all of which appear in the
    fields' own initial text, so the subsets cover what we draw.
    """
    raw = os.path.join(ROOT, "extracted", "assets", "_raw", "font")
    out = os.path.join(ROOT, "extracted", "assets", "fonts")
    run_jpexs(ffdec, "font:ttf", "font", raw)

    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out, exist_ok=True)

    index = {}
    for f in sorted(os.listdir(raw)):
        if not f.lower().endswith(".ttf"):
            continue
        stem = f[:-4]
        cid = stem.split("_", 1)[0]
        if not cid.isdigit():
            continue
        dest = cid + ".ttf"
        shutil.copyfile(os.path.join(raw, f), os.path.join(out, dest))
        index[cid] = {"file": dest, "name": stem.split("_", 1)[1]}

    with open(os.path.join(out, "fonts.json"), "w") as fh:
        json.dump(index, fh, indent=1, sort_keys=True)
    print("fonts exported   : %d" % len(index))


def export_button_parts(ffdec):
    """Export the characters a button places, and work out where it is clickable.

    Interactive buttons were out of scope at first, but a button is also art,
    and JPEXS exports DefineSprite -- a DefineButton2 is not one. Left alone,
    the intro menu draws its temple and its title and then nothing where "Play"
    and "Credits" should be.

    The characters are split between DefineShape (the plaques and the invisible
    hit areas) and DefineText (the baked labels), so both export kinds are
    needed and the results are pooled into one directory keyed by character id.
    Up, over and down all get files -- hover swaps in a different label on most
    buttons -- while hit shapes only need geometry, never pixels.

    The hit box is computed here rather than at runtime: each hit-state
    placement contributes its art's rectangle, transformed by its placement
    matrix, and the union of those is the button's clickable area in its own
    coordinates. An axis-aligned box is generous for the map's hexagonal nodes,
    but they sit far enough apart that it never matters, and the picker breaks
    a tie by taking the smallest box anyway.

    Runs extract_buttons.py first, since that is what says which characters
    matter and where they sit.
    """
    subprocess.run([sys.executable,
                    os.path.join(HERE, "extract_buttons.py")], check=True,
                   env={**os.environ, "FBWG_BUTTON_EXPORT": "1"})

    raw_shape = os.path.join(ROOT, "extracted", "assets", "_raw", "shape")
    raw_text = os.path.join(ROOT, "extracted", "assets", "_raw", "text")
    run_jpexs(ffdec, "shape:svg", "shape", raw_shape)
    run_jpexs(ffdec, "text:svg", "text", raw_text)

    out = os.path.join(ROOT, "extracted", "assets", "parts")
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out, exist_ok=True)

    manifest_path = os.path.join(ROOT, "extracted", "assets", "buttons.json")
    buttons = json.load(open(manifest_path))

    DRAWN = ("up", "over", "down")
    wanted = sorted({r["id"] for v in buttons.values()
                     for state in DRAWN + ("hit",) for r in v[state]})
    # A few button parts are DefineSprites rather than shapes or text -- the
    # pause tab's hover state places one. Those are already in the sprite
    # export, so the manifest records where each part's art actually lives
    # instead of the renderer having to guess.
    sprites = json.load(open(MANIFEST))["sprites"]

    geom = {}
    missing = []
    for cid in wanted:
        src = None
        for d in (raw_shape, raw_text):
            cand = os.path.join(d, "%d.svg" % cid)
            if os.path.exists(cand):
                src = cand
                break
        if src is None:
            sp = sprites.get(str(cid))
            if sp and sp["geom"]:
                g = sp["geom"][0]
                geom[str(cid)] = {"w": g["w"], "h": g["h"], "ox": g["ox"],
                                  "oy": g["oy"], "from": "sprite"}
            else:
                missing.append(cid)
            continue
        g = parse_svg_frame(src)
        geom[str(cid)] = {"w": g["w"], "h": g["h"], "ox": g["ox"], "oy": g["oy"],
                          "from": "part"}
        # Only the drawn states need a file on disk; hit shapes are invisible.
        if any(r["id"] == cid for v in buttons.values()
               for st in DRAWN for r in v[st]):
            shutil.copyfile(src, os.path.join(out, "%d.svg" % cid))


    def box(records):
        """AABB of the placed art, in the button's own coordinates."""
        x0 = y0 = float("inf")
        x1 = y1 = float("-inf")
        for r in records:
            g = geom.get(str(r["id"]))
            if not g:
                continue
            a, b, c, d, tx, ty = r["m"]
            # the art occupies [-ox, -oy] .. [-ox + w, -oy + h]
            lx, ly = -g["ox"], -g["oy"]
            for px, py in ((lx, ly), (lx + g["w"], ly),
                           (lx, ly + g["h"]), (lx + g["w"], ly + g["h"])):
                wx = a * px + c * py + tx
                wy = b * px + d * py + ty
                x0, y0 = min(x0, wx), min(y0, wy)
                x1, y1 = max(x1, wx), max(y1, wy)
        if x0 > x1:
            return None
        return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}

    unclickable = []
    for bid, v in buttons.items():
        # fall back to the drawn state for a button with no usable hit shapes
        v["hitBox"] = box(v["hit"]) or box(v["up"])
        if v["hitBox"] is None:
            unclickable.append(bid)

    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump({"buttons": buttons, "parts": geom}, fh,
                  indent=1, sort_keys=True)
    print("button parts     : %d of %d characters%s"
          % (len(geom), len(wanted),
             "" if not missing else " (missing %s)" % missing))
    print("button hit boxes : %d%s"
          % (len(buttons) - len(unclickable),
             "" if not unclickable else " (no box: %s)" % unclickable))


def export_sounds(ffdec):
    """Export every sound as WAV and map SWF class name -> file.

    The default `sound:mp3_wav_flv` export leaves Door_Sound and Wind_Sound as
    .flv, which browsers will not decode. Forcing `sound:wav` makes JPEXS
    decode them instead, so everything is playable without ffmpeg. These are
    short effects, so the size cost of uncompressed audio is acceptable.
    """
    raw = os.path.join(ROOT, "extracted", "assets", "_raw", "wav")
    out = os.path.join(ROOT, "extracted", "assets", "sounds_wav")
    run_jpexs(ffdec, "sound:wav", "sound", raw)

    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out, exist_ok=True)

    by_name = {}
    total = 0
    for f in sorted(os.listdir(raw)):
        if not f.lower().endswith(".wav"):
            continue
        shutil.copyfile(os.path.join(raw, f), os.path.join(out, f))
        total += os.path.getsize(os.path.join(out, f))
        # "904_Jump1_Sound.wav" -> Jump1_Sound
        stem = f[:-4]
        if "_" in stem and stem.split("_", 1)[0].isdigit():
            by_name[stem.split("_", 1)[1]] = f
    with open(os.path.join(ROOT, "extracted", "assets", "sounds.json"),
              "w") as fh:
        json.dump(by_name, fh, indent=1, sort_keys=True)
    print("sounds exported  : %d named, %.1f MB"
          % (len(by_name), total / 1048576))


def main():
    # FFDEC_DIR only. This used to fall back to the first ffdec-cli.jar a glob
    # found under $TEMP/claude, and $TEMP defaults to /tmp -- so on a shared
    # POSIX machine any other user could plant the jar this runs, with the
    # developer's access to .env.local and its database password.
    ffdec = None
    base = os.environ.get("FFDEC_DIR")
    if base and os.path.isfile(os.path.join(base, "ffdec-cli.jar")):
        ffdec = os.path.join(base, "ffdec-cli.jar")
    if not ffdec:
        sys.exit("ffdec-cli.jar not found; set FFDEC_DIR to the JPEXS folder")
    print("using %s" % ffdec)

    tmp = os.path.join(ROOT, "extracted", "assets", "_raw")
    png_dir = os.path.join(tmp, "png")
    svg_dir = os.path.join(tmp, "svg")
    run_jpexs(ffdec, "sprite:png", "sprite", png_dir)
    run_jpexs(ffdec, "sprite:svg", "sprite", svg_dir)
    # Needed before the sprites, not just for the buttons: the title's masks
    # are text, and their glyphs come from this export.
    run_jpexs(ffdec, "text:svg", "text", os.path.join(tmp, "text"))
    masks = TM.text_masks()

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT, exist_ok=True)

    manifest = {}
    by_name = {}
    skipped = []
    copied = total_bytes = 0

    # symbol name -> its named children, straight from the SWF's PlaceObject
    # tags rather than from the SVG export.
    syms_path = os.path.join(ROOT, "extracted", "symbols.json")
    swf_children = {}
    if os.path.exists(syms_path):
        swf_children = {k: {c["name"] for c in v["children"]}
                        for k, v in json.load(open(syms_path)).items()}

    for d in sorted(os.listdir(png_dir)):
        m = RE_DIR.match(d)
        if not m:
            continue
        cid = int(m.group(1))
        name = m.group(2)
        if cid in SKIP_IDS or (name and name in SKIP_NAMES):
            skipped.append(name or str(cid))
            continue

        frames = sorted(
            (int(f[:-4]) for f in os.listdir(os.path.join(png_dir, d))
             if f.endswith(".png")))
        if not frames:
            continue

        dest = os.path.join(OUT, str(cid))
        os.makedirs(dest, exist_ok=True)
        info = {"id": cid, "frames": len(frames), "geom": []}
        if name:
            info["name"] = name
            by_name[name] = cid
        # What the SWF itself says this symbol's named children are. JPEXS
        # sometimes nests one a group deeper than the rest, and this is how
        # parse_svg_frame knows such a <use> is a real child rather than part
        # of a referenced symbol.
        wanted = swf_children.get(name or "", set())

        for fr in frames:
            src = os.path.join(png_dir, d, "%d.png" % fr)
            dst = os.path.join(dest, "%d.png" % fr)
            shutil.copyfile(src, dst)
            total_bytes += os.path.getsize(dst)
            copied += 1
            svg = os.path.join(svg_dir, d, "%d.svg" % fr)
            base_out = os.path.join(dest, "%d_base.svg" % fr)
            info["geom"].append(parse_svg_frame(svg, base_out, wanted, masks)
                                if os.path.isfile(svg)
                                else {"w": 0, "h": 0, "ox": 0, "oy": 0,
                                      "children": []})
        manifest[str(cid)] = info

    with open(MANIFEST, "w") as f:
        json.dump({"byName": by_name, "sprites": manifest}, f)

    export_sounds(ffdec)
    export_fonts(ffdec)
    export_button_parts(ffdec)

    withkids = sum(1 for v in manifest.values()
                   if any(g["children"] for g in v["geom"]))
    print("\nsprites exported : %d (%d frames, %.1f MB)"
          % (len(manifest), copied, total_bytes / 1048576))
    print("with named kids  : %d (composite is skipped, children drawn)"
          % withkids)
    print("skipped          : %s" % ", ".join(sorted(skipped)))
    print("manifest         : %s" % os.path.abspath(MANIFEST))


if __name__ == "__main__":
    main()
