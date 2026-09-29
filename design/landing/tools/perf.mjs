// Load-performance check for a built or served page.
//   node design/landing/tools/perf.mjs [url]     default: the production preview on :5181
// Reports requests, bytes, LCP and CLS, unthrottled and on a throttled
// connection (10 Mbps down, 40 ms RTT, 4x CPU slowdown: a mid-range laptop).
// Each run is a new context with the cache disabled: a first visit.
import { chromium } from "playwright";
const URL_ = process.argv[2] ?? "http://localhost:5181/";
const b = await chromium.launch();
// Warm-up: the first page a freshly launched Chromium renders pays ~1.5 s of
// browser start-up (GPU and font initialisation) whatever the page is. Pay it
// here, in a throwaway context, so it is not reported as the page's cost.
{ const c = await b.newContext(); const w = await c.newPage(); await w.goto(URL_, { waitUntil: "load" }); await w.waitForTimeout(1500); await c.close(); }
for (const [label, net, cpu] of [["unthrottled", null, 1], ["10 Mbps · 40 ms · 4x CPU", { latency: 40, downloadThroughput: 10e6 / 8, uploadThroughput: 5e6 / 8 }, 4]]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (net) await cdp.send("Network.emulateNetworkConditions", { offline: false, ...net });
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  let bytes = 0, n = 0;
  cdp.on("Network.loadingFinished", (e) => { bytes += e.encodedDataLength; n++; });
  const t0 = Date.now();
  await p.goto(URL_, { waitUntil: "load" });
  const load = Date.now() - t0;
  await p.waitForTimeout(3000);
  const m = await p.evaluate(() => new Promise((ok) => {
    let lcp = 0, cls = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: "layout-shift", buffered: true });
    setTimeout(() => ok({ lcp: Math.round(lcp), cls: +cls.toFixed(3), fcp: Math.round(performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0) }), 200);
  }));
  console.log(label.padEnd(26), `requests ${n}`, `· ${(bytes / 1024).toFixed(0)} KB on the wire`, `· load ${load} ms`, `· FCP ${m.fcp} ms · LCP ${m.lcp} ms · CLS ${m.cls}`);
  await ctx.close();
}
await b.close();
