/**
 * A real WebRTC data channel, carrying a real game.
 *
 * `twotabs` proves the netcode over BroadcastChannel, which is a message bus
 * with none of a network's behaviour. This proves the transport people will
 * actually use: two tabs negotiate SDP and ICE, open an unreliable unordered
 * RTCDataChannel, and play a level over it.
 *
 * Chromium in a single machine gives host candidates, so this connects with no
 * STUN reachable and no TURN at all -- which also means it runs offline in CI.
 *
 * It then checks the other half of the design: that killing the peer connection
 * leaves the pair on the relay path rather than dead.
 */
import { loadPlaywright, startServer } from "./harness.mjs";

const PORT = 5195;
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
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  for (const p of [a, b]) {
    p.on("pageerror", (e) => {
      failures++;
      console.log("  FAIL page error: " + e.message);
    });
    await p.goto(URL_ + "?room=direct", { waitUntil: "load" });
    await p.waitForFunction("window.__debug && window.__debug.sprites",
                            null, { timeout: 30000 });
  }

  console.log("negotiating a peer connection");
  await Promise.all([a.click("#netplay"), b.click("#netplay")]);
  await Promise.all([a, b].map((p) => p.waitForFunction(
    "window.__debug.session !== null", null, { timeout: 25000 })));

  // From here the test is the only thing driving the clock. The page's own
  // rAF loop would otherwise keep stepping between an assertion and the
  // measurement that follows it, and two peers read a frame apart are
  // indistinguishable from two peers that have desynced.
  await Promise.all([a, b].map((p) =>
    p.evaluate(() => window.__debug.autoTick(false))));

  const kinds = await Promise.all([a, b].map((p) =>
    p.evaluate(() => window.__debug.link)));
  console.log(`  link: ${kinds[0]} / ${kinds[1]}`);
  check("both peers took the direct path", kinds, ["webrtc", "webrtc"]);

  const pump = async (n) => {
    for (let i = 0; i < n; i++) {
      await Promise.all([a, b].map((p) =>
        p.evaluate(() => window.__debug.netTick(1))));
    }
  };
  const frames = () => Promise.all([a, b].map((p) =>
    p.evaluate(() => window.__debug.session.frame)));
  const align = async (limit = 300) => {
    for (let i = 0; i < limit; i++) {
      const [fa, fb] = await frames();
      if (fa === fb) return true;
      await (fa < fb ? a : b).evaluate(() => window.__debug.netTick(1));
    }
    return false;
  };
  const digests = () => Promise.all([a, b].map((p) => p.evaluate(async () => {
    const { hashLevel } = await import("/dist/net/hash.js");
    return window.game.m_level ? hashLevel(window.game.m_level) : null;
  })));

  await pump(30);
  const started = await Promise.all([a, b].map((p) => p.evaluate(
    () => window.game.m_level ? window.game.m_level.CurrentMode : null)));
  check("both started the level", started, ["adventure", "adventure"]);

  console.log("\nplaying over the data channel");
  const slots = await Promise.all([a, b].map((p) =>
    p.evaluate(() => window.__debug.slot)));
  const fireTab = slots[0] === 0 ? a : b;
  const waterTab = slots[0] === 0 ? b : a;
  await fireTab.evaluate(() => window.__debug.hold("ArrowRight", true));
  await waterTab.evaluate(() => window.__debug.hold("ArrowRight", true));
  // Pumped until they have moved rather than for a fixed count: a key is held
  // at a tick boundary but the session decides which FRAME it lands on, and a
  // peer that stalled decides several at once when it resumes. See twotabs.
  for (let i = 0; i < 30; i++) {
    await pump(40);
    const p = await a.evaluate(() => {
      const lv = window.game.m_level;
      return [lv.pers1.GetPosition().x, lv.pers2.GetPosition().x];
    });
    if (p[0] > 2.5 && p[1] > 4.5) break;
  }
  await fireTab.evaluate(() => window.__debug.hold("ArrowRight", false));
  await waterTab.evaluate(() => window.__debug.hold("ArrowRight", false));
  await pump(100);

  const aligned = await align();
  const [fa, fb] = await frames();
  const hashes = await digests();
  const pos = await a.evaluate(() => ({
    fire: +window.game.m_level.pers1.GetPosition().x.toFixed(3),
    water: +window.game.m_level.pers2.GetPosition().x.toFixed(3),
  }));
  console.log(`  frame ${fa}/${fb}  hash ${hashes[0]}  ` +
              `fire ${pos.fire} water ${pos.water}`);

  check("the peers converge", aligned, true);
  check("their simulations are identical", hashes[0] === hashes[1], true);
  check("both characters moved", pos.fire > 2.5 && pos.water > 4.5, true);
  const desyncs = await Promise.all([a, b].map((p) =>
    p.evaluate(() => window.__debug.session.desyncs)));
  check("no desyncs", desyncs[0] + desyncs[1], 0);

  console.log("\nthe round-trip estimate comes from the connection itself");
  const rtt = await a.evaluate(() => {
    // getStats needs a moment; on loopback this is sub-millisecond.
    return new Promise((res) => setTimeout(
      () => res(window.__debug.session ? "sampled" : "no session"), 2500));
  });
  check("stats sampling ran without throwing", rtt, "sampled");
  // ---- the fallback path ------------------------------------------------
  console.log("\nwith no peer connection available, the pair still plays");
  {
    // Close the first pair first. Playwright contexts share a browser process,
    // and a BroadcastChannel is per-origin -- leaving four peers on one channel
    // is exactly the crossed-wires bug rooms exist to prevent.
    await ctx.close();
    const ctx2 = await browser.newContext();
    const c = await ctx2.newPage();
    const d = await ctx2.newPage();
    for (const p of [c, d]) {
      p.on("pageerror", (e) => {
        failures++;
        console.log("  FAIL page error: " + e.message);
      });
      // Take WebRTC away before the page decides anything, which is what a
      // strict NAT amounts to from the session's point of view.
      await p.addInitScript(() => {
        delete window.RTCPeerConnection;
      });
      await p.goto(URL_ + "?room=relay", { waitUntil: "load" });
      await p.waitForFunction("window.__debug && window.__debug.sprites",
                              null, { timeout: 30000 });
    }
    await Promise.all([c.click("#netplay"), d.click("#netplay")]);
    await Promise.all([c, d].map((p) => p.waitForFunction(
      "window.__debug.session !== null", null, { timeout: 25000 })));
    await Promise.all([c, d].map((p) =>
      p.evaluate(() => window.__debug.autoTick(false))));

    const kind = await Promise.all([c, d].map((p) =>
      p.evaluate(() => window.__debug.link)));
    check("both fell back to the relay", kind, ["relay", "relay"]);

    const pump2 = async (n) => {
      for (let i = 0; i < n; i++) {
        await Promise.all([c, d].map((p) =>
          p.evaluate(() => window.__debug.netTick(1))));
      }
    };
    await pump2(400);
    let converged = false;
    for (let i = 0; i < 400; i++) {
      const f = await Promise.all([c, d].map((p) =>
        p.evaluate(() => window.__debug.session.frame)));
      if (f[0] === f[1] && f[0] > 300) { converged = true; break; }
      await (f[0] <= f[1] ? c : d).evaluate(() => window.__debug.netTick(1));
    }
    check("the relay pair converged", converged, true);
    const h = await Promise.all([c, d].map((p) => p.evaluate(async () => {
      const { hashLevel } = await import("/dist/net/hash.js");
      return window.game.m_level ? hashLevel(window.game.m_level) : null;
    })));
    console.log(`  relay hash ${h[0]}`);
    check("the game still ran", h[0] !== null, true);
    check("and both peers agree", h[0] === h[1], true);
    await ctx2.close();
  }
} finally {
  await browser.close();
  server.kill();
}

console.log("\n" + (failures === 0 ? "WEBRTC PASSED" : `WEBRTC FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
