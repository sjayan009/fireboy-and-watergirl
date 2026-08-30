/**
 * Two real browser tabs, playing co-op.
 *
 * `nettest` proves the lockstep session against the engine over a simulated
 * link, in one process. This proves the other half: that the browser wiring is
 * right -- that a tab pairs with another over BroadcastChannel, that the
 * GameHost drives the real Game rather than a bare level, that local keys
 * become this player's three bits instead of being written straight into the
 * level, and that two independently rendering tabs stay bit-identical.
 *
 * Playwright's tabs are genuinely same-origin siblings, which the embedded
 * preview browser's panes are not, so BroadcastChannel actually delivers here.
 */
import { loadPlaywright, startServer } from "./harness.mjs";

const PORT = 5196;
const URL_ = `http://localhost:${PORT}/`;

const playwright = await loadPlaywright();
if (!playwright) process.exit(0);

const server = await startServer(PORT);

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` +
              (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

let browser;
try {
  browser = await playwright.chromium.launch();
} catch {
  console.log("chromium not installed -- skipping");
  server.kill();
  process.exit(0);
}

try {
  // One context, so the two pages are same-origin siblings and share a
  // BroadcastChannel exactly as two tabs of one browser would.
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  for (const p of [a, b]) {
    p.on("pageerror", (e) => {
      failures++;
      console.log("  FAIL page error: " + e.message);
    });
    await p.goto(URL_, { waitUntil: "load" });
    await p.waitForFunction("window.__debug && window.__debug.sprites",
                            null, { timeout: 30000 });
  }

  console.log("pairing");
  // Both click at once; the lower random id takes Fireboy.
  await Promise.all([
    a.click("#netplay"),
    b.click("#netplay"),
  ]);
  await Promise.all([a, b].map((p) => p.waitForFunction(
    "window.__debug.session !== null", null, { timeout: 15000 })));

  // From here the test is the only thing driving the clock. The page's own
  // rAF loop would otherwise keep stepping between an assertion and the
  // measurement that follows it, and two peers read a frame apart are
  // indistinguishable from two peers that have desynced.
  await Promise.all([a, b].map((p) =>
    p.evaluate(() => window.__debug.autoTick(false))));

  const slots = await Promise.all([a, b].map((p) =>
    p.evaluate(() => window.__debug.slot)));
  check("the two tabs took different roles",
        [...slots].sort().join(","), "0,1");

  // Let the Start command reach the follower.
  const pump = async (n) => {
    for (let i = 0; i < n; i++) {
      await Promise.all([a, b].map((p) =>
        p.evaluate(() => window.__debug.netTick(1))));
    }
  };
  const frames = () => Promise.all([a, b].map((p) =>
    p.evaluate(() => window.__debug.session.frame)));

  /**
   * Pump until both peers sit on the same frame.
   *
   * Lockstep does NOT keep them instantaneously equal: a peer may run up to
   * `delay + 1` frames ahead, because it already holds input for frames the
   * other has not consumed yet. They converge whenever the leader has to wait,
   * so nudging the laggard is all this takes -- and comparing digests is only
   * meaningful once they are on the same frame.
   */
  const align = async (limit = 200) => {
    for (let i = 0; i < limit; i++) {
      const [fa, fb] = await frames();
      if (fa === fb) return true;
      const behind = fa < fb ? a : b;
      await behind.evaluate(() => window.__debug.netTick(1));
    }
    return false;
  };

  /** Each peer's digest, computed now rather than read from a stale readout. */
  const digests = () => Promise.all([a, b].map((p) => p.evaluate(async () => {
    const { hashLevel } = await import("/dist/net/hash.js");
    return hashLevel(window.game.m_level);
  })));

  await pump(20);

  const started = await Promise.all([a, b].map((p) => p.evaluate(
    () => window.game.m_level ? window.game.m_level.CurrentMode : null)));
  check("both tabs started the same level", started, ["adventure", "adventure"]);

  console.log("\nplaying");
  // Whichever tab drew Fireboy holds right; the other holds left. The slot is
  // random, so the test has to ask rather than assume.
  const fireTab = slots[0] === 0 ? a : b;
  const waterTab = slots[0] === 0 ? b : a;
  await fireTab.evaluate(() => window.__debug.hold("ArrowRight", true));
  await waterTab.evaluate(() => window.__debug.hold("ArrowLeft", true));

  /**
   * Pump until both characters have actually set off, rather than for a fixed
   * count and a hope.
   *
   * A key is held at a TICK boundary here, but the session decides which frame
   * it lands on -- and a peer that stalls waiting for the other decides several
   * frames at once when it resumes. So the input log is not a function of the
   * number of pumps, and a fixed 300 was a test that usually worked. Waiting
   * for the state being asserted removes the timing from the question without
   * weakening the claim.
   */
  const positions = () => a.evaluate(() => {
    const lv = window.game.m_level;
    return [lv.pers1.GetPosition().x, lv.pers2.GetPosition().x];
  });
  let walked = false;
  for (let i = 0; i < 30 && !walked; i++) {
    await pump(40);
    const [fire, water] = await positions();
    walked = fire > 2.5 && water < 3.5;
  }
  await fireTab.evaluate(() => window.__debug.hold("ArrowRight", false));
  await waterTab.evaluate(() => window.__debug.hold("ArrowLeft", false));
  await pump(120);

  const aligned = await align();
  const [fa, fb] = await frames();
  const hashes = await digests();
  const state = await Promise.all([a, b].map((p) => p.evaluate(() => {
    const lv = window.game.m_level;
    return {
      desyncs: window.__debug.session.desyncs,
      fire: +lv.pers1.GetPosition().x.toFixed(4),
      water: +lv.pers2.GetPosition().x.toFixed(4),
    };
  })));

  console.log(`  A: frame ${fa} hash ${hashes[0]} ` +
              `fire ${state[0].fire} water ${state[0].water}`);
  console.log(`  B: frame ${fb} hash ${hashes[1]} ` +
              `fire ${state[1].fire} water ${state[1].water}`);

  check("the peers converge to the same frame", aligned, true);
  check("their simulations are identical there", hashes[0] === hashes[1], true);
  check("no desyncs", state[0].desyncs + state[1].desyncs, 0);
  // Each tab moved only its own character, which is the whole point of
  // splitting the six input bits between the two peers. They start at x = 2
  // and x = 4.
  check("Fireboy went right", state[0].fire > 2.5, true);
  check("Watergirl went left", state[0].water < 3.5, true);
  check("and both peers agree where they are",
        [state[0].fire, state[0].water], [state[1].fire, state[1].water]);

  console.log("\none tab presses P; both pause");
  // ONE peer sends it. The command rides the same channel as input and takes
  // effect on an agreed frame, so the other pauses without ever seeing the key.
  await b.evaluate(() => window.__debug.session.send(2 /* Command.Pause */));
  await pump(60);
  await align();
  const paused = await Promise.all([a, b].map((p) =>
    p.evaluate(() => window.game.m_level.pause)));
  check("both tabs are paused", paused, [true, true]);
  const after = await digests();
  check("and still in step", after[0] === after[1], true);
} finally {
  await browser.close();
  server.kill();
}

console.log("\n" + (failures === 0 ? "TWO-TAB NETPLAY PASSED"
                                   : `TWO-TAB NETPLAY FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
