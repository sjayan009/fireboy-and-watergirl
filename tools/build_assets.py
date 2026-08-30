"""Turn the extracted assets into the ones worth downloading.

The extraction tools optimise for fidelity: JPEXS gives PNG frames and decoded
WAVs, and everything downstream was built against those. That is right for a
source of truth and wrong for a download -- 17 MB of PNG and 1.9 MB of
uncompressed audio, most of it avoidable.

This runs at BUILD time and writes to a separate directory. Nothing in
`extracted/` changes, the development server keeps serving the originals, and
version control keeps one copy of everything rather than two.

Two transforms, both measured rather than assumed:

  sprites   PNG -> WebP at quality 80, method 6: 72-80% smaller on this art,
            measured by sweeping settings against the real files rather than
            picking a default. Flat cartoon shapes with large single-colour
            regions are close to the best case for WebP.

  audio     `sounds/` already holds the ORIGINAL compressed streams JPEXS
            pulled out of the SWF; `sounds_wav/` holds them decoded, and the
            player has been fetching those. Preferring the original where one
            exists takes the 17 sounds the game uses from 1.90 MB to 0.34 MB
            with no encoder involved -- there is nothing to encode, the
            compressed bytes were in the SWF all along. Two sounds came from
            FLV and keep their decoded WAV, because no browser will play FLV.

The manifests are rewritten to say what was done, so the engine reads the
format out of the data rather than being told at the call site:
`sprites.json` gains `raster`, and `sounds.json`'s values become paths.

    python tools/build_assets.py extracted/assets app/dist/extracted/assets
"""
import io
import json
import os
import shutil
import sys
from concurrent.futures import ProcessPoolExecutor

from PIL import Image

# Quality 80 at method 6, chosen by sweeping both against this art rather than
# by reaching for a default: it takes 72-80% off, against 66-75% at the more
# cautious quality 88, and the golden-render test says the picture is unchanged.
# Method 6 is the slow search; the whole set still converts in about a minute,
# once, at build time.
QUALITY = 80
METHOD = 6

# Never shipped: 116 MB of JPEXS intermediates the rest was derived from.
SKIP_DIRS = {"_raw"}

# Directories whose PNGs become WebP. `fonts`, `shapes` and `parts` are vector
# or binary formats that WebP has nothing to offer.
RASTER_DIRS = {"sprites", "images"}


def convert(job):
    src, dst = job
    try:
        with Image.open(src) as im:
            im.convert("RGBA").save(dst, "WEBP", quality=QUALITY, method=METHOD)
        return os.path.getsize(src), os.path.getsize(dst)
    except Exception as e:                      # noqa: BLE001
        # A frame that will not convert is a frame that must still ship.
        shutil.copy2(src, dst[:-5] + ".png")
        print("  could not convert %s (%s); kept the PNG" % (src, e))
        return os.path.getsize(src), os.path.getsize(src)


def audio_plan(src_root):
    """For each sound the game uses, the smallest file that will play.

    Returns {manifest name: (source path, path to write under the assets base)}.
    """
    manifest = json.load(io.open(os.path.join(src_root, "sounds.json"),
                                 encoding="utf-8"))
    plan = {}
    for symbol, name in manifest.items():
        stem = os.path.splitext(name)[0]
        chosen = None
        # MP3 and WAV both play everywhere. FLV plays nowhere, so a sound that
        # came from one has to keep the decoded copy.
        for ext in (".mp3", ".wav"):
            candidate = os.path.join(src_root, "sounds", stem + ext)
            if os.path.exists(candidate):
                chosen = ("sounds/" + stem + ext, candidate)
                break
        if chosen is None:
            chosen = ("sounds_wav/" + name, os.path.join(src_root, "sounds_wav", name))
        plan[symbol] = chosen
    return plan


def main(src_root, dst_root):
    if not os.path.isdir(src_root):
        raise SystemExit("no such directory: " + src_root)
    if os.path.exists(dst_root):
        shutil.rmtree(dst_root)

    plan = audio_plan(src_root)
    keep_audio = {path for _, (path, _) in plan.items()}

    jobs = []
    copied = 0
    before = after = 0

    for dirpath, dirnames, filenames in os.walk(src_root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        rel = os.path.relpath(dirpath, src_root).replace("\\", "/")
        rel = "" if rel == "." else rel
        top = rel.split("/")[0] if rel else ""

        # Audio is copied by the plan, not wholesale: `sounds/` and
        # `sounds_wav/` between them hold two copies of everything, and the
        # game uses seventeen files out of either.
        if top in ("sounds", "sounds_wav"):
            continue

        os.makedirs(os.path.join(dst_root, rel), exist_ok=True)
        for name in filenames:
            src = os.path.join(dirpath, name)
            if top in RASTER_DIRS and name.lower().endswith(".png"):
                dst = os.path.join(dst_root, rel, name[:-4] + ".webp")
                jobs.append((src, dst))
            else:
                shutil.copy2(src, os.path.join(dst_root, rel, name))
                copied += 1
                before += os.path.getsize(src)
                after += os.path.getsize(src)

    print("converting %d images to webp..." % len(jobs))
    with ProcessPoolExecutor() as pool:
        for was, now in pool.map(convert, jobs, chunksize=32):
            before += was
            after += now

    for base, source in plan.values():
        dst = os.path.join(dst_root, base.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(source, dst)
        before += os.path.getsize(
            os.path.join(src_root, "sounds_wav",
                         os.path.basename(base).rsplit(".", 1)[0] + ".wav"))
        after += os.path.getsize(source)

    # Say what was done, in the data, so the engine reads it rather than being
    # told at the call site and having to be kept in step by hand.
    sprites_path = os.path.join(dst_root, "sprites.json")
    sprites = json.load(io.open(sprites_path, encoding="utf-8"))
    sprites["raster"] = "webp"
    io.open(sprites_path, "w", encoding="utf-8", newline="\n").write(
        json.dumps(sprites, separators=(",", ":")))

    sounds_path = os.path.join(dst_root, "sounds.json")
    io.open(sounds_path, "w", encoding="utf-8", newline="\n").write(
        json.dumps({k: v[0] for k, v in plan.items()}, indent=1))

    print("assets: %.1f MB -> %.1f MB (%.0f%% smaller), %d converted, %d copied"
          % (before / 1e6, after / 1e6, 100 * (1 - after / before),
             len(jobs), copied))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__.strip().splitlines()[-1].strip())
    main(sys.argv[1], sys.argv[2])
