/** Real Internet acceptance: a GitHub runner Chromium and a Browserbase Chromium. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { makeUser, pageSignIn, pairPages, cleanupNetworkAccounts } from "./hosted-network.mjs";

const site = process.env.FBWG_PREVIEW_URL;
const expected = process.env.FBWG_EXPECTED_SHA;
const repetitions = Number(process.env.FBWG_REPETITIONS ?? "1");
const apiKey = process.env.BROWSERBASE_API_KEY;
const projectId = process.env.BROWSERBASE_PROJECT_ID;
const shareUrl = process.env.FBWG_VERCEL_SHARE_URL;
assert(/^[0-9a-f]{40}$/i.test(expected ?? ""), "expected full commit SHA required");
assert(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 2,
  "repetitions must be 1 or 2");
assert(apiKey && projectId, "Browserbase repository secrets missing");
const preview = new URL(site);
assert.equal(preview.protocol, "https:", "Preview must use HTTPS");
assert(/^fireboy-and-watergirl-official-[a-z0-9-]+\.vercel\.app$/i.test(preview.hostname),
  "Preview host is not the known Vercel project");
assert.equal(preview.pathname, "/", "Preview URL must be an origin");
assert(!preview.username && !preview.password && !preview.search && !preview.hash && !preview.port,
  "Preview URL must not contain credentials, query, fragment, or port");
const origin = preview.origin + "/";
assert(shareUrl, "temporary Vercel Preview share secret missing");
const share = new URL(shareUrl);
assert.equal(share.origin, preview.origin, "share link is for a different Preview");
assert.equal(share.pathname, "/", "share link must target the Preview origin");
assert(!share.username && !share.password && !share.hash && !share.port &&
  [...share.searchParams.keys()].join() === "_vercel_share" &&
  /^[A-Za-z0-9]+$/.test(share.searchParams.get("_vercel_share") ?? ""),
"invalid temporary Vercel share link");

async function versionGate(context) {
  const probe = await context.newPage();
  try {
    await probe.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    const response = await probe.goto(new URL("/version.txt", origin).href,
      { waitUntil: "domcontentloaded", timeout: 15000 });
    assert.equal(response?.status(), 200, "Preview version endpoint unavailable");
    const live = (await probe.locator("body").innerText()).trim();
    assert.equal(live, expected, "Preview serves a different commit");
    console.log(`Preview version verified: ${live}`);
  } finally { await probe.close(); }
}

async function createBrowserbaseSession() {
  const response = await fetch("https://www.browserbase.com/v1/sessions", {
    method: "POST",
    headers: { "X-BB-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, timeout: 840, keepAlive: false,
      browserSettings: { recordSession: false, logSession: false } }),
    signal: AbortSignal.timeout(30000),
  });
  assert(response.ok, `Browserbase session creation HTTP ${response.status}`);
  const session = await response.json();
  assert(/^wss:\/\//.test(session.connectUrl ?? ""), "Browserbase omitted CDP URL");
  return session;
}

async function releaseBrowserbaseSession(session) {
  if (!session) return true;
  const response = await fetch(`https://www.browserbase.com/v1/sessions/${session.id}`, {
    method: "POST",
    headers: { "X-BB-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, status: "REQUEST_RELEASE" }),
    signal: AbortSignal.timeout(15000),
  });
  if (response.ok) return true;
  // A disconnected CDP session with keepAlive=false may already be complete.
  const check = await fetch(`https://www.browserbase.com/v1/sessions/${session.id}`, {
    headers: { "X-BB-API-Key": apiKey }, signal: AbortSignal.timeout(15000),
  });
  if (!check.ok) return false;
  return ["COMPLETED", "TIMED_OUT"].includes((await check.json()).status);
}

async function browserDiagnostics(page, browser) {
  const response = await page.goto("https://api.ipify.org?format=json", {
    waitUntil: "domcontentloaded", timeout: 20000,
  });
  assert.equal(response?.status(), 200, "public egress probe failed");
  const address = JSON.parse(await page.locator("body").innerText()).ip;
  assert(/^[0-9a-f:.]+$/i.test(address ?? ""), "egress probe did not return an IP");
  const platform = await page.evaluate(() => ({
    platform: navigator.userAgentData?.platform ?? navigator.platform,
    userAgent: navigator.userAgent,
  }));
  return { publicIP: address, browserVersion: browser.version(), ...platform };
}

const snapshot = page => page.evaluate(() => {
  const hook = window.fbwgNetworkTest;
  if (!hook) throw new Error("Preview PathManager test hook missing");
  return { ...hook.snapshot(), reconnectSeen: window.__remoteReconnectSeen === true };
});
const states = pages => Promise.all(pages.map(snapshot));

async function waitFor(pages, condition, label, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await states(pages);
    if (condition(last)) return last;
    await pages[0].waitForTimeout(200);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function watchReconnect(pages) {
  await Promise.all(pages.map(page => page.evaluate(() => {
    const status = document.querySelector(".status");
    if (!status) throw new Error("connection status missing");
    window.__remoteReconnectSeen = /reconnect/i.test(status.textContent ?? "");
    window.__remoteStatusObserver?.disconnect();
    window.__remoteStatusObserver = new MutationObserver(() => {
      if (/reconnect/i.test(status.textContent ?? "")) window.__remoteReconnectSeen = true;
    });
    window.__remoteStatusObserver.observe(status,
      { childList: true, characterData: true, subtree: true });
  })));
}

async function migrate(pages, mode) {
  const before = await states(pages);
  assert(before.every(x => x.state === "RTC_ACTIVE" && x.path === "rtc"),
    `${mode}: RTC inactive before disruption`);
  const start = Date.now();
  const marked = await Promise.all(pages.map(page => page.evaluate(() =>
    window.fbwgNetworkTest.rememberRtc())));
  assert.deepEqual(marked, [true, true], `${mode}: RTC attempt not retained for stale-packet check`);
  if (mode === "close") {
    assert.equal(await pages[1].evaluate(() => window.fbwgNetworkTest.closeRtc()), true);
  } else {
    const blackholed = await Promise.all(pages.map(page => page.evaluate(() =>
      window.fbwgNetworkTest.blackholeRtc())));
    assert.deepEqual(blackholed, [true, true]);
  }
  const relay = await waitFor(pages, xs => xs.every(x => x.path === "relay"),
    `${mode}: relay protection`, 12000);
  const protectionMs = Date.now() - start;
  const progressed = await waitFor(pages, xs => xs.every((x, i) =>
    x.path === "relay" && x.relaySent > relay[i].relaySent &&
    x.relayReceived > relay[i].relayReceived && x.relayInputs > relay[i].relayInputs &&
    x.frame > relay[i].frame &&
    x.confirmed > relay[i].confirmed), `${mode}: relay carried gameplay`, 10000);
  const fresh = await waitFor(pages, xs => xs.every((x, i) =>
    x.state === "RTC_ACTIVE" && x.path === "rtc" && x.attempts > before[i].attempts),
  `${mode}: fresh RTC`, 50000);
  const freshMs = Date.now() - start;
  assert(fresh.every((x, i) => x.frame > progressed[i].frame &&
    x.confirmed > before[i].confirmed && x.sameSession && x.sameView && x.sameLevel &&
    x.generation === before[i].generation && x.runSerial === before[i].runSerial &&
    x.running && !x.reconnectSeen && x.desyncs === 0),
  `${mode}: continuity or convergence failed`);
  await pages[0].waitForTimeout(1300);
  const quiet = await states(pages);
  await pages[0].waitForTimeout(650);
  const after = await states(pages);
  assert(after.every((x, i) => x.relaySent === quiet[i].relaySent),
    `${mode}: relay kept publishing after promotion`);
  const ignored = await Promise.all(pages.map(page => page.evaluate(() =>
    window.fbwgNetworkTest.retiredRtcIgnored())));
  assert.deepEqual(ignored, [true, true], `${mode}: retired RTC packet accepted`);
  console.log(`${mode}: relay ${protectionMs} ms; fresh RTC ${freshMs} ms; confirmed progress both peers`);
  return { mode, protectionMs, freshMs, relayProgress: progressed.map((x, i) => ({
    frames: x.frame - relay[i].frame, confirmed: x.confirmed - relay[i].confirmed,
    sent: x.relaySent - relay[i].relaySent,
    received: x.relayReceived - relay[i].relayReceived,
    gameplayInputs: x.relayInputs - relay[i].relayInputs,
  })) };
}

async function confirmedHash(pages) {
  const live = await waitFor(pages, xs => xs.every(x => x.running && x.desyncs === 0 &&
    x.sameSession && x.sameView && x.sameLevel && !x.reconnectSeen) &&
    Math.min(...xs.map(x => x.confirmed)) > 100,
  "confirmed convergence", 12000);
  const common = Math.min(...live.map(x => x.confirmed));
  const digests = await Promise.all(pages.map(page => page.evaluate(limit => {
    const out = [];
    for (let frame = 0; frame <= limit; frame++) {
      const hash = window.fbwgNetworkTest.digestAt(frame);
      if (hash !== null) out.push([frame, hash]);
    }
    return out;
  }, common)));
  const peerB = new Map(digests[1]);
  const shared = digests[0].filter(([frame]) => peerB.has(frame));
  assert(shared.length, "no shared confirmed digest frame");
  const [frame, hash] = shared.at(-1);
  assert.equal(hash, peerB.get(frame), "confirmed deterministic hashes differ");
  return { frame, hash, peers: live.map(x => ({ frame: x.frame, confirmed: x.confirmed,
    generation: x.generation, runSerial: x.runSerial, desyncs: x.desyncs,
    sameSession: x.sameSession, sameView: x.sameView, sameLevel: x.sameLevel,
    reconnectSeen: x.reconnectSeen })) };
}

async function signOutPage(page) {
  try {
    await page.getByRole("button", { name: "Menu", exact: true }).click({ timeout: 3000 });
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Sign out", exact: true }).click({ timeout: 3000 });
    await page.locator("input[type=password]").waitFor({ timeout: 5000 });
    return true;
  } catch { return false; }
}

let localBrowser;
let remoteBrowser;
let browserbaseSession;
let localContext;
let remoteContext;
let pages = [];
let cleanupPassed;
let signedOut;
let remoteClosed = false;
let localClosed = false;
let sessionReleased = false;
const privateTestValues = [];
const result = { expectedSHA: expected, preview: origin, repetitions, pass: false };
try {
  localBrowser = await chromium.launch();
  localContext = await localBrowser.newContext();
  await versionGate(localContext); // No account exists before the exact Preview is proved.
  browserbaseSession = await createBrowserbaseSession();
  remoteBrowser = await chromium.connectOverCDP(browserbaseSession.connectUrl);
  remoteContext = remoteBrowser.contexts()[0] ?? await remoteBrowser.newContext();
  pages = [await localContext.newPage(), await remoteContext.newPage()];
  result.network = await Promise.all([
    browserDiagnostics(pages[0], localBrowser), browserDiagnostics(pages[1], remoteBrowser),
  ]);
  assert.notEqual(result.network[0].publicIP, result.network[1].publicIP,
    "browser peers have the same public egress IP");
  console.log(`independent public egress: ${result.network[0].publicIP} / ${result.network[1].publicIP}`);
  // The share link grants each isolated browser context short-lived access to
  // this protected Preview; neither context inherits the other's cookie.
  await Promise.all(pages.map(page => page.goto(shareUrl,
    { waitUntil: "domcontentloaded", timeout: 20000 })));
  const suffix = `${Date.now()}_${randomBytes(5).toString("hex")}`;
  const alice = await makeUser("a", suffix);
  const bob = await makeUser("b", suffix);
  privateTestValues.push(alice.email, alice.password, alice.username,
    bob.email, bob.password, bob.username);
  await Promise.all([pageSignIn(pages[0], alice, origin), pageSignIn(pages[1], bob, origin)]);
  result.games = [];
  for (let game = 0; game < repetitions; game++) {
    await pairPages(pages[0], pages[1], alice, bob);
    await watchReconnect(pages);
    await waitFor(pages, xs => xs.every(x => x.state === "RTC_ACTIVE" && x.path === "rtc"),
      "initial natural RTC", 30000);
    let initialICE;
    for (let i = 0; i < 50; i++) {
      initialICE = await Promise.all(pages.map(page => page.evaluate(() =>
        window.fbwgNetworkTest.ice())));
      if (initialICE.every(Boolean)) break;
      await pages[0].waitForTimeout(200);
    }
    assert(initialICE.every(Boolean), "selected ICE pair unavailable");
    const migrations = [];
    for (const mode of ["close", "silent", "close"]) migrations.push(await migrate(pages, mode));
    const final = await confirmedHash(pages);
    result.games.push({ initialICE, migrations, final });
    if (game + 1 < repetitions) {
      await Promise.all(pages.map(page => page.reload({ waitUntil: "load" })));
    }
  }
  result.pass = true;
} catch (error) {
  // A CDP connection error can include its credential-bearing WebSocket URL.
  let safe = String(error.message ?? error).replaceAll(apiKey, "[redacted]")
    .replaceAll(shareUrl, "[redacted Preview share URL]")
    .replace(/wss:\/\/\S+/g, "[redacted CDP URL]");
  for (const value of privateTestValues) safe = safe.replaceAll(value, "[redacted test credential]");
  result.error = safe;
  console.error(`remote acceptance failed: ${safe}`);
} finally {
  signedOut = await Promise.all(pages.map(signOutPage));
  if (remoteBrowser) {
    try { await remoteBrowser.close(); remoteClosed = true; } catch { /* reported below */ }
  } else remoteClosed = true;
  try { sessionReleased = await releaseBrowserbaseSession(browserbaseSession); }
  catch { /* reported below */ }
  await localContext?.close().catch(() => {});
  if (localBrowser) {
    try { await localBrowser.close(); localClosed = true; } catch { /* reported below */ }
  } else localClosed = true;
  cleanupPassed = await cleanupNetworkAccounts();
  result.cleanup = { signedOut, accountsAndProfilesDeleted: cleanupPassed,
    remoteBrowserClosed: remoteClosed, localBrowserClosed: localClosed, sessionReleased };
  result.pass &&= cleanupPassed && signedOut.every(Boolean) && remoteClosed &&
    localClosed && sessionReleased;
  await mkdir(resolve("artifacts"), { recursive: true });
  await writeFile(resolve("artifacts/remote-network-summary.json"),
    JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
}
process.exit(result.pass ? 0 : 1);
