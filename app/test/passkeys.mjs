/**
 * Passkeys and emailed codes: the ways in that are not a password.
 *
 * A real browser with a virtual authenticator (Chrome DevTools' `WebAuthn`
 * domain) stands in for Face ID or Windows Hello, so the whole ceremony runs:
 * Supabase's challenge, the browser's credential, Supabase's check.
 *
 * Skips, and says so, when the project has Passkeys switched off: the code
 * hides every passkey control then, so there is nothing to drive. The
 * emailed-code half runs either way.
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
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
const API = e.SUPABASE_URL;
const PUB = e.SUPABASE_PUBLISHABLE_KEY;
const SECRET = e.SUPABASE_SECRET_KEY;

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` +
              (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

const stamp = Date.now();
await sweepStaleTestUsers("passkeys", "fbwg_pk_");
const users = [];

const admin = (path, init = {}) => fetch(`${API}${path}`, {
  ...init,
  headers: {
    apikey: SECRET, Authorization: `Bearer ${SECRET}`,
    "content-type": "application/json", ...(init.headers ?? {}),
  },
});

/** A confirmed account with a password and a username, ready to sign in. */
async function makeUser(tag) {
  const email = `fbwg_pk_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_${tag}!A`;
  const created = await (await admin("/auth/v1/admin/users", {
    method: "POST", body: JSON.stringify({ email, password, email_confirm: true }),
  })).json();
  const u = { id: created.id, email, password };
  users.push(u);
  const token = await accessToken(u);
  await fetch(`${API}/rest/v1/rpc/claim_username`, {
    method: "POST",
    headers: { apikey: PUB, Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ new_username: `pk${tag}${String(stamp).slice(-6)}` }),
  });
  return u;
}

/** The secret key, because Supabase lets it past Turnstile and a test cannot solve one. */
async function accessToken(u) {
  const r = await (await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: SECRET, "content-type": "application/json" },
    body: JSON.stringify({ email: u.email, password: u.password }),
  })).json();
  return r.access_token;
}

/** A six-digit code from a TOTP secret, exactly as an authenticator app would. */
function totp(base32, at = Date.now()) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of base32.replace(/=+$/, "")) bits += A.indexOf(c).toString(2).padStart(5, "0");
  const bytes = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const buf = Buffer.alloc(8);
  const counter = Math.floor(at / 1000 / 30);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac("sha1", bytes).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1000000;
  return String(n).padStart(6, "0");
}

/** Mint the code an email would carry, without sending one. */
async function mintCode(body) {
  return (await (await admin("/auth/v1/admin/generate_link", {
    method: "POST", body: JSON.stringify(body),
  })).json()).email_otp;
}

