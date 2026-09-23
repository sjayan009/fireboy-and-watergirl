/** Two disposable users, live TURN, then hosted PairChannel migration in Chromium. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { LevelHost } from "../../engine/dist/net/levelhost.js";
import { env } from "../../supabase/connect.mjs";
import { sweepStaleTestUsers } from "../../supabase/sweep.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const APP = resolve(ROOT, "app");
const PORT = 5198;
const URL_ = `http://localhost:${PORT}/`;
const PREFIX = "fbwg_network_acceptance_";
const e = env();
assert.equal(e.SUPABASE_PROJECT_REF, "hkuhkzcnwircqcmxurxi", "unexpected Supabase project");
assert.equal(e.SUPABASE_URL, "https://hkuhkzcnwircqcmxurxi.supabase.co", "unexpected Supabase URL");
assert(e.SUPABASE_SECRET_KEY && e.SUPABASE_PUBLISHABLE_KEY, "test credentials are unavailable");
const users = [];
const sessions = [];
const contexts = [];
const pageErrors = [];
let browser;
let server;

const admin = (path, init = {}) => fetch(`${e.SUPABASE_URL}${path}`, {
  ...init,
  headers: { apikey: e.SUPABASE_SECRET_KEY, Authorization: `Bearer ${e.SUPABASE_SECRET_KEY}`,
    "content-type": "application/json", ...(init.headers ?? {}) },
  signal: AbortSignal.timeout(15000),
});

async function makeUser(tag, suffix) {
  const email = `${PREFIX}${suffix}_${tag}@example.com`;
  const password = randomBytes(32).toString("base64url") + "aA1!";
  const username = `fbwgna${Date.now().toString(36)}${randomBytes(2).toString("hex")}${tag}`;
  const response = await admin("/auth/v1/admin/users", {
    method: "POST", body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!response.ok) throw new Error(`create ${tag}: Auth Admin HTTP ${response.status}`);
  const created = await response.json();
  assert.match(created.id ?? "", /^[0-9a-f-]{36}$/i, `create ${tag}: missing user ID`);
  assert.equal(created.email, email, `create ${tag}: wrong email`);
  const user = { id: created.id, email, password, username };
  users.push(user);
  return user;
}

async function signInToken(user) {
  const client = createClient(e.SUPABASE_URL, e.SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error || !data.session?.access_token || data.user?.id !== user.id)
    throw new Error(`sign in ${user.username}: ${error?.name ?? "identity mismatch"}`);
  sessions.push(client);
  return data.session.access_token;
}

function baseEnv() {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PLAYWRIGHT_BROWSERS_PATH|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)) out[key] = value;
  }
  return out;
}

function runTurn(token) {
  console.log("stage: live TURN");
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, ["run", "test:turn-live"], {
    cwd: ROOT, stdio: "inherit", shell: process.platform === "win32",
    env: { ...baseEnv(), SUPABASE_URL: e.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: e.SUPABASE_PUBLISHABLE_KEY, FBWG_TURN_USER_TOKEN: token },
    timeout: 180000,
  });
  if (result.error || result.status !== 0)
    throw new Error(`live TURN failed: ${result.error?.code ?? `exit ${result.status}`}`);
}

async function startVite() {
  const vite = resolve(ROOT, "node_modules/vite/bin/vite.js");
  const child = spawn(process.execPath, [vite, "--port", String(PORT), "--strictPort"], {
    cwd: APP, stdio: "ignore", env: { ...baseEnv(), FBWG_PATH_MANAGER: "1" },
  });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`Vite exited ${child.exitCode}`);
    try {
      if ((await fetch(URL_, { signal: AbortSignal.timeout(1000) })).ok) return child;
    } catch { /* waiting for the local server */ }
    await new Promise(r => setTimeout(r, 200));
  }
  child.kill();
  throw new Error("Vite did not start");
}

async function pageSignIn(page, user) {
  await page.goto(URL_, { waitUntil: "load" });
  await page.locator("input[type=email]").fill(user.email);
  await page.locator("input[type=password]").fill(user.password);
  await page.click("button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#stage") ||
    document.body.textContent?.includes("Pick a name"), null, { timeout: 30000 });
  if (await page.locator("text=Pick a name").isVisible()) {
    await page.locator("form input").first().fill(user.username);
    await page.click("button[type=submit]");
  }
  await page.waitForSelector("#stage", { timeout: 30000 });
  assert.equal(await page.locator(".copy-name").innerText(), user.username);
}

