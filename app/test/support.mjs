/**
 * Support, in a browser: the page a player actually uses.
 *
 * Signed out it asks for a sign-in and comes back after one; signed in it
 * files a ticket with a pasted screenshot and a file, lists it, follows the
 * stage the developer sets, and moves it to Deleted. The Menu's button opens
 * it in a new tab. `supabase/supporttest.mjs` proves the same rules hold
 * without the page.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { env } from "../../supabase/connect.mjs";
import { passCaptcha } from "./captcha.mjs";
import { sweepStaleTestUsers } from "../../supabase/sweep.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const PORT = 5198;
const URL_ = `http://localhost:${PORT}/`;
const e = env();
const API = e.SUPABASE_URL, PUB = e.SUPABASE_PUBLISHABLE_KEY, SECRET = e.SUPABASE_SECRET_KEY;
const admin = (path, init = {}) => fetch(`${API}${path}`, { ...init, headers: {
  apikey: SECRET, Authorization: `Bearer ${SECRET}`, "content-type": "application/json", ...(init.headers ?? {}) } });

let failures = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` + (ok ? "" : ` (expected ${JSON.stringify(want)})`));
};
const stamp = Date.now();
await sweepStaleTestUsers("support", "fbwg_sup_");

async function startVite() {
  const vite = resolve(APP, "..", "node_modules", "vite", "bin", "vite.js");
  const server = spawn(process.execPath, [vite, "--port", String(PORT), "--strictPort"], { cwd: APP, stdio: ["ignore", "pipe", "pipe"] });
  const deadline = Date.now() + 60000;
  for (;;) {
    if (Date.now() > deadline) { server.kill(); throw new Error("vite did not start"); }
    try { if ((await fetch(URL_, { signal: AbortSignal.timeout(2000) })).ok) return server; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
}

let playwright;
try { playwright = await import("playwright"); } catch { console.log("playwright not installed -- skipping"); process.exit(0); }
const browser = await playwright.chromium.launch();
const server = await startVite();

const email = `fbwg_sup_${stamp}@example.com`, password = `pw_${stamp}_sup!A`;
const user = await (await admin("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email, password, email_confirm: true }) })).json();
const token = (await (await fetch(`${API}/auth/v1/token?grant_type=password`, { method: "POST",
  headers: { apikey: SECRET, "content-type": "application/json" }, body: JSON.stringify({ email, password }) })).json()).access_token;
await fetch(`${API}/rest/v1/rpc/claim_username`, { method: "POST",
  headers: { apikey: PUB, Authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ new_username: `sup${String(stamp).slice(-6)}` }) });

try {
  const ctx = await browser.newContext();
  await passCaptcha(ctx, API, SECRET, (path) => { failures++; console.log(`  FAIL no Turnstile token sent to ${path}`); });
  const page = await ctx.newPage();
  page.on("pageerror", (err) => { failures++; console.log("  FAIL page error: " + err.message); });

  console.log("signed out, it asks for a sign-in and comes back");
  await page.goto(URL_ + "support-ticket", { waitUntil: "load" });
  check("the clean address lands on the Support route", page.url().endsWith("#/support-ticket"), true);
  check("signed out, it asks for a sign-in",
        await page.waitForSelector("text=Sign in to open a ticket", { timeout: 20000 }).then(() => true, () => false), true);
  check("and gives the address for anybody who cannot", await page.locator("a[href^='mailto:']").count(), 1);
  await page.click("a:has-text('Sign In')");
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", password);
  await page.click("button[type=submit]");
  check("signing in comes back to Support",
        await page.waitForFunction(() => location.hash === "#/support-ticket", null, { timeout: 30000 }).then(() => true, () => false), true);

  console.log("\nfiling a ticket with a pasted screenshot and a file");
  await page.waitForSelector(".attach-drop");
  check("with no tickets yet, it opens on the form", await page.locator("text=What's going on?").count(), 1);
  await page.evaluate(async () => {
    const png = await (await fetch("/og.png")).blob();
    const pasted = new DataTransfer(); pasted.items.add(new File([png], "image.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: pasted, bubbles: true }));
    const dropped = new DataTransfer(); dropped.items.add(new File(["a log line\n"], "log.txt", { type: "text/plain" }));
    document.querySelector(".attach-drop").dispatchEvent(new DragEvent("drop", { dataTransfer: dropped, bubbles: true, cancelable: true }));
  });
  check("both attachments are listed", await page.locator(".attachments li").count(), 2);
  check("a paste is named as a screenshot", await page.locator(".attach-name").first().innerText().then((t) => t.startsWith("screenshot-1.png")), true);
  await page.evaluate(() => {
    const big = new DataTransfer(); big.items.add(new File([new Uint8Array(11 * 1024 * 1024)], "huge.bin"));
    document.querySelector(".attach-drop").dispatchEvent(new DragEvent("drop", { dataTransfer: big, bubbles: true, cancelable: true }));
  });
  check("a file that would pass 10 MB is turned away", await page.locator(".error:visible").innerText().then((t) => t.includes("10.0 MB")), true);
  await page.fill(".support-message", "The fire door on level 12 stays shut for me.");
  await page.click("button:has-text('Send to Support')");
  check("the ticket shows on the board",
        await page.waitForSelector(".ticket", { timeout: 30000 }).then(() => true, () => false), true);
  check("as open, and sent", await page.locator(".ticket-badge").first().innerText(), "Sent");

  console.log("\nit follows the stage the developer sets");
  const [row] = await (await admin(`/rest/v1/support_tickets?user_id=eq.${user.id}&select=id,attachments`)).json();
  check("both files are stored with the ticket", row.attachments.length, 2);
  await admin(`/rest/v1/support_tickets?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ stage: "fixed" }) });
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".ticket-tabs");
  check("a fixed ticket leaves the open pile", await page.locator(".ticket").count(), 0);
  // Switching piles re-sorts what is loaded: no request, no loading line.
  let fetched = 0;
  const counting = (r) => { if (r.url().includes("/rest/v1/support_tickets")) fetched++; };
  page.on("request", counting);
  await page.click(".ticket-tabs button:has-text('Completed')");
  await page.click(".ticket-tabs button:has-text('Deleted')");
  await page.click(".ticket-tabs button:has-text('Completed')");
  check("switching piles fetches nothing", fetched, 0);
  check("and never shows the loading line", await page.locator("text=Loading your tickets").count(), 0);
  page.off("request", counting);
  await page.locator(".ticket > summary").first().click();
  check("and is under Completed, every step lit", await page.locator(".ticket-track li.done, .ticket-track li.now").count(), 4);

  console.log("\ndeleting keeps it, as Deleted");
  page.once("dialog", (d) => d.accept());
  await page.click("button:has-text('Delete ticket')");
  await page.click(".ticket-tabs button:has-text('Deleted')");
  check("it is under Deleted", await page.locator(".ticket-badge").first().innerText().catch(() => ""), "Deleted");

  console.log("\nthe Menu opens it in a new tab");
  await page.goto(URL_ + "#/play", { waitUntil: "load" });
  await page.waitForFunction(() => location.hash === "#/play");
  await page.click("button:has-text('Menu')");
  const link = page.locator(".menu-support a");
  check("the button says what it does", await link.innerText(), "Contact Support");
  check("and opens a new tab", [await link.getAttribute("target"), await link.getAttribute("href")], ["_blank", "/support-ticket"]);
  const [tab] = await Promise.all([ctx.waitForEvent("page"), link.click()]);
  await tab.waitForLoadState("load");
  check("still signed in there", await tab.waitForSelector(".ticket-tabs", { timeout: 30000 }).then(() => true, () => false), true);
} catch (err) {
  failures++;
  console.log("  FAIL " + err.message);
} finally {
  await browser.close().catch(() => {});
  server.kill();
  const folders = await (await admin("/storage/v1/object/list/support-attachments", { method: "POST",
    body: JSON.stringify({ prefix: user.id, limit: 100 }) })).json().catch(() => []);
  for (const f of Array.isArray(folders) ? folders : []) {
    const inner = await (await admin("/storage/v1/object/list/support-attachments", { method: "POST",
      body: JSON.stringify({ prefix: `${user.id}/${f.name}`, limit: 100 }) })).json().catch(() => []);
    const prefixes = (Array.isArray(inner) ? inner : []).map((x) => `${user.id}/${f.name}/${x.name}`);
    if (prefixes.length) await admin("/storage/v1/object/support-attachments", { method: "DELETE", body: JSON.stringify({ prefixes }) });
  }
  await admin(`/auth/v1/admin/users/${user.id}`, { method: "DELETE" });
}
console.log("\n" + (failures === 0 ? "SUPPORT PAGE PASSED" : `SUPPORT PAGE FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
