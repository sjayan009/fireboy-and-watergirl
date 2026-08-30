/**
 * Put the art and audio into the build output, smaller than they arrived.
 *
 * They live at the repo root because they are the game's, not the app's, and
 * they are 42 MB as extracted -- far too much to sit in `public/` and be
 * re-copied on every dev server start. The dev server reads them where they
 * are; this transforms them into `dist/` once, at build time.
 *
 * The transform itself is `tools/build_assets.py`, beside the extraction tools
 * that produced these files, and for the same reason: it is image and audio
 * work, Pillow is already a dependency of that toolchain, and doing it here
 * would mean adding a native npm package to a project that has none.
 *
 * `_raw/` is excluded and must stay excluded: it is 116 MB of JPEXS
 * intermediates that the shipped assets were derived from.
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EOL } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const FROM = resolve(ROOT, "extracted/assets");
const TO = resolve(HERE, "../dist/extracted/assets");

// `python` on Windows, `python3` most other places. Try both rather than
// making the build depend on which one somebody happens to have.
let ran = null;
for (const exe of ["python", "python3"]) {
  const r = spawnSync(exe, [resolve(ROOT, "tools/build_assets.py"), FROM, TO],
                      { stdio: "inherit" });
  if (r.error === undefined && r.status !== null) { ran = r; break; }
}

if (!ran) {
  console.error([
    "No python on PATH, so the assets cannot be built.",
    "  Install Python 3 and `pip install pillow`.",
    "This deliberately fails rather than copying the PNGs across: that",
    "would produce a working build with three times the download, and",
    "nothing downstream would notice.",
  ].join(EOL));
  process.exit(1);
}
if (ran.status !== 0) process.exit(ran.status);