async function openFriends(page) {
  if (!await page.locator("text=Send a request").isVisible()) await page.click("button.tool-friends");
  await page.waitForSelector("text=Send a request", { timeout: 20000 });
}

async function pairPages(a, b, alice, bob) {
  await openFriends(a);
  await openFriends(b);
  const friendshipPath = `/rest/v1/friendships?select=status&user_a=eq.${
    alice.id < bob.id ? alice.id : bob.id}&user_b=eq.${alice.id < bob.id ? bob.id : alice.id}`;
  const friendshipStatus = async () => {
    const response = await admin(friendshipPath);
    if (!response.ok) throw new Error(`friendship query HTTP ${response.status}`);
    return (await response.json())[0]?.status;
  };
  if (await friendshipStatus() !== "accepted") {
    await a.fill("form input", bob.username);
    await a.click("button[type=submit]");
    await b.waitForSelector("text=Waiting for You", { timeout: 20000 });
    await b.click("button:has-text('Accept')");
    let accepted = false;
    for (let i = 0; i < 50; i++) {
      accepted = await friendshipStatus() === "accepted";
      if (accepted) break;
      await a.waitForTimeout(200);
    }
    assert(accepted, "friendship was not accepted");
  }
  const invite = a.locator(`.friend-row:has-text("${bob.username}") button.invite-friend`);
  await invite.waitFor({ state: "visible", timeout: 30000 });
  await invite.click();
  await a.waitForSelector(".banner select");
  await a.click(".banner button:has-text('Send invite')");
  await b.waitForSelector(".banner:has-text('wants to play')", { timeout: 30000 });
  await b.click(".banner button:has-text('Accept')");
  for (const page of [a, b]) {
    await page.waitForFunction("window.__fbwg?.view.session?.running && window.__fbwg.view.level",
      null, { timeout: 60000 });
  }
}

async function states(pages) {
  return Promise.all(pages.map(page => page.evaluate(() => {
    const { session, manager } = window.__hostedNetworkRead();
    return { state: manager?.state, kind: manager?.kind, attempts: manager?.attempts,
      migrations: manager?.migrations, relaySent: manager?.relay?.sent,
      relayReceived: manager?.relay?.stats.receivedPackets, frame: session?.frame,
      generation: session?.generation, runSerial: session?.runSerial,
      desyncs: session?.desyncs, running: session?.running, confirmed: session?.confirmed,
      reconnectSeen: window.__hostedReconnectSeen === true,
      sameSession: session === window.__hostedNetworkSession,
      sameLevel: window.__fbwg.view.level === window.__hostedNetworkLevel,
      sameView: window.__fbwg.view === window.__hostedNetworkView };
  })));
}

