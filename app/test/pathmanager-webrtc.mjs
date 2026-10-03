/** Real unordered WebRTC, real NetSession/LevelHost, local scoped emergency relay. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPlaywright, startServer, ROOT } from "../../engine/test/harness.mjs";

const compiled = await build({ entryPoints: [resolve(ROOT, "app/src/net/pathmanager.ts")], bundle: true,
  write: false, platform: "browser", format: "esm", alias: { "@engine": resolve(ROOT, "engine/src") } });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`;
const playwright = await loadPlaywright();
assert.ok(playwright, "Playwright is required; this test must not silently skip");
const server = await startServer(5207);
let browser;
try {
  browser = await playwright.chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://localhost:5207/pathmanager-test-empty");
  const result = await page.evaluate(async moduleUrl => {
    const { PathManager } = await import(moduleUrl);
    const { NetSession } = await import("/dist/net/session.js");
    const { LevelHost } = await import("/dist/net/levelhost.js");
    const wait = ms => new Promise(ok => setTimeout(ok, ms));
    const check = (ok, why) => { if (!ok) throw new Error(why); };
    const channel = [0, 1].map(side => ({ handlers: new Set(), statuses: new Set(), gameplayPublishes: 0,
      onBytes(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); },
      onStatus(fn) { this.statuses.add(fn); return () => this.statuses.delete(fn); },
      sendBytes(packets) {
        let gameplay = false;
        for (const packet of packets) {
          const bytes = Uint8Array.from(atob(packet), c => c.charCodeAt(0));
          if (new TextDecoder().decode(bytes.subarray(0, 17)).startsWith("path-v1:gameplay:")) gameplay = true;
          setTimeout(() => { for (const fn of channel[1 - side].handlers) fn(bytes); }, 15);
        }
        if (gameplay) this.gameplayPublishes++;
      },
    }));
    const down = [0, 0];
    const transports = channel.map((ch, side) => new PathManager(ch, side === 0,
      { iceServers: [], timeoutMs: 3000, retryDelaysMs: [500, 1000], handoverMs: 500 }));
    const peers = transports.map((transport, slot) => {
      const host = new LevelHost();
      return { host, session: new NetSession({ host, slot, transport, rollback: true,
        delay: 0, onLinkDown: () => down[slot]++ }) };
    });
    const pump = async (duration, predicate = () => false) => {
      const until = performance.now() + duration;
      do {
        for (const p of peers) p.session.tick(1 / 60);
        await wait(1000 / 60);
        if (predicate()) return;
      } while (performance.now() < until);
    };
    const rtc = () => transports.every(t => t.kind === "webrtc");
    const start = performance.now();
    await pump(6000, rtc); check(rtc(), "initial RTC did not verify/promote");
    const initialRtcMs = performance.now() - start;
    check(transports.every(t => t.inner.dc.ordered === false && t.inner.dc.maxRetransmits === 0), "RTC reliability changed");
    peers[0].session.requestStart("adventure", 1);
    await pump(2300); check(peers.every(p => p.session.frame > 35), "level never progressed on RTC");
    const initialStats = transports.map(t => ({ rtc: t.rtc, sent: t.sent, stats: t.stats }));
    const before = peers.map(p => ({ frame: p.session.frame, generation: p.session.generation, runSerial: p.session.runSerial }));
    const oldRTC = transports.map(t => t.inner);
    const dieAt = performance.now();
    oldRTC[1].pc.close();
    await pump(350, () => transports.some(t => t.kind === "relay"));
    check(transports.some(t => t.kind === "relay"), "RTC close did not immediately select emergency relay");
    const fallbackMs = performance.now() - dieAt;
    await pump(8000, () => rtc() && transports.every(t => t.attempts >= 2));
    const recoveryMs = performance.now() - dieAt;
    check(rtc(), "fresh RTC did not promote");
    check(transports.every((t, side) => t.inner !== oldRTC[side]), "RTC attempt reused a dead peer connection");
    await pump(1000);
    const counts = channel.map(ch => ch.gameplayPublishes);
    await pump(1000);
    check(counts.every((count, side) => count === channel[side].gameplayPublishes), "relay gameplay continued after promotion");
    check(channel.every(ch => ch.gameplayPublishes > 0), "emergency relay carried no game input during migration");
    check(down.every(n => n === 0), "a physical migration notified NetSession that its link was lost");
    check(peers.every((p, side) => p.session.generation === before[side].generation && p.session.runSerial === before[side].runSerial), "migration restarted the level");
    // A real peer connection can remain open while its packets disappear. Keep
    // the browser RTC alive and silently discard both directions of send().
    await pump(250);
    const silentOld = transports.map(t => t.inner);
    silentOld.forEach(t => { t.send = () => {}; });
    const silentAt = performance.now();
    await pump(3000, () => transports.every(t => t.state === "RTC_SUSPECT"));
    check(transports.every(t => t.state === "RTC_SUSPECT"), "silent RTC did not enter suspect mode");
    const silentProtectionMs = performance.now() - silentAt;
    check(silentProtectionMs <= 2200, `silent protection took ${silentProtectionMs}ms`);
    const beforeSilentRelay = channel.map(ch => ch.gameplayPublishes);
    await pump(500);
    check(channel.every((ch, side) => ch.gameplayPublishes > beforeSilentRelay[side]), "suspect mode carried no relay gameplay");
    await pump(8500, () => rtc() && transports.every(t => t.attempts >= 3));
    const silentFreshMs = performance.now() - silentAt;
    check(rtc(), "fresh RTC after silent failure did not promote");
    check(transports.every((t, side) => t.inner !== silentOld[side]), "silent failure reused the old RTC");
    await pump(1000);
    const afterSilentRelay = channel.map(ch => ch.gameplayPublishes);
    await pump(500);
    check(channel.every((ch, side) => ch.gameplayPublishes === afterSilentRelay[side]), "relay gameplay continued after silent recovery");
    check(peers.every((p, side) => p.session.generation === before[side].generation && p.session.runSerial === before[side].runSerial), "silent migration restarted the level");
    const target = Math.max(...peers.map(p => p.session.frame)) + 30;
    const deadline = performance.now() + 5000;
    while (peers.some(p => p.session.frame < target) && performance.now() < deadline) {
      for (const p of peers) if (p.session.frame < target) p.session.tick(Math.min(1 / 60, (target - p.session.frame) / 26));
      await wait(1000 / 60);
    }
    for (const p of peers) p.session.tick(0);
    const final = peers.map(p => ({ frame: p.session.frame, hash: p.host.hash(), generation: p.session.generation,
      runSerial: p.session.runSerial, desyncs: p.session.desyncs, rollbacks: p.session.rollbacks,
      deepestRollback: p.session.deepestRollback, stalls: p.session.stalls }));
    check(final.every(p => p.frame === target && p.desyncs === 0), "peers did not reach the same confirmed frame");
    check(final[0].hash === final[1].hash, "final deterministic hashes differ after real RTC migration");
    const finalStats = transports.map(t => ({ attempts: t.attempts, migrations: t.migrations, duplicates: t.duplicates,
      rtc: t.rtc, sent: t.sent, stats: t.stats }));
    transports.forEach(t => t.close());
    check(channel.every(ch => ch.handlers.size === 0 && ch.statuses.size === 0), "manager leaked pair subscriptions");
    check(oldRTC.every(t => t.rttTimer === null), "retired RTC stats polling leaked");
    return { initialRtcMs, fallbackMs, recoveryMs, silentProtectionMs, silentFreshMs, before, final, down,
      relayPublishes: counts, silentRelayPublishes: afterSilentRelay, initialStats, finalStats };
  }, moduleUrl);
  assert.deepEqual(errors, []);
  const label = process.env.FBWG_PATH_LABEL ?? new Date().toISOString().replace(/[^0-9]/g, "");
  assert.match(label, /^[a-zA-Z0-9_-]+$/, "Invalid path benchmark label");
  await mkdir(resolve(ROOT, "benchmarks"), { recursive: true });
  await writeFile(resolve(ROOT, `benchmarks/pathmanager-local-${label}.json`), JSON.stringify({
    capturedAt: new Date().toISOString(), browser: browser.version(),
    scope: "Actual Chromium RTC with local byte-channel emergency relay. No hosted Supabase, WAN or TURN credentials used.", ...result,
  }, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  console.log("REAL RTC / EMERGENCY RELAY / FRESH RTC IN SAME NETSESSION PASSED");
} finally { await browser?.close(); server.kill(); }
