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
 * The digest is over the file list and sizes rather than the file contents:
 * this runs on every build, `extracted/assets` is 36 MB across three thousand
 * files, and reading all of it to notice that none of it changed is a cost
 * paid every time for a result that is almost always the same. Sizes catch
 * every real change the pipeline can make -- a re-export, a re-encode, an added
 * or removed frame, a manifest rewrite -- and the two manifests are hashed by
 * CONTENT as well, because they are small and are the one place where a
 * same-size edit is plausible.
 *
 * `FBWG_ASSET_RELEASE` overrides it, for a build that wants to force a fresh
 * URL without touching the assets.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/** Never shipped, so never part of the identity. */
const SKIP_DIRS = new Set(["_raw"]);

/** Small, and the files most likely to change without changing size. */
const BY_CONTENT = ["sprites.json", "sounds.json", "buttons.json",
                    "fonts/fonts.json"];

function walk(dir, base, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
         (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(p, base, out);
    } else {
      out.push([relative(base, p).split("\\").join("/"), statSync(p).size]);
    }
  }
  return out;
}

export function assetRelease(assetsDir) {
  const forced = process.env.FBWG_ASSET_RELEASE;
  if (forced) return forced.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "x";
  if (!existsSync(assetsDir)) return "none";

  const h = createHash("sha256");
  for (const [rel, size] of walk(assetsDir, assetsDir)) h.update(`${rel}:${size}\n`);
  for (const name of BY_CONTENT) {
    const p = join(assetsDir, name);
    if (existsSync(p)) h.update(createHash("sha256").update(readFileSync(p)).digest());
  }
  return h.digest("hex").slice(0, 12);
}
