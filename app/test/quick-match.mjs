/**
 * Quick Match from end to end: two strangers, two browsers, one game.
 *
 * Neither account knows the other. Both press Quick Match, the server pairs
 * them, and the game starts on its own -- the roles each asked for, the same
 * level, the same physics. Then the things a match is NOT: a friend, or a game
 * anybody can watch. Local only, for the reason `supabase/quickmatchtest.mjs`
 * gives: the queue is shared by everybody on a project.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { env, open } from "../../supabase/connect.mjs";
import { passCaptcha } from "./captcha.mjs";
import { sweepStaleTestUsers } from "../../supabase/sweep.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const PORT = 5197;
const URL_ = `http://localhost:${PORT}/`;

const e = env();
const API = e.SUPABASE_URL;
const SECRET = e.SUPABASE_SECRET_KEY;
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(API)) {
  console.log("quick-match: skipped -- not a local stack");
  process.exit(0);
}

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` + (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

const stamp = Date.now();
await sweepStaleTestUsers("quick-match", "fbwg_qme2e_");
const users = [];
const admin = (path, init = {}) => fetch(`${API}${path}`, {
  ...init, headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, "content-type": "application/json", ...(init.headers ?? {}) },
});
async function makeUser(tag) {
  const email = `fbwg_qme2e_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_${tag}!A`;
  const created = await (await admin("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email, password, email_confirm: true }) })).json();
  if (!created.id) throw new Error("could not create a user");
  const u = { id: created.id, email, password, username: `qm${tag}${stamp % 100000}` };
  users.push(u);
  return u;
}

async function startVite() {
  const vite = resolve(APP, "..", "node_modules", "vite", "bin", "vite.js");
  const server = spawn(process.execPath, [vite, "--port", String(PORT), "--strictPort"],
    { cwd: APP, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SUPABASE_URL: API, SUPABASE_PUBLISHABLE_KEY: e.SUPABASE_PUBLISHABLE_KEY } });
  server.stderr.on("data", (d) => process.stderr.write(d));
  const deadline = Date.now() + 60000;
  for (;;) {
    if (Date.now() > deadline) { server.kill(); throw new Error("vite did not start"); }
    try { if ((await fetch(URL_, { signal: AbortSignal.timeout(2000) })).ok) return server; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function signIn(page, user) {
  await page.goto(URL_ + "#/login", { waitUntil: "load" });
  await page.waitForSelector("input[type=email]", { timeout: 30000 });
  await page.fill("input[type=email]", user.email);
  await page.fill("input[type=password]", user.password);
  await page.click("button[type=submit]");
  await page.waitForSelector("text=Pick a name", { timeout: 30000 });
  await page.locator("form input").first().fill(user.username);
  await page.click("button[type=submit]");
  await page.waitForSelector("#stage", { timeout: 30000 });
}

const playwright = await import("playwright");
const browser = await playwright.chromium.launch();
const server = await startVite();
const db = await open({ quiet: true });

try {
  await db.query("delete from play_private.quick_queue");
  const alice = await makeUser("a");
  const bob = await makeUser("b");
  const pages = [];
  for (const tag of ["A", "B"]) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    await passCaptcha(ctx, API, SECRET, (path) => { failures++; console.log(`  FAIL no Turnstile token sent to ${path}`); });
    const p = await ctx.newPage();
    p.on("pageerror", (err) => { failures++; console.log(`  FAIL [${tag}] page error: ${err.message}`); });
    p.on("console", (m) => { if (m.type() === "error") console.log(`  [${tag}] ${m.text()}`); });
    p.on("response", (r) => { if (r.status() >= 400) console.log(`  [${tag}] HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
    pages.push(p);
  }
  const [a, b] = pages;
  await signIn(a, alice);
  await signIn(b, bob);

  console.log("\nthe card is where it belongs");
  for (const p of [a, b]) await p.waitForSelector(".qm .qm-go");
  const order = await a.evaluate(() => [...document.querySelector(".friends-hub").children].map(c =>
    c.classList.contains("qm") ? "quick" : c.querySelector(".friends-toggle") ? "friends" : c.querySelector(".add-friend") ? "add" : null).filter(Boolean));
  check("between Your Friends and Add a Friend", order, ["friends", "quick", "add"]);
  check("the old intro is gone", await a.locator(".social-intro").count(), 0);
  await a.click(".friends-toggle");
  check("Your Friends folds", await a.locator(".friends-toggle").getAttribute("aria-expanded"), "false");
  await a.click(".friends-toggle");

  console.log("\nboth press Quick Match");
  await a.click(".qm-seg button:has-text('Fireboy')");
  check("the picker remembers Fireboy, in Fireboy's colour", await a.locator(".qm-seg").getAttribute("data-pick"), "fireboy");
  check("and says so to a screen reader", await a.locator(".qm-seg button:has-text('Fireboy')").getAttribute("aria-checked"), "true");
  await a.click(".qm-go");
  await a.waitForSelector(".qm-ring.searching");
  check("alice is searching", await a.locator(".qm-headline h4").innerText(), "Finding a partner");
  await a.waitForTimeout(2500);
  check("the bar is counting", Number((await a.locator(".qm-pct").innerText()).replace("%", "")) > 0, true);
  await b.click(".qm-go");

  console.log("\nthe server pairs them and the game starts by itself");
  for (const p of [a, b]) await p.waitForFunction("window.__fbwg && window.__fbwg.view.session", null, { timeout: 60000 });
  const slots = await Promise.all([a, b].map((p) => p.evaluate(() => window.__fbwg.view.slot)));
  check("alice asked to be Fireboy and is", slots, [0, 1]);
  check("online, each footer shows only that player's own keys",
        await Promise.all([a, b].map((p) => p.locator(".keys-legend").getAttribute("data-mode"))), ["fire", "water"]);
  await Promise.all([a, b].map((p) => p.waitForFunction("window.__fbwg.view.level !== null", null, { timeout: 30000 })));
  check("both are on Adventure 1", await Promise.all([a, b].map((p) => p.evaluate(() => [window.__fbwg.view.level.CurrentMode, window.__fbwg.view.session.selection.num]))),
        [["adventure", 1], ["adventure", 1]]);

  console.log("\nthey simulate the same game");
  await a.click("#stage"); await b.click("#stage");
  await a.keyboard.down("ArrowRight"); await b.keyboard.down("KeyA");
  await a.waitForTimeout(2000);
  await a.keyboard.up("ArrowRight"); await b.keyboard.up("KeyA");
  let agreed = false;
  for (let i = 0; i < 20 && !agreed; i++) {
    await a.waitForTimeout(250);
    const at = await Promise.all([a, b].map((p) => p.evaluate(() => {
      const lv = window.__fbwg.view.level;
      return [lv.pers1.GetPosition().x.toFixed(3), lv.pers2.GetPosition().x.toFixed(3)];
    })));
    agreed = JSON.stringify(at[0]) === JSON.stringify(at[1]);
  }
  check("both screens agree where everybody is", agreed, true);

  console.log("\nwhat a match is not");
  check("bob is not in alice's friends", await a.locator(`.friend-row:has-text("${bob.username}")`).count(), 0);
  await a.click("button.tool-menu");
  check("watching is not offered", await a.locator("button:has-text('Let friends watch')").isVisible(), false);
  check("adding him is", await a.locator(`button:has-text('Add ${bob.username} as a friend')`).isVisible(), true);
  check("so is blocking him", await a.locator(`button:has-text('Block ${bob.username}')`).isVisible(), true);
  const row = async () => (await db.query("select status from public.friendships where user_a = least($1::uuid,$2::uuid) and user_b = greatest($1::uuid,$2::uuid)", [alice.id, bob.id])).rows[0]?.status;
  check("the server has a live match", await row(), "matched");

  console.log("\nalice leaves");
  a.once("dialog", (d) => d.accept());
  await a.click("button.leave");
  await b.waitForFunction("!window.__fbwg.view.session", null, { timeout: 30000 });
  check("bob is told", (await b.locator(".banner").innerText()).includes("left"), true);
  for (let i = 0; i < 20 && await row() !== "ended"; i++) await a.waitForTimeout(250);
  check("and the match is over on the server", await row(), "ended");
  check("bob can search again", await b.locator(".qm-go:not(.qm-keep)").isEnabled(), true);
} catch (err) {
  failures++;
  console.log("  FAIL " + err.message);
} finally {
  await db.query("delete from play_private.quick_queue").catch(() => {});
  await db.end();
  await browser.close().catch(() => {});
  server.kill();
  for (const u of users) await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  console.log(`\ncleaned up ${users.length} test users`);
}

console.log("\n" + (failures === 0 ? "QUICK MATCH PASSED" : `QUICK MATCH FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
