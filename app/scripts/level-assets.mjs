/** Offline constructor oracle. No physics level is constructed by browser asset preparation. */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, access } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export const LEVEL_SCHEMA = 1;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sorted = values => [...new Set(values)].sort();

export function symbolResources(manifest, buttons, ids) {
  const files = new Set(), seen = new Set();
  const visit = id => {
    if (id == null || seen.has(id)) return;
    seen.add(id);
    const button = buttons.buttons[String(id)];
    if (button) {
      for (const state of ["up", "over", "down"]) for (const part of button[state] ?? []) {
        const g = buttons.parts[String(part.id)];
        if (!g) throw new Error(`Missing button part ${part.id}`);
        files.add(g.from === "sprite" ? `sprites/${part.id}/1.${manifest.raster ?? "png"}` : `parts/${part.id}.svg`);
      }
      return;
    }
    const sprite = manifest.sprites[String(id)];
    if (!sprite) return;
    for (let frame = 1; frame <= sprite.frames; frame++) {
      const g = sprite.geom[frame - 1];
      if (!g) throw new Error(`Missing geometry ${id}/${frame}`);
      files.add(g.source?.file ?? `sprites/${id}/${g.children.length ? g.base ?? `${frame}_base.svg` : `${frame}.${manifest.raster ?? "png"}`}`);
      for (const child of g.children) visit(child.id);
    }
  };
  for (const id of ids) visit(id);
  return sorted(files);
}

/** Traverse all authored states, including masks/hidden pose clips and rasterized terrain. */
export function displaySymbols(root, manifest) {
  const ids = new Set(), seen = new Set();
  const visit = node => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    const id = node.spriteId ?? manifest.byName[node.symbol];
    if (id != null) ids.add(id);
    for (const child of node.children ?? []) visit(child);
    visit(node.mask); visit(node.__clipMask); visit(node.bitmapData?.source);
  };
  visit(root);
  return [...ids].sort((a, b) => a - b);
}

export async function generateLevelAssets({ assets = join(ROOT, "extracted/assets"), output, verify = true } = {}) {
  const manifest = JSON.parse(await readFile(join(assets, "sprites.json"), "utf8"));
  delete manifest.levelDependencies;
  const buttons = JSON.parse(await readFile(join(assets, "buttons.json"), "utf8"));
  const { level } = await import(pathToFileURL(join(ROOT, "engine/dist/game/game.js")).href);
  const characters = ["FireBoy", "WaterGirl", "deadFire", "FireBoystairs", "WaterGirlStairs", "PauseMenu"]
    .map(name => manifest.byName[name]);
  const late = ["deadFire", "FireBoystairs", "WaterGirlStairs", "PauseMenu", "GameOvero", "Recuento"]
    .map(name => manifest.byName[name]);
  const common = symbolResources(manifest, buttons, characters);
  const fallbacks = {};
  for (const sprite of Object.values(manifest.sprites)) for (let frame = 1; frame <= sprite.frames; frame++) {
    const source = sprite.geom[frame - 1].source;
    if (source) (fallbacks[source.file] ??= []).push(`sprites/${sprite.id}/${frame}.${manifest.raster ?? "png"}`);
  }
  for (const file of Object.keys(fallbacks)) fallbacks[file] = sorted(fallbacks[file]);
  const later = symbolResources(manifest, buttons, late).filter(file => !common.includes(file));
  const levels = {};
  for (const file of (await readdir(join(ROOT, "extracted/levels"))).sort()) {
    if (!file.endsWith(".json") || file.startsWith("test-")) continue;
    const key = file.slice(0, -5), cut = key.lastIndexOf("-");
    const mode = key.slice(0, cut), num = Number(key.slice(cut + 1));
    const scene = new level(mode, num);
    const ids = displaySymbols(scene, manifest);
    const critical = symbolResources(manifest, buttons, ids).filter(file => !common.includes(file));
    // Runtime-only shell overlays are outside the level graph; include their complete families explicitly.
    levels[key] = { symbols: ids, critical, background: later.filter(file => !critical.includes(file)) };
  }
  if (Object.keys(levels).length !== 32) throw new Error("Expected exactly 32 authored levels");
  const source = createHash("sha256").update(JSON.stringify({ schema: LEVEL_SCHEMA, manifest, buttons, levels, common }));
  for (const file of ["engine/src/game/game.ts", "engine/src/flash/symbols.ts", "app/scripts/level-assets.mjs"]) {
    source.update(await readFile(join(ROOT, file)));
  }
  const result = { schema: LEVEL_SCHEMA, identity: source.digest("hex"), common: { critical: common }, fallbacks, levels };
  if (verify) {
    const required = sorted([...common, ...later, ...Object.values(levels).flatMap(value => value.critical), ...Object.values(fallbacks).flat()]);
    for (const file of required) {
      try { await access(join(assets, file)); }
      catch (error) { throw new Error(`Dependency does not exist: ${file}`, { cause: error }); }
    }
  }
  if (output) await writeFile(output, JSON.stringify(result));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await generateLevelAssets({ output: join(ROOT, "extracted/assets/levels.json") });
  console.log(`level dependencies: ${Object.keys(result.levels).length} levels, ${result.common.critical.length} shared critical resources`);
}
