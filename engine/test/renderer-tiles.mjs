/** Surface/LRU ownership and exact same-browser comparisons for nested masks. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startServer } from "./harness.mjs";
const server = await startServer(5196);
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("http://localhost:5196/");
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = c.height = 32;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#ff7700"; ctx.fillRect(0, 0, 32, 32);
    return c.toDataURL().split(",")[1];
  });
  await page.route("**/renderer-fixture/**", route => route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") }));
  await page.route("**/renderer-fixture/broken-atlas.png", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.route("**/renderer-fixture/deferred-art.png", async route => {
    await new Promise(resolve => setTimeout(resolve, 75));
    await route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") });
  });
  let recoveryRequests = 0;
  await page.route("**/renderer-fixture/sprites/77/1.png", route => ++recoveryRequests === 1
    ? route.fulfill({ status: 503, body: "retry" })
    : route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") }));
  const result = await page.evaluate(async () => {
    const [{ SpriteRenderer }, { ScratchPool, TileCache }, { imageAsset }, { VisualSnapshots }] = await Promise.all([
      import("/dist/render/sprites.js"), import("/dist/render/tiles.js"), import("/dist/render/assets.js"), import("/dist/render/interpolation.js"),
    ]);
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const pool = new ScratchPool(4096), a = pool.acquire(32, 32), b = pool.acquire(32, 32);
    check(a.canvas !== b.canvas, "nested leases must be exclusive"); a.release(); b.release();
    const c = pool.acquire(64, 64); c.release(); check(pool.pixels <= 4096, "released surface retention is bounded");
    const cache = new TileCache(4096);
    const tile = document.createElement("canvas"); tile.width = tile.height = 32;
    cache.set("pose1", { canvas: tile, rect: { x: 0, y: 0, w: 32, h: 32 }, dependencies: new Map([["art", 1]]) });
    check(!!cache.get("pose1", () => 1), "matching dependency reuses cache");
    check(!cache.get("pose1", () => 2), "changed dependency invalidates cache");
    cache.set("pose1", { canvas: tile, rect: { x: 0, y: 0, w: 32, h: 32 }, dependencies: new Map() });
    cache.set("pose2", { canvas: tile, rect: { x: 0, y: 0, w: 32, h: 32 }, dependencies: new Map() });
    check(cache.bytes <= 4096 && cache.evictions === 1, "pose LRU respects byte limit");

    const geom = () => ({ w: 32, h: 32, ox: 0, oy: 0, children: [] });
    const manifest = { byName: {}, sprites: { 1: { id: 1, frames: 2, geom: [geom(), geom()] }, 2: { id: 2, frames: 1, geom: [geom()] } } };
    const node = (props = {}) => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, alpha: 1, visible: true, rotation: 0, currentFrame: 1, children: [], ...props });
    const inner = node({ spriteId: 1, x: 11, y: 13, scaleX: -1.4, scaleY: 1.6 });
    inner.mask = node({ spriteId: 2, x: -20, y: 15, scaleX: 1.3, scaleY: 1.2, isMask: true });
    const outer = node({ spriteId: 1, x: 90, y: 95, rotation: 24, children: [inner] });
    outer.mask = node({ spriteId: 2, x: 70, y: 85, scaleX: 2.5, scaleY: 2.4, isMask: true });
    const ropeMask = node({ spriteId: 2, scaleX: 0.8, height: 19, isMask: true });
    const rope = node({ x: 250, y: 140, rotation: -37, spriteId: 1, scaleX: -1, children: [ropeMask] }); rope.__clipMask = ropeMask;
    const zero = node({ spriteId: 1, scaleX: 0, x: 330, y: 260 }); zero.mask = node({ spriteId: 2, x: 320, y: 250 });
    const character = node({ spriteId: 1, name: "pers1", x: 380, y: 210, filters: [{ color: 0x66ccff, blurX: 20, blurY: 20 }] });
    const root = node({ children: [outer, rope, zero, character] });
    const renderer = new SpriteRenderer(manifest, "/renderer-fixture"); await renderer.prepare(root);
    const draw = scale => {
      renderer.configureOutputScale(scale);
      const canvas = document.createElement("canvas"); canvas.width = 640 * scale; canvas.height = 480 * scale;
      renderer.draw(canvas.getContext("2d"), root);
      return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const comparisons = [];
    for (const scale of [0.5, 1, 2, 3]) {
      renderer.configureRasterOptimizations({ boundedMasks: true }); const bounded = draw(scale);
      renderer.configureRasterOptimizations({ boundedMasks: false }); const full = draw(scale);
      const mismatches = bounded.reduce((n, value, i) => n + (value !== full[i] ? 1 : 0), 0);
      const maxDelta = bounded.reduce((n, value, i) => Math.max(n, Math.abs(value - full[i])), 0);
      let premultipliedDelta = 0;
      for (let i = 0; i < bounded.length; i += 4) {
        premultipliedDelta = Math.max(premultipliedDelta, Math.abs(bounded[i + 3] - full[i + 3]));
        for (let c = 0; c < 3; c++) premultipliedDelta = Math.max(premultipliedDelta,
          Math.abs(bounded[i + c] * bounded[i + 3] - full[i + c] * full[i + 3]) / 255);
      }
      const differences = [];
      for (let i = 0; i < bounded.length && differences.length < 12; i += 4) if ([0, 1, 2, 3].some(c => bounded[i + c] !== full[i + c])) differences.push({ x: i / 4 % (640 * scale), y: Math.floor(i / 4 / (640 * scale)), a: [...bounded.slice(i, i + 4)], b: [...full.slice(i, i + 4)] });
      check(mismatches === 0, `bounded nested mask pixels differ at scale ${scale}: ${mismatches}, maxDelta ${maxDelta}, premultiplied ${premultipliedDelta}, differences ${JSON.stringify(differences)}`);
      comparisons.push({ scale, mismatches, maxDelta });
    }
    renderer.configureRasterOptimizations({ boundedMasks: true }); draw(1);
    character.currentFrame = 2; renderer.draw(document.createElement("canvas").getContext("2d"), root);
    character.currentFrame = 1; const hits = renderer.diagnostics().effectHits;
    const stage = document.createElement("canvas"); stage.width = 640; stage.height = 480;
    renderer.draw(stage.getContext("2d"), root);
    check(renderer.diagnostics().effectHits > hits, "revisited authored pose reuses effect");
    const beforeUnrelated = renderer.diagnostics();
    await imageAsset("/renderer-fixture/unrelated.png").ready;
    renderer.draw(stage.getContext("2d"), root);
    check(renderer.diagnostics().effectMisses === beforeUnrelated.effectMisses, "unrelated resource must not invalidate effects");
    const staticChild = node({ spriteId: 2, x: 7, y: 6, alpha: 0.8 });
    const staticRoot = node({ name: "GroundMask", x: 60, y: 40, children: [staticChild] });
    root.children.push(staticRoot);
    renderer.configureRasterOptimizations({ staticCommands: true }); renderer.draw(stage.getContext("2d"), root);
    stage.getContext("2d").clearRect(0, 0, 640, 480); renderer.draw(stage.getContext("2d"), root);
    const flat = stage.getContext("2d").getImageData(0, 0, 640, 480).data;
    check(renderer.diagnostics().staticHits > 0, "allowlisted static commands are reused");
    renderer.configureRasterOptimizations({ staticCommands: false }); stage.getContext("2d").clearRect(0, 0, 640, 480); renderer.draw(stage.getContext("2d"), root);
    const tree = stage.getContext("2d").getImageData(0, 0, 640, 480).data;
    check(flat.every((v, i) => v === tree[i]), "static commands preserve exact draw order and alpha");
    renderer.configureRasterOptimizations({ staticCommands: true }); staticChild.visible = false; stage.getContext("2d").clearRect(0, 0, 640, 480); renderer.draw(stage.getContext("2d"), root);
    check(stage.getContext("2d").getImageData(72, 52, 1, 1).data[3] === 0, "changed descendant visibility invalidates static commands");
    const samples = new VisualSnapshots({ localDescendantInterpolation: true });
    for (let i = 0; i < 80; i++) renderer.draw(stage.getContext("2d"), root, samples, i / 80, i);
    check(renderer.diagnostics().cacheBytes <= 16 * 1024 * 1024, "continuous samples stay bounded");
    const stats = renderer.diagnostics(); check(stats.maskPixels < stats.fullMaskPixels, "bounded masks reduce composited pixel area");
    renderer.dispose(); check(renderer.diagnostics().cacheBytes === 0 && renderer.diagnostics().scratchPixels === 0, "dispose releases raster resources");
    const atlasGeom = { ...geom(), source: { file: "broken-atlas.png", x: 0, y: 0, w: 32, h: 32 } };
    const fallback = new SpriteRenderer({ byName: {}, sprites: { 1: { id: 1, frames: 1, geom: [atlasGeom] } } }, "/renderer-fixture");
    const art = node({ spriteId: 1, x: 40, y: 40 }); await fallback.prepare(art);
    fallback.draw(stage.getContext("2d"), art);
    await imageAsset("/renderer-fixture/sprites/1/1.png").ready;
    stage.getContext("2d").clearRect(0, 0, 640, 480); fallback.draw(stage.getContext("2d"), art);
    check(stage.getContext("2d").getImageData(45, 45, 1, 1).data[3] === 255 && fallback.missing === 0, "failed atlas uses coherent individual-frame fallback");
    fallback.dispose();
    const deferredGeom = { ...geom(), source: { file: "deferred-art.png", x: 0, y: 0, w: 32, h: 32 } };
    const deferred = new SpriteRenderer({ byName: {}, sprites: { 1: { id: 1, frames: 1, geom: [deferredGeom] } } }, "/renderer-fixture");
    const deferredArt = node({ name: "pers1", spriteId: 1, x: 40, y: 40, filters: [{ blurX: 2, blurY: 2 }] });
    await deferred.prepare(deferredArt, false);
    const beforeReady = deferred.diagnostics().effectMisses;
    await imageAsset("/renderer-fixture/deferred-art.png").ready;
    stage.getContext("2d").clearRect(0, 0, 640, 480); deferred.draw(stage.getContext("2d"), deferredArt);
    check(deferred.diagnostics().effectMisses > beforeReady && stage.getContext("2d").getImageData(45, 45, 1, 1).data[3] === 255,
      "relevant delayed readiness invalidates an initially blank effect"); deferred.dispose();
    const recovery = new SpriteRenderer({ byName: {}, sprites: { 77: { id: 77, frames: 1, geom: [geom()] } } }, "/renderer-fixture");
    const recoveryArt = node({ name: "pers1", spriteId: 77, x: 40, y: 40, filters: [{ blurX: 2, blurY: 2 }] });
    await recovery.prepare(recoveryArt); check(recovery.missing === 1, "failed relevant art is reported");
    await recovery.prepare(recoveryArt); stage.getContext("2d").clearRect(0, 0, 640, 480); recovery.draw(stage.getContext("2d"), recoveryArt);
    check(recovery.missing === 0 && stage.getContext("2d").getImageData(45, 45, 1, 1).data[3] === 255,
      "explicit failed-resource retry replaces stale effect pixels"); recovery.dispose();
    const buttons = { buttons: { 9: { up: [], over: [], down: [], hit: [], hitBox: { x: 0, y: 0, w: 32, h: 32 } } }, parts: {} };
    const hitRenderer = new SpriteRenderer({ byName: {}, sprites: {} }, "/renderer-fixture", 640, 480, null, buttons);
    const control = node({ spriteId: 9, x: 80, y: 70, rotation: 17 }); const controls = node({ children: [control] });
    hitRenderer.draw(stage.getContext("2d"), controls); const centre = hitRenderer.buttonBoxes(controls)[0].centre;
    check(hitRenderer.hitTest(controls, ...centre) === control, "logical hit geometry reaches displayed control");
    hitRenderer.configureOutputScale(3); stage.width = 1920; stage.height = 1440;
    hitRenderer.draw(stage.getContext("2d"), controls); const sharpCentre = hitRenderer.buttonBoxes(controls)[0].centre;
    check(centre.every((v, i) => v === sharpCentre[i]) && hitRenderer.hitTest(controls, ...centre) === control, "output resolution preserves logical pointer geometry");
    hitRenderer.dispose();
    const structural = new SpriteRenderer(manifest, "/renderer-fixture");
    const sourceChild = node({ spriteId: 2, x: 10, y: 10 });
    const source = node({ name: "GroundMC", children: [sourceChild], filters: [{ blurX: 2, blurY: 2 }] });
    const bitmap = node({ x: 300, y: 200, bitmapData: { source, sourceMatrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } } });
    const bitmapRoot = node({ children: [bitmap] });
    const boundaries = new VisualSnapshots(); await structural.prepare(bitmapRoot);
    const paintBoundary = () => {
      structural.captureTransforms(bitmapRoot, boundaries, 0);
      stage.width = 640; stage.height = 480; structural.draw(stage.getContext("2d"), bitmapRoot, boundaries, 1);
    };
    paintBoundary(); check(stage.getContext("2d").getImageData(315, 215, 1, 1).data[3] === 255, "bitmap source is visible at initial boundary");
    const sourceMisses = structural.diagnostics().effectMisses;
    sourceChild.visible = false; paintBoundary();
    check(stage.getContext("2d").getImageData(315, 215, 1, 1).data[3] === 0 && structural.diagnostics().effectMisses > sourceMisses,
      "bitmap descendant visibility invalidates the observed boundary descriptor");
    const replacement = node({ spriteId: 2, x: 45, y: 10 }); source.children = [replacement]; paintBoundary();
    check(stage.getContext("2d").getImageData(315, 215, 1, 1).data[3] === 0 && stage.getContext("2d").getImageData(350, 215, 1, 1).data[3] === 255,
      "bitmap source structure replacement invalidates cached content");
    replacement.alpha = 0.5; paintBoundary();
    const filteredAlpha = stage.getContext("2d").getImageData(350, 215, 1, 1).data[3];
    check(filteredAlpha > 0 && filteredAlpha < 255,
      "bitmap descendant alpha updates at the next capture boundary"); structural.dispose();
    const terrainRenderer = new SpriteRenderer(manifest, "/renderer-fixture");
    const terrainMask = node({ name: "GroundMask", spriteId: 2, x: 55, y: 55, isMask: true });
    const terrain = node({ symbol: "texture1", spriteId: 2, x: 50, y: 50, scaleX: 2, scaleY: 2, mask: terrainMask });
    await terrainRenderer.prepare(terrain); stage.getContext("2d").clearRect(0, 0, 640, 480); terrainRenderer.draw(stage.getContext("2d"), terrain);
    check(stage.getContext("2d").getImageData(60, 60, 1, 1).data[3] === 255, "terrain mask starts at its authored parent-space transform");
    terrainMask.x = 78; stage.getContext("2d").clearRect(0, 0, 640, 480); terrainRenderer.draw(stage.getContext("2d"), terrain);
    check(stage.getContext("2d").getImageData(60, 60, 1, 1).data[3] === 0 && stage.getContext("2d").getImageData(85, 60, 1, 1).data[3] === 255,
      "changing the mask root transform invalidates cached terrain pixels"); terrainRenderer.dispose();
    return { comparisons, stats };
  });
  assert.equal(result.comparisons.length, 4); console.log(JSON.stringify(result));
} finally { await browser?.close(); server.kill(); }
