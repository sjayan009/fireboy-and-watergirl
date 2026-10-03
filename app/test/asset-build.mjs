/** Source/packaged dependency coverage, deterministic packing, exact atlas pixels and release identity. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { assetRelease } from "../scripts/release.mjs";
import { generateLevelAssets, displaySymbols, symbolResources } from "../scripts/level-assets.mjs";
import { packFrames, ATLAS_EDGE, ATLAS_PAD } from "../scripts/atlas.mjs";
import { level } from "../../engine/dist/game/game.js";
import { hostLevel } from "../../engine/dist/game/headless.js";
import { Event, advanceTree } from "../../engine/dist/flash/flash.js";

const root = resolve(import.meta.dirname, "../.."), source = join(root, "extracted/assets"), packaged = join(root, "dist/extracted/assets");
const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const sourceManifest = await generateLevelAssets();
assert.equal(Object.keys(sourceManifest.levels).length, 32);
assert.deepEqual(await generateLevelAssets(), sourceManifest);
const sprites = await readJson(join(source, "sprites.json")), buttons = await readJson(join(source, "buttons.json"));
const dynamicFamilies = ["FireBoy", "WaterGirl", "deadFire", "FireBoystairs", "WaterGirlStairs", "PauseMenu"];
for (const file of symbolResources(sprites, buttons, dynamicFamilies.map(name => sprites.byName[name]))) {
  assert.ok(sourceManifest.common.critical.includes(file), `Immediate dynamic pose/control ${file} must be critical`);
}
let oracleResources = 0;
for (const [key, entry] of Object.entries(sourceManifest.levels)) {
  const cut = key.lastIndexOf("-"), scene = new level(key.slice(0, cut), Number(key.slice(cut + 1)));
  hostLevel(scene);
  const expected = new Set([...sourceManifest.common.critical, ...entry.critical, ...entry.background]);
  for (let step = 0; step < 160; step++) {
    if (step) { advanceTree(scene); scene.Update(new Event(Event.ENTER_FRAME)); }
    scene.r_pressed = step < 60; scene.u_pressed = step >= 30 && step < 80;
    scene.l_pressed2 = step < 60; scene.u_pressed2 = step >= 50 && step < 90;
    const resources = symbolResources(sprites, buttons, displaySymbols(scene, sprites));
    oracleResources += resources.length;
    for (const file of resources) assert.ok(expected.has(file), `${key} runtime discovery absent: ${file}`);
  }
}
const fixture = join(root, ".cache/asset-release-fixture");
assert.ok(fixture.startsWith(join(root, ".cache") + "\\") || fixture.startsWith(join(root, ".cache") + "/"));
await mkdir(fixture, { recursive: true });
try {
  await writeFile(join(fixture, "same-size.png"), "abc");
  const before = assetRelease(fixture);
  await writeFile(join(fixture, "same-size.png"), "abd");
  assert.notEqual(assetRelease(fixture), before, "Same-size content edits must invalidate releases");
  assert.equal(assetRelease(fixture), assetRelease(fixture));
  const codec = sharp.versions.webp;
  const sameSource = assetRelease(fixture);
  try {
    sharp.versions.webp = codec + "-fixture";
    assert.notEqual(assetRelease(fixture), sameSource, "Encoder version changes must invalidate releases");
  } finally { sharp.versions.webp = codec; }
} finally { await rm(fixture, { recursive: true, force: true }); }
const frames = [{ id: 1, w: 120, h: 100 }, { id: 2, w: 120, h: 100 }, { id: 3, w: 120, h: 100 }];
assert.deepEqual(packFrames(frames, 256, 2), packFrames(frames, 256, 2));
for (const page of packFrames(frames, 256, 2)) {
  assert.ok(page.w <= 256 && page.h <= 256);
  for (const frame of page.frames) assert.ok(frame.x >= 2 && frame.y >= 2);
}

const finalSprites = await readJson(join(packaged, "sprites.json")), finalLevels = await readJson(join(packaged, "levels.json"));
assert.equal(finalSprites.levelDependencies, finalLevels.identity);
assert.deepEqual(await generateLevelAssets({ assets: packaged }), finalLevels);
let atlasFrames = 0, decodedIndividual = 0, decodedAtlas = 0, sourceBytes = 0;
for (const page of finalSprites.atlas.pages) {
  assert.ok(page.w <= ATLAS_EDGE && page.h <= ATLAS_EDGE); decodedAtlas += page.w * page.h * 4;
}
for (const descriptor of finalSprites.atlas.frames) {
  const sprite = finalSprites.sprites[String(descriptor.id)], f = descriptor.frame;
  const sourceRect = descriptor.source;
  atlasFrames++;
  const path = join(source, `sprites/${sprite.id}/${f}.png`);
  const original = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const extracted = await sharp(join(packaged, sourceRect.file)).extract({ left: sourceRect.x, top: sourceRect.y, width: sourceRect.w, height: sourceRect.h }).ensureAlpha().raw().toBuffer();
  assert.equal(sourceRect.w, original.info.width); assert.equal(sourceRect.h, original.info.height);
  assert.equal(extracted.equals(original.data), true, `Atlas crop ${sprite.id}/${f} preserves exact authored pixels`);
  const edge = await sharp(join(packaged, sourceRect.file)).extract({ left: sourceRect.x - 1, top: sourceRect.y, width: 1, height: sourceRect.h }).ensureAlpha().raw().toBuffer();
  const first = await sharp(path).extract({ left: 0, top: 0, width: 1, height: sourceRect.h }).ensureAlpha().raw().toBuffer();
  assert.equal(edge.equals(first), true, `Extruded edge ${sprite.id}/${f}`);
  assert.ok(sourceRect.x >= ATLAS_PAD && sourceRect.y >= ATLAS_PAD);
  decodedIndividual += sourceRect.w * sourceRect.h * 4; sourceBytes += (await readFile(path)).length;
  await readFile(join(packaged, `sprites/${sprite.id}/${f}.webp`)); // fallback stays shipped
}
assert.ok(atlasFrames > 1);
const integrity = await readJson(join(packaged, "asset-integrity.json"));
for (const [file, digest] of Object.entries(integrity.files)) {
  assert.equal(createHash("sha256").update(await readFile(join(packaged, file))).digest("hex"), digest, `Incomplete release file ${file}`);
}
assert.ok((await readdir(join(packaged, "atlases"))).length > 0);
console.log("ALL32 DEPENDENCY ORACLE, SAME-SIZE RELEASE MUTATION, ATLAS PIXELS/EXTRUSION, FALLBACK AND INTEGRITY PASSED", {
  oracleResources, atlasFrames, atlasPages: finalSprites.atlas.pages.length, sourceBytes,
  atlasBytes: finalSprites.atlas.pages.reduce((n, page) => n + page.bytes, 0), decodedIndividual, decodedAtlas,
});
