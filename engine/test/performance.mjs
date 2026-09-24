/** Real browser benchmark. No accounts, remote telemetry, or simulated timing numbers. */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { cpus, platform, release } from "node:os";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { resolveUnder } from "../../safepath.mjs";

const root = resolve(import.meta.dirname, "../..");
const label = process.argv[2] ?? "after";
const engine = resolve(root, process.env.FBWG_BENCH_ENGINE ?? "engine/dist");
const assets = resolve(root, process.env.FBWG_BENCH_ASSETS ?? "extracted/assets");
const seconds = Number(process.env.FBWG_BENCH_SECONDS ?? 20);
// Position feedback keeps a slow baseline on the starting ledge. The legacy
// time-based pattern remains available to reproduce the original audit.
const steering = process.env.FBWG_BENCH_STEERING ?? "timed";
if (!["timed", "position"].includes(steering)) throw new Error("Unknown benchmark steering mode");
const presentation = {
  rollbackSmoothing: process.env.FBWG_BENCH_ROLLBACK_SMOOTHING === "1",
  localDescendantInterpolation: process.env.FBWG_BENCH_DESCENDANTS === "1",
};
const types = { ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".ttf": "font/ttf", ".mp3": "audio/mpeg", ".wav": "audio/wav" };
const server = createServer(async (req, res) => {
  if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end('<!doctype html><canvas id="stage" tabindex="0"></canvas>'); return; }
  const path = req.url.startsWith("/dist/") ? resolveUnder(engine, req.url.slice(5)) : req.url.startsWith("/assets/") ? resolveUnder(assets, req.url.slice(7)) : null;
  if (!path) { res.writeHead(404); res.end(); return; }
  try { res.setHeader("content-type", types[extname(path)] ?? "application/octet-stream"); res.end(await readFile(path)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({ args: ["--enable-precise-memory-info", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const preparation = await page.evaluate(async presentation => {
    const { GameView } = await import("/dist/embed.js");
    const { GameHost } = await import("/dist/net/gamehost.js");
    const { MemorySave } = await import("/dist/game/save.js");
    const started = performance.now();
    const view = new GameView({ canvas: document.querySelector("canvas"), assets: "/assets", save: new MemorySave(), ...presentation });
    view.setMuted(true);
    await view.prepare();
    view.setRunning(false);
    new GameHost(view.game).start("adventure", 1);
    await view.sprites.prepare(view.game);
    window.bench = { view };
    return { prepareMs: performance.now() - started, missing: view.sprites.missing };
  }, presentation);
  await page.waitForTimeout(1000);
  const before = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(m => [m.name, m.value]));
  const trace = [];
  cdp.on("Tracing.dataCollected", e => trace.push(...e.value));
  await cdp.send("Tracing.start", { categories: "devtools.timeline,v8", transferMode: "ReportEvents" });
  const result = await page.evaluate(async ({ duration, steering }) => {
    const { view } = window.bench;
    const raf = requestAnimationFrame.bind(window);
    const frame = [], render = [], input = [], nodes = [], calls = [], longTasks = [];
    const methodTimes = {};
    const originalRender = view.render.bind(view);
    let measuring = true, draws = 0, distinct = 0, lastSignature = null, signature = 0, drawCalls = 0, visits = 0;
    let pending = null, drawActive = false, inputEvents = 0, inputUnresolved = 0;
    let localVisualUpdates = 0, lastLocalX = NaN, lastLocalY = NaN;
    const images = new WeakMap(); let nextImage = 1;
    const methods = ["drawImage", "setTransform", "transform", "translate", "rotate", "scale", "fillText"];
    const proto = CanvasRenderingContext2D.prototype;
    const originals = {};
    // Hash actual canvas commands, including interpolated transforms, without GPU readback.
    for (const name of methods) {
      originals[name] = proto[name];
      proto[name] = function (...args) {
        if (drawActive) {
          if (name === "drawImage") drawCalls++;
          signature = Math.imul(signature ^ methods.indexOf(name), 16777619);
          for (const v of args) {
            let n = typeof v === "number" ? Math.round(v * 10000) : 0;
            if (typeof v === "object" && v !== null) { if (!images.has(v)) images.set(v, nextImage++); n = images.get(v); }
            if (typeof v === "string") for (let j = 0; j < v.length; j++) n = Math.imul(n ^ v.charCodeAt(j), 31);
            signature = Math.imul(signature ^ n, 16777619);
          }
        }
        return originals[name].apply(this, args);
      };
    }
    const originalNode = view.sprites.drawNode;
    view.sprites.drawNode = function (...args) { visits++; return originalNode.apply(this, args); };
    // These non-overlapping/partly nested costs are diagnostic; do not sum them.
    for (const name of ["childXform", "drawFiltered", "drawMasked", "drawText"]) {
      const original = view.sprites[name];
      if (!original) continue;
      methodTimes[name] = { count: 0, ms: 0 };
      view.sprites[name] = function (...args) {
        if (name === "drawFiltered" && args[1].name === "pers1") {
          const m = args[0].getTransform();
          if (m.e !== lastLocalX || m.f !== lastLocalY) localVisualUpdates++;
          lastLocalX = m.e; lastLocalY = m.f;
        }
        const t = performance.now(); const v = original.apply(this, args); methodTimes[name].count++; methodTimes[name].ms += performance.now() - t; return v;
      };
    }
    const find = (node, symbol) => node.symbol === symbol ? node : (node.children ?? []).map(c => find(c, symbol)).find(Boolean);
    const character = find(view.game, "FireBoy");
    const anchorX = character?.x ?? 0;
    view.render = function (...args) {
      const t = performance.now(); signature = 2166136261; drawCalls = 0; visits = 0; drawActive = true;
      originalRender(...args); drawActive = false;
      if (measuring) {
        render.push(performance.now() - t); calls.push(drawCalls); nodes.push(visits); draws++;
        if (signature !== lastSignature) distinct++;
        lastSignature = signature;
        // Event-to-rendered-response proxy. Physical scanout requires external equipment.
        if (pending && character && (character.x !== pending.x || character.y !== pending.y)) { input.push(performance.now() - pending.at); pending = null; }
      }
    };
    let observer;
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) { observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration))); observer.observe({ type: "longtask" }); }
    const started = performance.now(); let previous = null, phase = -1, held = "";
    view.setRunning(true);
    await new Promise(resolve => {
      const tick = now => {
        if (previous !== null) frame.push(now - previous); previous = now;
        // Alternate on a safe starting ledge, avoiding random gameplay/end screens.
        const next = Math.floor((now - started) / 120);
        if (next !== phase) {
          phase = next;
          if (held) dispatchEvent(new KeyboardEvent("keyup", { key: held, bubbles: true }));
          held = steering === "position"
            ? (character && character.x > anchorX + 8 ? "ArrowLeft" : "ArrowRight")
            : (phase % 2 ? "ArrowLeft" : "ArrowRight");
          if (character) { inputEvents++; if (pending) inputUnresolved++; pending = { at: performance.now(), x: character.x, y: character.y }; }
          dispatchEvent(new KeyboardEvent("keydown", { key: held, bubbles: true }));
        }
        if (now - started < duration * 1000) raf(tick); else resolve();
      };
      raf(tick);
    });
    const elapsed = (performance.now() - started) / 1000;
    measuring = false;
    dispatchEvent(new KeyboardEvent("keyup", { key: held, bubbles: true }));
    observer?.disconnect();
    const quantiles = list => { const s = [...list].sort((a,b)=>a-b); const p = n => s.length ? s[Math.min(s.length - 1, Math.ceil(n * s.length) - 1)] : null; return { n: s.length, p50: p(.5), p95: p(.95), p99: p(.99), max: s.at(-1) ?? null }; };
    const result = { elapsed, frameMs: quantiles(frame), renderMs: quantiles(render), inputToRenderMs: quantiles(input), inputEvents, inputUnresolved: inputUnresolved + (pending ? 1 : 0), renderCallsPerSecond: draws / elapsed, distinctVisualUpdatesPerSecond: distinct / elapsed, localPositionUpdatesPerSecond: localVisualUpdates / elapsed, drawCalls: quantiles(calls), traversalNodes: quantiles(nodes), mainThreadLongTasksMs: quantiles(longTasks), methodTimes, simFrames: view.simFrame, digest: view.digest(), levelEnded: view.level?.ended, session: view.session ? { rollbacks: view.session.rollbacks, stalls: view.session.stalls } : null, heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null };
    view.destroy();
    return result;
  }, { duration: seconds, steering });
  const completed = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end"); await completed;
  const after = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(m => [m.name, m.value]));
  const gcEvents = trace.filter(e => e.ph === "X" && /^(MajorGC|MinorGC)$/.test(e.name));
  const output = { label, recordedAt: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), environment: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, node: process.version, browser: browser.version(), headless: true, engine, assets }, preparation, ...result, taskCpuPercent: 100 * (after.TaskDuration - before.TaskDuration) / (after.Timestamp - before.Timestamp), gc: { count: gcEvents.length, totalMs: gcEvents.reduce((s,e)=>s+(e.dur ?? 0)/1000,0), maxMs: Math.max(0,...gcEvents.map(e=>(e.dur ?? 0)/1000)) }, errors, limitations: ["Native headless rAF cadence, not a physical high-refresh monitor", "Input-to-render callback proxy excludes OS input and display scanout", "Unresolved inputs include events replaced before movement or blocked by collision; reported separately", "Canvas instrumentation and trace overhead included equally in both variants", "GC trace durations are collector activity, not necessarily all stop-the-world time", "CPU is Chromium TaskDuration/wall time including measurement setup/teardown; no process RSS meter", "Solo renderer workload; network results are separate"] };
  output.steering = steering;
  output.presentation = presentation;
  await mkdir(resolve(root,"benchmarks"),{recursive:true});
  await writeFile(resolve(root,"benchmarks",`${label}.json`),JSON.stringify(output,null,2)+"\n");
  console.log(JSON.stringify(output,null,2));
  if (errors.length || preparation.missing || !result.renderMs.n || result.levelEnded) process.exitCode = 1;
} finally { await browser?.close(); server.close(); }