async function startVite() {
  const vite = resolve(APP, "..", "node_modules", "vite", "bin", "vite.js");
  const server = spawn(process.execPath, [vite, "--port", String(PORT), "--strictPort"],
                       { cwd: APP, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", (d) => process.stderr.write(d));
  const deadline = Date.now() + 60000;
  for (;;) {
    if (Date.now() > deadline) { server.kill(); throw new Error("vite did not start"); }
    try {
      if ((await fetch(URL_, { signal: AbortSignal.timeout(2000) })).ok) return server;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
}

let playwright;
try { playwright = await import("playwright"); } catch {
  console.log("playwright not installed -- skipping");
  process.exit(0);
}
let browser;
try { browser = await playwright.chromium.launch(); } catch {
  console.log("chromium not installed -- skipping");
  process.exit(0);
}
const settings = await (await fetch(`${API}/auth/v1/settings`, { headers: { apikey: PUB } })).json();
const enabled = settings.passkeys_enabled === true;
const server = await startVite();

/**
 * A page with Turnstile stood in for, and a virtual authenticator attached.
 *
 * A virtual authenticator answers a pending autofill request at once, with
 * no field focused, so on a page that allows autofill the sign-in screen
 * signs itself in the moment it opens. `autofill: false` takes conditional
 * mediation away, so a check of the button is a check of the button.
 */
async function newPage({ autofill = true } = {}) {
  const ctx = await browser.newContext();
  await passCaptcha(ctx, API, SECRET, (path) => { failures++; console.log(`  FAIL no Turnstile token sent to ${path}`); },
                    { passkeys: true });
  if (!autofill) {
    await ctx.addInitScript(() => {
      PublicKeyCredential.isConditionalMediationAvailable = async () => false;
    });
  }
  const page = await ctx.newPage();
  page.on("pageerror", (err) => { failures++; console.log("  FAIL page error: " + err.message); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  page.keys = async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
  /** The same passkey on a second device, as a synced passkey would be. */
  page.give = (credential) => cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
  return page;
}

const errorText = (page) => page.locator(".error:visible").first().innerText().catch(() => "");
const arrived = (page, hash) => page.waitForFunction((h) => location.hash === h, hash, { timeout: 30000 })
  .then(() => true, () => false);

async function passwordSignIn(page, u) {
  await page.goto(URL_ + "#/login", { waitUntil: "load" });
  await page.fill("input[type=email]", u.email);
  await page.fill("input[type=password]", u.password);
  await page.click("button[type=submit]");
}

/**
 * Press "Sign In with a Passkey", and answer "Yes, use it" if this device is
 * asked first (it is when its localStorage has been cleared, as `signOut`
 * below does).
 */
async function usePasskey(page) {
  await page.click("button:has-text('Sign In with a Passkey')");
  const asked = page.locator(".passkey-hint button:has-text('Yes, use it')");
  if (await asked.isVisible().catch(() => false)) await asked.click();
}

async function signOut(page) {
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: "load" });
  await page.goto(URL_ + "#/login", { waitUntil: "load" });
}

try {
  // ---- the emailed code, from the sign-in form -----------------------------

  console.log("an emailed code signs an existing account in");
  {
    const u = await makeUser("code");
    const page = await newPage();
    await page.goto(URL_ + "#/login", { waitUntil: "load" });
    await page.fill("input[type=email]", u.email);
    await page.click("text=Email me a code");
    check("it goes to the code screen", await arrived(page, "#/verify"), true);
    check("worded so it does not say the account exists",
          await page.locator("text=If that address has an account").count(), 1);
    await page.fill("input[autocomplete=one-time-code]", await mintCode({ type: "magiclink", email: u.email }));
    await page.locator("button[type=submit]").first().click().catch(() => {});
    check("the code signs in", await page.waitForFunction(
      () => ["#/play", "#/passkey"].includes(location.hash), null, { timeout: 30000 })
      .then(() => true, () => false), true);
    await page.close();

    // The enumeration check. Supabase refuses a code for an unknown address
    // with its own error; the form must read exactly as it did above.
    const other = await newPage();
    await other.goto(URL_ + "#/login", { waitUntil: "load" });
    await other.fill("input[type=email]", `fbwg_pk_nobody_${stamp}@example.com`);
    await other.click("text=Email me a code");
    check("an unknown address reaches the same screen", await arrived(other, "#/verify"), true);
    check("with the same words",
          await other.locator("text=If that address has an account").count(), 1);
    check("and no error", await errorText(other), "");
    await other.close();
  }

  console.log("\nsign-up asks for an address, not a password");
  {
    const page = await newPage();
    await page.goto(URL_ + "#/signup", { waitUntil: "load" });
    const picks = page.locator(".age-row select");
    if (await picks.count()) {
      await picks.nth(0).selectOption("1");
      await picks.nth(1).selectOption("2000");
      await page.click("button[type=submit]:has-text('Continue')");
    }
    await page.waitForSelector("input[type=email]");
    check("no password field", await page.locator("input[type=password]").count(), 0);
    const fresh = `fbwg_pk_new_${stamp}@example.com`;
    await page.fill("input[type=email]", fresh);
    await page.click("button[type=submit]");
    check("the code screen names the address", await arrived(page, "#/verify") &&
          await page.locator(`text=${fresh}`).count() > 0, true);
    const all = await (await admin("/auth/v1/admin/users?page=1&per_page=1000")).json();
    const made = (all.users ?? []).find((x) => x.email === fresh);
    if (made) users.push({ id: made.id, email: fresh });
    await page.fill("input[autocomplete=one-time-code]", await mintCode({ type: "magiclink", email: fresh }));
    await page.locator("button[type=submit]").first().click().catch(() => {});
    check("the code makes the account, and asks for a name",
          await page.waitForSelector("text=Pick a name", { timeout: 30000 }).then(() => true, () => false), true);
    const tok = await (await admin(`/auth/v1/admin/users/${made?.id}`)).json();
    check("an account made this way has no password", !!tok.encrypted_password, false);
    await page.close();
  }

  if (!enabled) {
    console.log("\nPasskeys are switched off for this project -- passkey checks skipped");
  } else {
    console.log("\na device with no passkey is told how to get one");
    {
      const bare = await newPage({ autofill: false });
      await bare.goto(URL_ + "#/login", { waitUntil: "load" });
      await bare.click("button:has-text('Sign In with a Passkey')");
      check("it asks first, instead of opening the system's sheet",
            await bare.waitForSelector(".passkey-hint:visible", { timeout: 10000 }).then(() => true, () => false), true);
      check("whether a passkey was ever saved", (await bare.locator(".passkey-hint").innerText()).includes("Have you saved a passkey"), true);
      await bare.click(".passkey-hint a:has-text('No, create one')");
      check("and No leads to Create a Passkey",
            await bare.waitForFunction(() => location.hash === "#/create-passkey", null, { timeout: 10000 }).then(() => true, () => false), true);
      await bare.close();
    }

    console.log("\na passkey is offered after a password sign-in, and saved");
    const u = await makeUser("key");
    const page = await newPage({ autofill: false });
    await passwordSignIn(page, u);
    check("the offer comes first", await arrived(page, "#/passkey") &&
          await page.waitForSelector("text=Sign in faster next time").then(() => true, () => false), true);
    await page.click("button:has-text('Save a passkey')");
    check("saving goes on to the game", await arrived(page, "#/play"), true);
    check("the device holds one passkey", (await page.keys()).length, 1);

    console.log("\nSettings lists it");
    await page.goto(URL_ + "#/settings", { waitUntil: "load" });
    const row = page.locator('.settings-group:has(.settings-name:text-is("Passkeys"))');
    check("the row says how many", await row.locator(".settings-value").innerText()
      .then(async (t) => t === "Checking…" ? (await page.waitForTimeout(1500), row.locator(".settings-value").innerText()) : t),
      "1 saved");

    console.log("\nthe passkey signs back in, with no address and no offer");
    await signOut(page);
    await usePasskey(page);
    check("straight to the game", await arrived(page, "#/play"), true);

    console.log("\nthe email field offers it too (autofill)");
    await signOut(page);
    check("the email field asks the browser for passkeys",
          await page.locator("input[type=email]").getAttribute("autocomplete"), "email webauthn");
    const synced = await newPage();
    const [key] = await page.keys();
    await synced.give(key);
    await synced.goto(URL_ + "#/login", { waitUntil: "load" });
    if (await synced.evaluate(() => PublicKeyCredential.isConditionalMediationAvailable?.() ?? false)) {
      check("nothing is asked of the browser before the field is used",
            await synced.waitForFunction(() => location.hash === "#/play", null, { timeout: 4000 }).then(() => true, () => false), false);
      // Focusing the field starts the autofill request, and the virtual
      // authenticator answers it, which is what picking the passkey does.
      await synced.click("input[type=email]");
      check("picking it from the list signs in", await arrived(synced, "#/play"), true);
    } else {
      console.log("  skipped: this browser has no conditional mediation");
    }
    await synced.close();

    console.log("\na passkey does not skip two-factor");
    const token = await accessToken(u);
    const as = (path, body) => fetch(`${API}/auth/v1/${path}`, {
      method: "POST", headers: { apikey: PUB, Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body) }).then((r) => r.json());
    const factor = await as("factors", { factor_type: "totp", friendly_name: `pk-${stamp}` });
    const challenge = await as(`factors/${factor.id}/challenge`, {});
    await as(`factors/${factor.id}/verify`, { challenge_id: challenge.id, code: totp(factor.totp.secret) });
    await signOut(page);
    await usePasskey(page);
    const where = await page.waitForFunction(() => ["#/unlock", "#/play"].includes(location.hash),
      null, { timeout: 30000 }).then(() => page.evaluate(() => location.hash), () => "nowhere");
    check("a passkey sign-in still asks for the code", where, "#/unlock");
    await page.close();

    console.log("\nremoving it in Settings");
    const v = await makeUser("remove");
    const page2 = await newPage({ autofill: false });
    await passwordSignIn(page2, v);
    await arrived(page2, "#/passkey");
    await page2.click("button:has-text('Save a passkey')");
    await arrived(page2, "#/play");
    await page2.goto(URL_ + "#/settings", { waitUntil: "load" });
    const row2 = page2.locator('.settings-group:has(.settings-name:text-is("Passkeys"))');
    await row2.locator("summary").click();
    await row2.locator("button:has-text('Remove')").click();
    check("the row says none are left", await row2.locator(".settings-value")
      .filter({ hasText: "None" }).waitFor({ timeout: 15000 }).then(() => true, () => false), true);
    await signOut(page2);
    await usePasskey(page2);
    await page2.waitForSelector(".error:visible", { timeout: 30000 }).catch(() => {});
    check("and the removed passkey no longer signs in", await page2.evaluate(() => location.hash), "#/login");
    await page2.close();
  }
} catch (err) {
  failures++;
  console.log("  FAIL " + err.message);
} finally {
  await browser.close().catch(() => {});
  server.kill();
  for (const u of users) await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  console.log(`\ncleaned up ${users.length} test users`);
}

console.log("\n" + (failures === 0 ? "PASSKEYS PASSED" : `PASSKEYS FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
