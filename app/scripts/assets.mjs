/**
 * Turn the extracted assets into the ones worth downloading.
 *
 * The extraction tools optimise for fidelity: JPEXS gives PNG frames and
 * decoded WAVs, and everything downstream was built against those. That is
 * right for a source of truth and wrong for a download -- 17 MB of PNG and
 * 1.9 MB of uncompressed audio, most of it avoidable.
 *
 * This runs at BUILD time and writes into `dist/`. Nothing in `extracted/`
 * changes, the dev server keeps serving the originals, and version control
 * keeps one copy of everything rather than two.
 *
 * Two transforms, both measured rather than assumed:
 *
 *   sprites   PNG -> WebP at quality 80, effort 4: 72-80% smaller on this art,
 *             from sweeping settings against the real files rather than
 *             reaching for a default. Flat cartoon shapes with large
 *             single-colour regions are close to the best case for WebP.
 *
 *             Effort 4 rather than 6 because 6 turned out to cost NINETEEN
 *             TIMES the encode time for 4% smaller files -- 9.0 s against
 *             0.48 s for two hundred frames on two lanes. That is 0.2 MB
 *             across the whole set, against seventeen minutes of a two-core
 *             CI runner. Nobody would take that trade knowingly; it was taken
 *             by leaving a default alone.
 *
 *   audio     `sounds/` already holds the ORIGINAL compressed streams JPEXS
 *             pulled out of the SWF; `sounds_wav/` holds them decoded, and the
 *             player has been fetching those. Preferring the original where one
 *             exists takes the 17 sounds the game uses from 1.90 MB to 0.34 MB
 *             with no encoder involved -- there is nothing to encode, the
 *             compressed bytes were in the SWF all along. Two sounds came from
 *             FLV and keep their decoded WAV, because no browser plays FLV.
 *
 * ## Why this is JavaScript and not Python
 *
 * It was Python first, using Pillow, sitting beside the extraction tools that
 * produced these files. That was the tidier home for it and it does not
 * survive contact with a deploy: Vercel's build image manages its Python with
 * `uv`, so `pip install` is refused outright under PEP 668, and the first
 * deployment died on the install step. The fixes available were all
 * environment-specific -- break the system packages, or build a virtualenv and
 * guess at its layout -- and each one is a thing that can differ on the next
 * image.
 *
 * `sharp` ships prebuilt binaries and installs with `npm ci`, so the build now
 * depends on exactly the toolchain the rest of the project already needs. The
 * golden-render test is what says the swap changed nothing: it compares all 32
 * levels against signatures recorded before any of this existed.
 */
import { readFile, writeFile, mkdir, readdir, stat, copyFile, rm } from
  "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const FROM = resolve(ROOT, "extracted/assets");
const TO = resolve(ROOT, "dist/extracted/assets");

const QUALITY = 80;
const EFFORT = 4;

/** Never shipped: 116 MB of JPEXS intermediates the rest was derived from. */
const SKIP_DIRS = new Set(["_raw"]);

/** Directories whose PNGs become WebP. Vectors and fonts gain nothing. */
const RASTER_DIRS = new Set(["sprites", "images"]);

/**
 * How many images to encode at once.
 *
 * The machine's own figure, not a guess: eight lanes on a two-core CI runner is
 * contention, and eight on a twenty-two core desktop is a quarter of the
 * machine idle.
 */
const LANES = Math.max(1, availableParallelism());

/** For each sound the game uses, the smallest file that will play. */
async function audioPlan() {
  const manifest = JSON.parse(
    await readFile(join(FROM, "sounds.json"), "utf8"));
  const plan = {};
  for (const [symbol, name] of Object.entries(manifest)) {
    const stem = name.replace(/\.[^.]+$/, "");
    let chosen = null;
    // MP3 and WAV both play everywhere. FLV plays nowhere, so a sound that came
    // from one has to keep its decoded copy.
    for (const ext of [".mp3", ".wav"]) {
      const candidate = join(FROM, "sounds", stem + ext);
      if (existsSync(candidate)) { chosen = [`sounds/${stem}${ext}`, candidate]; break; }
    }
    plan[symbol] = chosen ?? [`sounds_wav/${name}`, join(FROM, "sounds_wav", name)];
  }
  return plan;
}

/** Every file under `dir`, as paths relative to it. */
async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), base, out);
    } else {
      out.push(relative(base, join(dir, entry.name)));
    }
  }
  return out;
}

const size = async (p) => (await stat(p)).size;

await rm(TO, { recursive: true, force: true });

const plan = await audioPlan();
const files = await walk(FROM);

const convert = [];
const copy = [];
for (const rel of files) {
  const top = rel.split(sep)[0];
  // Audio is copied by the plan, not wholesale: the two sound directories hold
  // two copies of everything, and the game uses seventeen files out of either.
  if (top === "sounds" || top === "sounds_wav") continue;
  if (RASTER_DIRS.has(top) && rel.toLowerCase().endsWith(".png")) convert.push(rel);
  else copy.push(rel);
}

/**
 * Bytes in and bytes out.
 *
 * Written as `n = await size(p)` and THEN `before += n`, never
 * `before += await size(p)`. The second form reads the variable, suspends at
 * the await, and assigns the stale value back when it resumes -- so with eight
 * lanes running at once most of the additions are lost. It reported the
 * download as 33 MB when it was 42, which is the sort of wrong that gets
 * quoted in a README.
 */
let before = 0;
let after = 0;

for (const rel of copy) {
  const dst = join(TO, rel);
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(join(FROM, rel), dst);
  const n = await size(dst);
  before += n;
  after += n;
}

console.log(`converting ${convert.length} images to webp...`);
let next = 0;
await Promise.all(Array.from({ length: LANES }, async () => {
  for (;;) {
    const i = next++;
    if (i >= convert.length) return;
    const rel = convert[i];
    const src = join(FROM, rel);
    const dst = join(TO, rel.replace(/\.png$/i, ".webp"));
    await mkdir(dirname(dst), { recursive: true });
    const was = await size(src);
    before += was;
    try {
      await sharp(src).webp({ quality: QUALITY, effort: EFFORT }).toFile(dst);
      const now = await size(dst);
      after += now;
    } catch (e) {
      // A frame that will not convert is a frame that must still ship.
      const fallback = join(TO, rel);
      await copyFile(src, fallback);
      const kept = await size(fallback);
      after += kept;
      console.warn(`  kept ${rel} as png (${e.message})`);
    }
  }
}));

for (const [where, source] of Object.values(plan)) {
  const dst = join(TO, where);
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(source, dst);
  // Measured against the decoded WAV, which is what was being shipped before.
  const stem = where.split("/")[1].replace(/\.[^.]+$/, "");
  const wav = join(FROM, "sounds_wav", `${stem}.wav`);
  const wasAudio = await size(existsSync(wav) ? wav : source);
  const nowAudio = await size(dst);
  before += wasAudio;
  after += nowAudio;
}

// Say what was done in the DATA, so the engine reads the format rather than
// being told at the call site and having to be kept in step by hand.
const spritesPath = join(TO, "sprites.json");
const sprites = JSON.parse(await readFile(spritesPath, "utf8"));
sprites.raster = "webp";
await writeFile(spritesPath, JSON.stringify(sprites));

await writeFile(join(TO, "sounds.json"), JSON.stringify(
  Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v[0]])), null, 1));

console.log(
  `assets: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB ` +
  `(${Math.round(100 * (1 - after / before))}% smaller), ` +
  `${convert.length} converted, ${copy.length} copied`);
