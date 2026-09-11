/** Actual loopback WebRTC failure/reconnect. No Supabase account/network needed. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPlaywright, startServer, ROOT } from "./harness.mjs";

const playwright = await loadPlaywright();
assert.ok(playwright, "Playwright is required; this test must not silently skip");
const server = await startServer(5198);
let browser;
try {
  browser = await playwright.chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  // A plain same-origin document avoids artwork/animation contaminating RTT.
  await page.goto("http://localhost:5198/transport-test-empty");
  const result = await page.evaluate(async () => {
    const { connect } = await import("/dist/net/connect.js");
    const { NetSession } = await import("/dist/net/session.js");
    const { LevelHost } = await import("/dist/net/levelhost.js");
    const wait = ms => new Promise(ok => setTimeout(ok, ms));
    const check = (ok, why) => { if (!ok) throw new Error(why); };
    const pair = () => {
      const receive = [null, null];
      return [0,1].map(side => ({
        rttMs: 0,
        send(d) { const copy = d.slice(); queueMicrotask(() => receive[1-side]?.(copy)); },
        onMessage(fn) { receive[side] = fn; }, close() { receive[side] = null; },
      }));
    };
    let signals = pair();
    const start = performance.now();
    const links = await Promise.all(signals.map((sig,i) => connect(sig,i === 0,{iceServers: [], timeoutMs: 3000})));
    check(links.every(l => l.kind === "webrtc"), "loopback did not negotiate WebRTC");
    check(links.every(l => l.transport.dc.ordered === false && l.transport.dc.maxRetransmits === 0), "data channel reliability changed");
    const handshakeMs = performance.now()-start;
    // Verify that subarray boundaries, including nonzero offsets, survive.
    let received;
    links[1].transport.onMessage(data => { received = [...data]; });
    links[0].transport.send(new Uint8Array([99,1,2,3,99]).subarray(1,4));
    for(let i=0;i<100 && !received;i++) await wait(10);
    check(JSON.stringify(received) === "[1,2,3]", "packet slice leaked adjacent bytes");
    const closed = [0,0], peers = links.map((link,slot) => {
      const host = new LevelHost();
      return { host, session: new NetSession({host,slot,transport:link.transport,rollback:true,timeSync:true,onLinkDown: () => closed[slot]++}) };
    });
    peers[0].session.requestStart("adventure",1);
    // Pump at display cadence so RTC and getStats get real event-loop time.
    for(let i=0;i<150;i++) { for(const p of peers) p.session.tick(1/60); await wait(1000/60); }
    const before = peers.map(p => p.session.frame);
    check(before.every(f => f > 40), "game never progressed on RTC");
    const rttMs = links.map(l => l.transport.rttMs);
    check(rttMs.every(rtt => typeof rtt === "number" && rtt >= 0), "RTT was not actually sampled");
    const stats = links.map(l => ({...l.transport.stats}));
    const diedAt = performance.now();
    links[0].transport.pc.close();
    for(let i=0;i<150 && closed.some(n => n === 0);i++) await wait(20);
    const failureDetectionMs = performance.now()-diedAt;
    check(closed.every(n => n === 1), "RTC failure must report once to both owners");
    check(links.every(l => l.transport.rttTimer === null), "dead RTC leaked its stats poll");
    for(const link of links) link.transport.close();
    // The production owner reconnects via a NEW attempt-scoped rendezvous.
    // relayOnly is agreed by both peers; no fresh 8-second NAT timeout applies.
    signals = pair();
    const restartAt = performance.now();
    const fallback = await Promise.all(signals.map((sig,i) => connect(sig,i === 0,{relayOnly:true})));
    check(fallback.every(l => l.kind === "relay"), "agreed relay reconnect failed");
    const fallbackSetupMs = performance.now()-restartAt;
    const resumed = fallback.map((link,slot) => {
      const host = new LevelHost();
      return {host,session:new NetSession({host,slot,transport:link.transport,rollback:true})};
    });
    resumed[0].session.requestStart("adventure",1);
    await wait(0);
    for(let i=0;i<60;i++) { for(const p of resumed) p.session.tick(1/26); await wait(0); }
    for(const p of resumed) p.session.tick(0);
    check(resumed.every(p => p.session.frame >= 55 && p.session.desyncs === 0), "relay reconnect did not play");
    check(resumed[0].host.hash() === resumed[1].host.hash(), "relay peers disagree");
    for(const link of fallback) link.transport.close();
    // A real RTC negotiation with ALL signalling lost models a NAT/ICE failure
    // without weakening the direct transport options or asking a paid TURN.
    const blackhole = {rttMs:null,send(){},onMessage(){},close(){}};
    const timeoutStart = performance.now();
    const timed = await connect(blackhole,true,{iceServers:[],timeoutMs:150});
    check(timed.kind === "relay" && timed.reason.includes("150ms"), "NAT timeout did not fall back");
    const abort = new AbortController();
    abort.abort();
    let cancelled = false;
    try { await connect(blackhole,true,{signal:abort.signal}); } catch { cancelled = true; }
    check(cancelled,"cancelled handshake became an unwanted relay");
    return {handshakeMs,failureDetectionMs,fallbackSetupMs,natTimeoutMs:performance.now()-timeoutStart,rttMs,stats,framesBeforeFailure:before,closed,relayFrames:resumed.map(p => p.session.frame)};
  });
  assert.deepEqual(errors, []);
  await mkdir(resolve(ROOT,"docs/benchmarks"),{recursive:true});
  await writeFile(resolve(ROOT,"docs/benchmarks/webrtc-local.json"),JSON.stringify({capturedAt:new Date().toISOString(),browser:browser.version(),scope:"Actual loopback Chromium RTC; relay transport is local rendezvous, not hosted Supabase. No global WAN/NAT hardware tested.",...result},null,2)+"\n");
  console.log(JSON.stringify(result,null,2));
  console.log("TRANSPORT FAILURE / RELAY RECONNECT PASSED");
} finally { await browser?.close(); server.kill(); }