async function waitFor(pages, predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await states(pages);
    if (predicate(last)) return last;
    await pages[0].waitForTimeout(200);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function migration(pages, mode) {
  const before = await states(pages);
  assert(before.every(x => x.state === "RTC_ACTIVE" && x.kind === "webrtc"), "RTC not active before disruption");
  await Promise.all(pages.map(page => page.evaluate(() => {
    const status = document.querySelector(".status");
    if (!status) throw new Error("connection status missing");
    window.__hostedReconnectSeen = false;
    window.__hostedStatusObserver?.disconnect();
    window.__hostedStatusObserver = new MutationObserver(() => {
      if (/reconnect/i.test(status.textContent ?? "")) window.__hostedReconnectSeen = true;
    });
    window.__hostedStatusObserver.observe(status, { childList: true, characterData: true, subtree: true });
  })));
  const started = Date.now();
  await Promise.all(pages.map(page => page.evaluate(mode => {
    const { manager } = window.__hostedNetworkRead();
    if (mode === "silent") {
      window.__hostedOldAttempt = manager.attempt;
      manager.attempt.transport.send = () => {};
    }
  }, mode)));
  if (mode === "close") await pages[1].evaluate(() => {
    const { manager } = window.__hostedNetworkRead();
    window.__hostedOldAttempt = manager.attempt;
    manager.attempt.transport.pc.close();
  });
  const relay = await waitFor(pages, xs => xs.every(x => x.kind === "relay"), `${mode}: hosted relay`, 11000);
  const protectionMs = Date.now() - started;
  await Promise.all(pages.map(page => page.evaluate(() => window.__fbwg.view.session.setLocalInput(2))));
  try {
    await waitFor(pages, xs => xs.every((x, i) =>
      x.relaySent > relay[i].relaySent && x.relayReceived > relay[i].relayReceived &&
      x.frame > relay[i].frame), `${mode}: hosted relay carried gameplay both ways`, 8000);
  } catch {
    const last = await states(pages);
    throw new Error(`${mode}: relay gameplay delta ${JSON.stringify(last.map((x, i) => ({
      sent: x.relaySent - relay[i].relaySent,
      received: x.relayReceived - relay[i].relayReceived,
      frames: x.frame - relay[i].frame,
      confirmed: x.confirmed - relay[i].confirmed,
      state: x.state,
    })))}`);
  }
  await Promise.all(pages.map(page => page.evaluate(() => window.__fbwg.view.session.setLocalInput(0))));
  const fresh = await waitFor(pages, xs => xs.every((x, i) => x.state === "RTC_ACTIVE" &&
    x.kind === "webrtc" && x.attempts > before[i].attempts), `${mode}: fresh RTC`, 18000);
  const freshMs = Date.now() - started;
  assert(fresh.every((x, i) => x.frame > before[i].frame && x.sameSession && x.sameLevel &&
    x.generation === before[i].generation && x.runSerial === before[i].runSerial &&
    x.running && x.sameView && !x.reconnectSeen && x.desyncs === 0),
  `${mode}: game restarted, showed reconnect, or diverged`);
  await pages[0].waitForTimeout(1300);
  const quiet = await states(pages);
  await pages[0].waitForTimeout(650);
  const after = await states(pages);
  assert(after.every((x, i) => x.relaySent === quiet[i].relaySent), `${mode}: relay kept publishing after RTC recovery`);
  if (mode === "silent") {
    const ignored = await Promise.all(pages.map(page => page.evaluate(() => {
      const { manager } = window.__hostedNetworkRead();
      const old = window.__hostedOldAttempt;
      let delivered = 0;
      const receiver = manager.receiver;
      manager.receiver = data => { delivered++; receiver(data); };
      manager.onRTC(old, manager.lastInput ?? new Uint8Array([1]));
      manager.receiver = receiver;
      return delivered === 0 && manager.attempt !== old;
    })));
    assert.deepEqual(ignored, [true, true], "late old-RTC traffic was delivered");
  }
  console.log(`${mode}: relay protection ${protectionMs} ms; fresh RTC ${freshMs} ms`);
  return { protectionMs, freshMs };
}

async function finalHash(pages) {
  const live = await waitFor(pages, xs => xs.every(x => x.running && x.desyncs === 0 && !x.reconnectSeen &&
    x.sameSession && x.sameView && x.sameLevel) &&
    Math.abs(xs[0].frame - xs[1].frame) <= 6 && Math.min(...xs.map(x => x.confirmed)) > 100,
  "hosted peers converge", 10000);
  // A live headless pair may be on adjacent predicted frames. Compare the
  // same confirmed prefix from each real session, then replay it independently.
  const common = Math.min(...live.map(x => x.confirmed)) - 10;
  const replays = await Promise.all(pages.map(page => page.evaluate(frame =>
    window.__fbwg.view.session.replay(frame), common)));
  assert(replays.every(Boolean), "confirmed replay unavailable");
  assert.deepEqual(replays[0], replays[1], "confirmed inputs or commands differ");
  const hashes = replays.map(replay => {
    assert.deepEqual(replay.commands, [], "unexpected mid-level command in replay");
    const bits = Buffer.from(replay.inputs, "base64");
    assert.equal(bits.length, common);
    const host = new LevelHost();
    host.start(replay.mode, replay.num);
    for (let frame = 0; frame < bits.length; frame++) host.step(bits[frame], frame);
    return host.hash();
  });
  assert.equal(hashes[0], hashes[1], "deterministic final hashes differ");
  const liveDigests = await Promise.all(pages.map(page => page.evaluate(() =>
    [...window.__fbwg.view.session.hashes.entries()])));
  const peerDigests = new Map(liveDigests[1]);
  const shared = liveDigests[0].filter(([frame]) => frame <= common && peerDigests.has(frame))
    .sort((a, b) => a[0] - b[0]);
  assert(shared.length > 0, "no matching confirmed digest frame from the live sessions");
  const [digestFrame, digestA] = shared.at(-1);
  const digestB = peerDigests.get(digestFrame);
  assert.equal(digestA, digestB, "live deterministic hashes differ at the same confirmed frame");
  console.log(`hosted confirmed replay frame ${common}, live digest frame ${digestFrame}, hash ${digestA}, desyncs 0`);
  return { live, common, hashes, digestFrame, digestA, digestB };
}

async function runHostedScenario(alice, bob, mode) {
  pageErrors.length = 0;
  const pages = [];
  try {
    for (const user of [alice, bob]) {
      const context = await browser.newContext(); contexts.push(context);
      const page = await context.newPage(); pages.push(page);
      page.on("pageerror", error => { pageErrors.push(error.name); console.error(`browser page error: ${error.name}`); });
      await pageSignIn(page, user);
    }
    await pairPages(pages[0], pages[1], alice, bob);
    await Promise.all(pages.map(page => page.evaluate(() => {
      window.__hostedNetworkRead = () => {
        const view = window.__fbwg?.view;
        const session = view?.session;
        let manager = session?.transport;
        while (manager && typeof manager.attempts !== "number") manager = manager.inner;
        return { view, session, manager };
      };
      const { view, session, manager } = window.__hostedNetworkRead();
      if (!manager || !session || !view.level) throw new Error("managed hosted session missing");
      window.__hostedNetworkSession = session;
      window.__hostedNetworkLevel = view.level;
      window.__hostedNetworkView = view;
    })));
    await waitFor(pages, xs => xs.every(x => x.state === "RTC_ACTIVE" && x.kind === "webrtc"),
      `${mode}: initial hosted RTC`, 20000);
    const timing = await migration(pages, mode);
    const final = await finalHash(pages);
    assert.deepEqual(pageErrors, [], "browser page errors occurred");
    return { timing, final };
  } finally {
    for (const page of pages) {
      await page.evaluate(async () => {
        try { const { signOut } = await import("/src/auth.ts"); await signOut(); } catch { /* context closes below */ }
      }).catch(() => {});
      await page.context().close().catch(() => {});
    }
  }
}

async function runHosted(alice, bob) {
  console.log("stage: hosted two-person migration");
  server = await startVite();
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  const results = {};
  const failed = [];
  for (const mode of ["close", "silent"]) {
    try { results[mode] = await runHostedScenario(alice, bob, mode); }
    catch (error) { failed.push(`${mode}: ${error.message}`); console.error(`hosted ${mode} failed: ${error.message}`); }
  }
  if (failed.length) throw new Error(failed.join("; "));
  return results;
}

let turnPassed = false;
let hostedPassed = false;
let cleanupPassed = true;
try {
  await sweepStaleTestUsers("hosted-network", PREFIX);
  const suffix = `${Date.now()}_${randomBytes(5).toString("hex")}`;
  const alice = await makeUser("a", suffix);
  const bob = await makeUser("b", suffix);
  console.log("created exactly two disposable network accounts");
  const tokenA = await signInToken(alice);
  await signInToken(bob);
  try { runTurn(tokenA); turnPassed = true; }
  catch (error) { console.error(error.message); }
  try { await runHosted(alice, bob); hostedPassed = true; }
  catch (error) { console.error(`hosted stage failed: ${error.message}`); }
} catch (error) {
  console.error(`setup failed: ${error.message}`);
} finally {
  for (const context of contexts) {
    for (const page of context.pages()) {
      await page.evaluate(async () => {
        try { const { signOut } = await import("/src/auth.ts"); await signOut(); } catch { /* context closes below */ }
      }).catch(() => {});
    }
    await context.close().catch(() => {});
  }
  await browser?.close().catch(() => {});
  server?.kill();
  for (const client of sessions) await client.auth.signOut().catch(() => {});
  for (const user of users) {
    if (!user.email.startsWith(PREFIX)) { cleanupPassed = false; continue; }
    try {
      const response = await admin(`/auth/v1/admin/users/${user.id}`, { method: "DELETE" });
      if (!response.ok) cleanupPassed = false;
      else if ((await admin(`/auth/v1/admin/users/${user.id}`)).status !== 404) cleanupPassed = false;
    } catch { cleanupPassed = false; }
  }
  console.log(`cleanup: ${cleanupPassed ? "confirmed" : "FAILED"} for ${users.length} disposable users`);
}
console.log(`live TURN: ${turnPassed ? "PASS" : "FAIL"}; hosted migration: ${hostedPassed ? "PASS" : "FAIL"}`);
process.exit(turnPassed && hostedPassed && cleanupPassed ? 0 : 1);
