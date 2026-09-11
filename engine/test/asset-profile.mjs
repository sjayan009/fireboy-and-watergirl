/** Cold image preparation and separate submitted-area diagnostic, no paid telemetry. */
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startServer } from "./harness.mjs";
const root = resolve(import.meta.dirname,"../..");
const server = await startServer(5192);
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route("http://localhost:5192/", route => route.fulfill({ contentType:"text/html",body:'<!doctype html><canvas width="640" height="480"></canvas>' }));
  await page.goto("http://localhost:5192/");
  const data = await page.evaluate(async () => {
    const [{ SpriteRenderer }, { Game }, { GameHost }] = await Promise.all([
      import("/dist/render/sprites.js"),import("/dist/game/game.js"),import("/dist/net/gamehost.js"),
    ]);
    const samples = [], decode = HTMLImageElement.prototype.decode;
    let active = 0, peakDecodePromises = 0;
    HTMLImageElement.prototype.decode = async function () {
      const t = performance.now(); active++; peakDecodePromises = Math.max(active,peakDecodePromises);
      try { return await decode.call(this); }
      finally { active--; samples.push(performance.now()-t); }
    };
    performance.setResourceTimingBufferSize(5000);
    performance.clearResourceTimings();
    const start = performance.now();
    const renderer = await SpriteRenderer.load("/extracted/assets");
    const game = new Game(), host = new GameHost(game);
    host.start("adventure",1);
    await renderer.prepare(game);
    const preparationMs = performance.now()-start;
    const resources = performance.getEntriesByType("resource").filter(r=>r.name.includes("/extracted/assets/"));
    HTMLImageElement.prototype.decode = decode;
    const quantiles = values => { const s = [...values].sort((a,b)=>a-b); const q = p => s.length ? s[Math.min(s.length-1,Math.ceil(s.length*p)-1)] : null; return {count:s.length,p50:q(.5),p95:q(.95),p99:q(.99),max:s.at(-1)??null}; };
    const ctx = document.querySelector("canvas").getContext("2d");
    // Warm immutable raster caches separately; this diagnostic is not a frame benchmark.
    renderer.draw(ctx,game); host.step(2,0);
    const original = CanvasRenderingContext2D.prototype.drawImage;
    let calls = 0, stageArea = 0, offscreenArea = 0;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      calls++;
      const image = args[0];
      const width = args.length === 9 ? args[7] : args.length === 5 ? args[3] : image.width;
      const height = args.length === 9 ? args[8] : args.length === 5 ? args[4] : image.height;
      const m = this.getTransform(), area = Math.abs(width*height*(m.a*m.d-m.b*m.c));
      if (this===ctx) stageArea+=area; else offscreenArea+=area;
      return original.apply(this,args);
    };
    renderer.draw(ctx,game);
    CanvasRenderingContext2D.prototype.drawImage = original;
    return {preparationMs,decodePromiseMs:quantiles(samples),peakDecodePromises,resourceDurationMs:quantiles(resources.map(r=>r.duration)),resourceRequests:resources.length,transferredBytes:resources.reduce((s,r)=>s+r.transferSize,0),missing:renderer.missing,submittedRectangles:{drawCalls:calls,stageAreaInScreens:stageArea/(640*480),offscreenAreaInScreens:offscreenArea/(640*480)}};
  });
  const result={recordedAt:new Date().toISOString(),browser:browser.version(),...data,scope:"Cold adventure1 source assets on local HTTP, headless Chromium. Decode promise latency includes scheduling, not isolated decoder CPU. Submitted rectangle areas include transparency and ignore clip bounds; not GPU fragment overdraw or VRAM. Separate from timed frame benchmark."};
  await writeFile(resolve(root,"benchmarks/assets.json"),JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify(result,null,2));
  if(data.missing) throw new Error("Missing art");
  if(data.peakDecodePromises>12) throw new Error("Image decode concurrency exceeded the existing 12-lane bound");
} finally { await browser?.close();server.kill(); }
