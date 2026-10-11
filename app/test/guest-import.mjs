/**
 * Guest progress joining an account, in a real browser against a local stack.
 *
 * A browser that played as a guest (`#/play` signed out) signs in from the
 * guest screen's own "Sign in". The account is asked once; Add puts the guest's
 * levels into the account on the server and only then clears the guest copy,
 * and Not mine leaves the guest copy exactly as it was. A guest screen left
 * open while another tab signs in becomes the signed-in screen in place, and
 * signing out of it goes to the sign-in form, not back to guest play.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { env, open } from "../../supabase/connect.mjs";
import { passCaptcha } from "./captcha.mjs";
import { sweepStaleTestUsers } from "../../supabase/sweep.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5196;
const URL_ = `http://localhost:${PORT}/`;
const e = env();
const API = e.SUPABASE_URL;
const SECRET = e.SUPABASE_SECRET_KEY;
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(API)) {
  console.log("guest-import: skipped -- not a local stack");
  process.exit(0);
}

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` + (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

const stamp = Date.now();
await sweepStaleTestUsers("guest-import", "fbwg_gi_");
const users = [];
const admin = (path, init = {}) => fetch(`${API}${path}`, {
  ...init, headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, "content-type": "application/json", ...(init.headers ?? {}) },
});
async function makeUser(tag) {
  const email = `fbwg_gi_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_${tag}!A`;
  const created = await (await admin("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email, password, email_confirm: true }) })).json();
  if (!created.id) throw new Error("could not create a user");
  const u = { id: created.id, email, password, username: `gi${tag}${stamp % 100000}` };
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

async function signIn(page, user, { fromGuest = false } = {}) {
  if (fromGuest) {
    await page.goto(URL_ + "#/play", { waitUntil: "load" });
    await page.locator(".online-card").getByRole("link", { name: "Sign in" }).click({ timeout: 30000 });
  } else await page.goto(URL_ + "#/login", { waitUntil: "load" });
  await page.waitForSelector("input[type=email]", { timeout: 30000 });
  await page.fill("input[type=email]", user.email);
  await page.fill("input[type=password]", user.password);
  await page.click("button[type=submit]");
  await page.waitForSelector("text=Pick a name", { timeout: 30000 });
  await page.locator("form input").first().fill(user.username);
  await page.click("button[type=submit]");
  await page.waitForSelector("#stage", { timeout: 30000 });
}

// Two cleared levels, one with a time, as guest play would have saved them.
const stats = new Array(32).fill(-1), times = new Array(32).fill(0), timesString = new Array(32).fill("");
stats[0] = 3; times[0] = 40; timesString[0] = "00:40";
stats[1] = 2; stats[2] = 0;
const GUEST = JSON.stringify({ stats, times, timesString });

const playwright = await import("playwright");
const browser = await playwright.chromium.launch();
const server = await startVite();
const db = await open({ quiet: true });

async function guestBrowser() {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  await passCaptcha(ctx, API, SECRET, (path) => { failures++; console.log(`  FAIL no Turnstile token sent to ${path}`); });
  // Seeded once, before the app runs, the way an earlier guest visit left it.
  await ctx.addInitScript((value) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("FBCookie:guest", value);
  }, GUEST);
  const page = await ctx.newPage();
  page.on("pageerror", (err) => { failures++; console.log(`  FAIL page error: ${err.message}`); });
  return page;
}

try {
  console.log("\nan account that says it is theirs");
  const ann = await makeUser("a");
  const a = await guestBrowser();
  await signIn(a, ann, { fromGuest: true });
  check("signing in from the guest screen lands on /play", await a.evaluate(() => location.hash), "#/play");
  const banner = a.locator(".banner");
  await banner.getByText("guest progress").waitFor({ timeout: 30000 });
  check("is asked, with the real counts", await banner.locator("span").first().innerText(),
        "This browser has guest progress: 2 levels cleared, 1 with times. Add it to your account?");
  await banner.getByRole("button", { name: "Add to my account" }).click();
  await banner.getByText("Added to your account.").waitFor({ timeout: 30000 });
  const rows = (await db.query("select node, medal, best_time_s from public.solo_progress where user_id = $1 and medal >= 1 order by node", [ann.id])).rows;
  check("the levels are on the server", rows.map(r => [r.node, r.medal, r.best_time_s]), [[1, 3, 40], [2, 2, null]]);
  check("and the guest copy is gone", await a.evaluate(() => localStorage.getItem("FBCookie:guest")), null);
  await a.reload(); await a.waitForSelector("#stage"); await a.waitForTimeout(3000);
  check("nobody is asked again", await a.locator(".banner:has-text('guest progress')").count(), 0);

  console.log("\nan account that says it is not");
  const ben = await makeUser("b");
  const b = await guestBrowser();
  await signIn(b, ben);
  await b.locator(".banner").getByText("guest progress").waitFor({ timeout: 30000 });
  await b.locator(".banner").getByRole("button", { name: "Not mine" }).click();
  check("the guest copy is untouched", await b.evaluate(() => localStorage.getItem("FBCookie:guest")), GUEST);
  check("nothing reached the account", Number((await db.query("select count(*) from public.solo_progress where user_id = $1 and medal >= 1", [ben.id])).rows[0].count), 0);
  await b.reload(); await b.waitForSelector("#stage"); await b.waitForTimeout(3000);
  check("and this account is not asked again", await b.locator(".banner:has-text('guest progress')").count(), 0);

  console.log("\na guest screen left open while another tab signs in");
  const cat = await makeUser("c");
  // Named first, elsewhere: a nameless account is sent to /username in every
  // tab, which is the router doing its job and not what is under test here.
  const naming = await browser.newContext();
  await passCaptcha(naming, API, SECRET, () => {});
  await signIn(await naming.newPage(), cat);
  await naming.close();
  const c = await guestBrowser();
  await c.goto(URL_ + "#/play", { waitUntil: "load" });
  await c.locator(".guest-chip").waitFor({ timeout: 30000 });
  const other = await c.context().newPage();
  await other.goto(URL_ + "#/login", { waitUntil: "load" });
  await other.fill("input[type=email]", cat.email);
  await other.fill("input[type=password]", cat.password);
  await other.click("button[type=submit]");
  await other.waitForSelector("#stage", { timeout: 30000 });
  await c.locator(".copy-name").waitFor({ timeout: 30000 });
  check("becomes the signed-in screen in place", [await c.evaluate(() => location.hash), await c.locator(".guest-chip").count()], ["#/play", 0]);
  await c.locator(".banner").getByText("guest progress").waitFor({ timeout: 30000 });
  check("and offers the guest progress there too", true, true);
  await c.getByRole("button", { name: "Menu", exact: true }).click();
  await c.getByRole("button", { name: "Sign out", exact: true }).click();
  await c.waitForSelector("input[type=password]", { timeout: 30000 });
  check("signing out goes to the sign-in form", await c.evaluate(() => location.hash), "#/login");
} catch (err) {
  failures++;
  console.log("  FAIL " + err.message);
} finally {
  await db.end();
  await browser.close().catch(() => {});
  server.kill();
  for (const u of users) await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  console.log(`\ncleaned up ${users.length} test users`);
}

console.log("\n" + (failures === 0 ? "GUEST IMPORT PASSED" : `GUEST IMPORT FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
