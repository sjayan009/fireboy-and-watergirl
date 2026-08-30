/**
 * Cross-engine determinism: the same 600-frame input log must produce the same
 * state digest in V8, SpiderMonkey and JavaScriptCore.
 *
 * Node's own determinism test proves the simulation is a pure function of
 * (level, input log) *on V8*. That is not the property lockstep netcode needs:
 * two players are on two different browsers, and ECMAScript leaves several
 * Math functions implementation-approximated, so a last-ulp disagreement is a
 * real possibility rather than a theoretical one. This test is what makes the
 * claim testable instead of hopeful.
 *
 * WebKit here is Playwright's build, which uses JavaScriptCore -- the same
 * engine Safari uses, though not literally Safari on macOS.
 *
 * Skips (exit 0) when Playwright or its browsers are not installed, so a fresh
 * checkout can still run `npm test` without a 500 MB download.
 */
import { loadPlaywright, startServer } from "./harness.mjs";

const PORT = 5199;
const URL_ = `http://localhost:${PORT}/crossengine.html`;
const REFERENCE = "aba863c1";

const playwright = await loadPlaywright();
if (!playwright) process.exit(0);

const server = await startServer(PORT);

const results = {};
let failed = false;
try {
  for (const name of ["chromium", "firefox", "webkit"]) {
    let browser;
    try {
      browser = await playwright[name].launch();
    } catch (e) {
      console.log(`  ${name.padEnd(9)}: not installed -- skipped`);
      continue;
    }
    try {
      const page = await browser.newPage();
      await page.goto(URL_, { waitUntil: "load" });
      await page.waitForFunction("window.__result !== undefined",
                                 null, { timeout: 60000 });
      const r = await page.evaluate("window.__result");
      if (r.error) throw new Error(r.error);
      results[name] = r;
      const ok = r.hash === REFERENCE;
      if (!ok) failed = true;
      console.log(`  ${name.padEnd(9)}: ${r.hash} over ${r.frames} frames ` +
                  (ok ? "ok" : `EXPECTED ${REFERENCE}`));
    } finally {
      await browser.close();
    }
  }
} finally {
  server.kill();
}

const engines = Object.keys(results);
if (engines.length === 0) {
  console.log("no browser engines available -- skipping");
  process.exit(0);
}
if (engines.length < 3) {
  console.log(`only ${engines.length} of 3 engines available`);
}

// Where they disagree matters more than that they disagree: report the first
// checkpoint that diverges and the raw positions, so the next step is obvious.
const base = results[engines[0]];
for (const e of engines.slice(1)) {
  const r = results[e];
  for (const f of Object.keys(base.checkpoints)) {
    if (base.checkpoints[f] !== r.checkpoints[f]) {
      failed = true;
      console.log(`  first divergence ${engines[0]} vs ${e} at frame ${f}: ` +
                  `${base.checkpoints[f]} != ${r.checkpoints[f]}`);
      console.log(`    ${engines[0]} fire ${base.fire}  water ${base.water}`);
      console.log(`    ${e} fire ${r.fire}  water ${r.water}`);
      break;
    }
  }
}

console.log("\n" + (failed ? "CROSS-ENGINE FAILED" : "CROSS-ENGINE PASSED"));
process.exit(failed ? 1 : 0);
