/**
 * A name for the version of the extracted assets, derived from the assets.
 *
 * The deployment serves `/extracted/assets/*` with a one-year `immutable`
 * cache policy, and the names under it are stable: `sprites.json` is
 * `sprites.json` in every release. Those two together are a promise the build
 * cannot keep -- change what a sprite looks like, or which compressed original
 * a sound is taken from, and a returning browser goes on using last year's
 * bytes for a year, with a new bundle on top of them. The bundle being
 * content-hashed does not help; it references the same stable paths.
 *
 * So the identity of the assets is put IN the URL, as `?v=<digest>`. A cache
 * entry is keyed by the whole URL, so a release whose assets differ asks a
 * different question and gets a different answer, and `immutable` becomes true
 * rather than merely convenient.
 *
 * Every shipped source byte and the encoder/layout/generator settings participate
 * in identity. Same-size edits must invalidate browser and conversion caches too.
 *
 * `FBWG_ASSET_RELEASE` overrides it, for a build that wants to force a fresh
 * URL without touching the assets.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/** Never shipped, so never part of the identity. */
const SKIP_DIRS = new Set(["_raw"]);

const HERE = dirname(fileURLToPath(import.meta.url));
export const ASSET_PIPELINE = "webp-q80-e4;atlas-lossless-exact-1024-padding2;level-schema1;pipeline2";

function walk(dir, base, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
         (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(p, base, out);
    } else {
      out.push([relative(base, p).split("\\").join("/"), p]);
    }
  }
  return out;
}

export function assetRelease(assetsDir) {
  const forced = process.env.FBWG_ASSET_RELEASE;
  if (forced) return forced.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "x";
  if (!existsSync(assetsDir)) return "none";

  const h = createHash("sha256").update(ASSET_PIPELINE).update(`atlas-enabled=${process.env.FBWG_CHARACTER_ATLAS === "1"}`);
  // The same source/settings can encode differently after a native codec upgrade.
  h.update(JSON.stringify(Object.entries(sharp.versions).sort(([a], [b]) => a.localeCompare(b))));
  for (const [rel, path] of walk(assetsDir, assetsDir)) {
    h.update(`${rel}\0`).update(createHash("sha256").update(readFileSync(path)).digest());
  }
  for (const name of ["assets.mjs", "atlas.mjs", "level-assets.mjs"]) {
    const path = join(HERE, name);
    if (existsSync(path)) h.update(name).update(readFileSync(path));
  }
  return h.digest("hex").slice(0, 20);
}
