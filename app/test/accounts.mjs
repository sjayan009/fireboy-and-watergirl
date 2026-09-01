/**
 * Getting in, and being kept out.
 *
 * `twopeople.mjs` proves the happy path once two accounts exist. This proves
 * the door: the invite gate, the username rules, two-factor, and -- the part
 * that was previously untestable -- the emailed links.
 *
 * ## How the email flows are tested without email
 *
 * The admin API's `generate_link` returns the confirmation and recovery URLs
 * without sending anything. Following one in a real browser exercises exactly
 * what a person clicking a real email would: Supabase verifies the token,
 * redirects to the app with `?code=` in the query string, the client exchanges
 * it, and the app routes on `?intent=`. That whole path used to be a paragraph
 * of reasoning; it is now a test.
 *
 * What remains untestable here is delivery -- that a message actually arrives
 * in somebody's inbox -- which needs a real SMTP sender configured.
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { env } from "../../supabase/connect.mjs";

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
const users = [];

const admin = (path, init = {}) => fetch(`${API}${path}`, {
  ...init,
  headers: {
    apikey: SECRET, Authorization: `Bearer ${SECRET}`,
    "content-type": "application/json", ...(init.headers ?? {}),
  },
});

async function makeCode(n, uses = 1, expiresAt = null) {
  // Uppercase, because the database now insists and the form uppercases what
  // it is given. A lowercase code would be minted happily and then be
  // unusable, which is the bug this constraint exists to prevent.
  const code = `ACC-${stamp}-${n}`.toUpperCase();
  await admin("/rest/v1/invite_codes", {
    method: "POST",
    body: JSON.stringify({ code, max_uses: uses, note: "accounts",
                           expires_at: expiresAt }),
  });
  return code;
}

async function makeUser(tag) {
  const email = `fbwg_acc_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_${tag}!A`;
  const created = await (await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true }),
  })).json();
  const u = { id: created.id, email, password, tag };
  users.push(u);
  return u;
}

/** A six-digit code from a TOTP secret, exactly as an authenticator app would. */
function totp(base32, at = Date.now()) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of base32.replace(/=+$/, "")) {
    bits += A.indexOf(c).toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac("sha1", bytes).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3])
            % 1000000;
  return String(n).padStart(6, "0");
}

async function startVite() {
  const vite = resolve(APP, "..", "node_modules", "vite", "bin", "vite.js");
  const server = spawn(
    process.execPath, [vite, "--port", String(PORT), "--strictPort"],
    { cwd: APP, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", (d) => process.stderr.write(d));
  const deadline = Date.now() + 60000;
  for (;;) {
    if (Date.now() > deadline) { server.kill(); throw new Error("vite did not start"); }
    try {
      const r = await fetch(URL_, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return server;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
}

let playwright;
try {
  playwright = await import("playwright");
} catch {
  console.log("playwright not installed -- skipping");
  process.exit(0);
}
let browser;
try {
  browser = await playwright.chromium.launch();
} catch {
  console.log("chromium not installed -- skipping");
  process.exit(0);
}
const server = await startVite();

/** A fresh browser context, so each account has its own storage. */
async function newPage() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (err) => {
    failures++;
    console.log("  FAIL page error: " + err.message);
  });
  return page;
}

const errorText = (page) =>
  page.locator(".error:visible").first().innerText().catch(() => "");

try {
  // ---- sign-up validation, before anything reaches the server -------------

  console.log("the sign-up form refuses what it should");
  {
    const page = await newPage();
    await page.goto(URL_ + "#/signup", { waitUntil: "load" });
    await page.waitForSelector("text=Make an account");

    const fill = async (email, pw, again) => {
      await page.fill("input[type=email]", email);
      const pws = page.locator("input[type=password]");
      await pws.nth(0).fill(pw);
      await pws.nth(1).fill(again);
      await page.click("button[type=submit]");
      await page.waitForTimeout(400);
      return errorText(page);
    };

    check("mismatched passwords",
          /not the same/.test(await fill("a@example.com", "abcdefgh", "abcdefgi")),
          true);
    // The input carries `minlength`, so the browser refuses to submit at all
    // and the script's own check never runs. Asserting on the error text would
    // be asserting that the weaker of the two guards is the one doing the work.
    await fill("a@example.com", "abc", "abc");
    check("a short password never leaves the form",
          await page.locator("text=Make an account").isVisible(), true);
    await page.close();
  }

  // ---- the emailed confirmation link -------------------------------------

  console.log("\nthe confirmation link in the email actually works");
  {
    const email = `fbwg_link_${stamp}@example.com`;
    const password = `pw_${stamp}_link!A`;
    // Created unconfirmed, exactly as signing up leaves it.
    const created = await (await admin("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, password, email_confirm: false }),
    })).json();
    users.push({ id: created.id, email, password, tag: "link" });
    check("the account starts unconfirmed", !created.email_confirmed_at, true);

    const linked = await (await admin("/auth/v1/admin/generate_link", {
      method: "POST",
      body: JSON.stringify({ type: "signup", email, password,
                             redirect_to: URL_ }),
    })).json();
    check("a confirmation link was generated",
          typeof linked.hashed_token === "string", true);

    // The token-hash form, not the `action_link`. A server-generated link
    // cannot complete a PKCE exchange -- the verifier lives in whichever
    // browser began the flow, and no browser began this one -- so it is also
    // the form that works when somebody opens the email on a different device
    // from the one they signed up on.
    const page = await newPage();
    await page.goto(
      `${URL_}?token_hash=${linked.hashed_token}&type=signup`,
      { waitUntil: "load" });
    // Supabase verifies, then redirects to the app with ?code=. The client
    // exchanges it and the guard routes on what it finds.
    try {
      await page.waitForSelector("text=Pick a name", { timeout: 30000 });
    } catch {
      console.log("  [where] " + page.url());
      console.log("  [page] " + (await page.evaluate(
        () => document.body.innerText.slice(0, 200))));
      throw new Error("the confirmation link did not land on the app");
    }
    check("following it lands on the username screen, signed in", true, true);

    const after = await (await admin(
      `/auth/v1/admin/users/${created.id}`)).json();
    check("and the account is now confirmed", !!after.email_confirmed_at, true);

    // ---- the invite gate, from the browser -------------------------------
    console.log("\nthe invite gate, as a person meets it");
    const nameFor = (v) => page.locator("form input").nth(0).fill(v);
    const codeFor = (v) => page.locator("form input").nth(1).fill(v);
    const submit = async () => {
      await page.click("button[type=submit]");
      await page.waitForTimeout(700);
      return errorText(page);
    };

    await nameFor(`link${stamp % 100000}`);
    await codeFor("NOPE-NOPE-NOPE");
    check("a code that does not exist",
          /not valid/.test(await submit()), true);

    const spent = await makeCode("spent", 1);
    const eater = await makeUser("eater");
    await fetch(`${API}/rest/v1/rpc/claim_username`, {
      method: "POST",
      headers: { apikey: PUB, "content-type": "application/json",
                 Authorization: `Bearer ${(await (await fetch(
                   `${API}/auth/v1/token?grant_type=password`, {
                     method: "POST",
                     headers: { apikey: PUB, "content-type": "application/json" },
                     body: JSON.stringify({ email: eater.email,
                                            password: eater.password }),
                   })).json()).access_token}` },
      body: JSON.stringify({ new_username: `eat${stamp % 100000}`,
                             invite_code: spent }),
    });
    await codeFor(spent);
    check("a code somebody else has spent",
          /not valid/.test(await submit()), true);

    const expired = await makeCode("expired", 5,
                                   new Date(Date.now() - 60000).toISOString());
    await codeFor(expired);
    check("an expired code", /not valid/.test(await submit()), true);

    // `minlength` and `pattern` on the input mean the browser refuses to submit
    // at all, so there is no message from the server to read -- the right
    // assertion is that nothing happened, not that something was said.
    const good = await makeCode("good");
    await nameFor("no");
    await codeFor(good);
    await submit();
    check("a name that is too short never leaves the form",
          await page.locator("text=Pick a name").isVisible(), true);

    await nameFor("_leading");
    await submit();
    check("nor does one shaped wrongly",
          await page.locator("text=Pick a name").isVisible(), true);

    await nameFor(`link${stamp % 100000}`);
    await codeFor(good);
    const said = await submit();
    try {
      await page.waitForSelector("#stage", { timeout: 30000 });
      check("and finally, a good name and a good code", true, true);
    } catch {
      console.log(`  [where] ${page.url()}  [said] ${said}`);
      throw new Error("a valid name and code did not get in");
    }

    // ---- two-factor ------------------------------------------------------
    console.log("\ntwo-factor, from enrolling to being let back in");
    await page.click("a[href='#/settings']");
    await page.waitForSelector("text=TWO-FACTOR");
    await page.click("button:has-text('Turn it on')");
    // Scoped to the two-factor section. A bare `code` used to be unambiguous;
    // Settings now shows the signed-in address in one too, and it comes first
    // in the document -- so this matched an email, computed a TOTP from it, and
    // reported "a secret was issued" because an email is also longer than
    // fifteen characters. A selector that can match the wrong thing eventually
    // does.
    await page.waitForSelector(".factors code", { timeout: 20000 });
    const secret = await page.locator(".factors code").innerText();
    check("an authenticator secret was issued",
          /^[A-Z2-7]{16,}$/.test(secret), true);

    // Scoped to the two-factor section rather than "the last form on the page".
    // Settings has grown a password form, an email form and a delete-account
    // form since this was written, and the last one is now the dangerous one.
    const enrol = page.locator(".factors form");
    await enrol.locator("input").fill("000000");
    // Inside the two-factor section. `has-text` is a case-insensitive substring,
    // so a bare "Confirm" also matches the email section's "Send the
    // confirmation" -- which is earlier in the document, and submitting it
    // does nothing visible at all.
    await enrol.locator("button").click();
    // Waited FOR, not waited OUT. Verifying a factor is a round trip to the
    // auth service, and a fixed pause is a bet on how fast that is today --
    // one this lost the first time the platform was having a slow afternoon,
    // and then lost twice, because the second code was typed into a form still
    // busy with the first.
    // Through waitForSelector rather than by polling `errorText`, because that
    // helper auto-waits the full actionability timeout each time it finds
    // nothing -- so a loop around it does not poll for twenty seconds, it
    // blocks for twenty minutes.
    await page.waitForSelector(".error:visible", { timeout: 30000 });
    check("a wrong code is refused",
          /invalid|incorrect|not/i.test(await errorText(page)), true);

    await enrol.locator("input").fill(totp(secret));
    await enrol.locator("button").click();
    await page.waitForSelector("text=An authenticator app is enrolled",
                               { timeout: 20000 });
    check("the right one enrols it", true, true);

    // Recovery codes, taken while there is still an authenticator to lose.
    await page.click("button:has-text('Get recovery codes')");
    await page.waitForSelector(".codelist code", { timeout: 20000 });
    const codes = await page.locator(".codelist code").allInnerTexts();
    check("ten codes are shown", codes.length, 10);
    check("and the screen says what spending one costs, before it is spent",
          /turns two-factor OFF/i.test(await page.locator(".factors").innerText()),
          true);

    await page.click("a[href='#/play']");
    await page.waitForSelector("#stage");
    await page.click("button:has-text('Sign out')");
    await page.waitForSelector("input[type=password]", { timeout: 20000 });

    await page.fill("input[type=email]", email);
    await page.fill("input[type=password]", password);
    await page.click("button[type=submit]");
    await page.waitForSelector("text=Two-factor code", { timeout: 20000 });
    check("signing in again stops at the second factor", true, true);

    await page.goto(URL_ + "#/play", { waitUntil: "load" });
    await page.waitForTimeout(1200);
    check("and the game is not reachable around it",
          await page.evaluate(() => location.hash), "#/unlock");

    await page.locator("form input").fill(totp(secret));
    await page.click("button:has-text('Unlock')");
    await page.waitForSelector("#stage", { timeout: 20000 });
    check("the code lets them through", true, true);

    // ---- and the way back when the authenticator is gone -----------------
    // Out again, and this time pretend the phone with the app on it is not in
    // the room. The password alone gets as far as the gate and no further,
    // which is the whole point of the gate.
    await page.click("button:has-text('Sign out')");
    await page.waitForSelector("input[type=password]", { timeout: 20000 });
    await page.fill("input[type=email]", email);
    await page.fill("input[type=password]", password);
    await page.click("button[type=submit]");
    await page.waitForSelector("text=Two-factor code", { timeout: 20000 });

    await page.click("a:has-text('Lost your authenticator?')");
    await page.waitForSelector("text=Use a recovery code");
    check("the warning comes before the code, not after",
          /turns two-factor OFF/i.test(await page.locator(".card").innerText()),
          true);

    await page.locator("form input").fill("AAAAA-AAAAA");
    await page.click("button[type=submit]");
    await page.waitForSelector(".error:visible", { timeout: 30000 });
    check("a code that was never theirs is refused",
          /not one of your recovery codes/i.test(await errorText(page)), true);

    await page.locator("form input").fill(codes[0]);
    await page.click("button[type=submit]");
    await page.waitForSelector("#stage", { timeout: 30000 });
    check("a real one lets them in", true, true);

    await page.click("a[href='#/settings']");
    await page.waitForSelector("text=TWO-FACTOR");
    // Which is the cost the screen warned about: they are in, and the account
    // is back to being protected by a password alone until they say otherwise.
    await page.waitForSelector("button:has-text('Turn it on')", { timeout: 20000 });
    check("and two-factor is off, exactly as it said it would be", true, true);

    // ---- renaming --------------------------------------------------------
    console.log("\nrenaming costs no second invite code");
    await page.locator("form").first().locator("input")
      .fill(`re${stamp % 100000}`);
    await page.locator("form").first().locator("button[type=submit]").click();
    await page.waitForTimeout(2500);
    const trouble = await errorText(page);
    check("the new name was accepted", trouble, "");
    check("and it is what the bar shows now",
          await page.locator("form").first().locator("input").inputValue(),
          `re${stamp % 100000}`);
    await page.close();
  }

  // ---- the password reset link -------------------------------------------

  console.log("\nthe password reset link works too");
  {
    const u = await makeUser("reset");
    const linked = await (await admin("/auth/v1/admin/generate_link", {
      method: "POST",
      body: JSON.stringify({ type: "recovery", email: u.email,
                             redirect_to: `${URL_}?intent=password` }),
    })).json();
    check("a recovery link was generated",
          typeof linked.hashed_token === "string", true);

    const page = await newPage();
    await page.goto(
      `${URL_}?token_hash=${linked.hashed_token}&type=recovery&intent=password`,
      { waitUntil: "load" });
    // The `?intent=` is what tells the app this arrival was about a password,
    // since the session it lands with looks like any other.
    await page.waitForSelector("text=Choose a new password", { timeout: 30000 });
    check("it lands on the new-password screen", true, true);

    const fresh = `changed_${stamp}!A`;
    const pws = page.locator("input[type=password]");
    await pws.nth(0).fill(fresh);
    await pws.nth(1).fill(fresh);
    await page.click("button[type=submit]");
    await page.waitForTimeout(2000);

    const signedIn = await fetch(`${API}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: PUB, "content-type": "application/json" },
      body: JSON.stringify({ email: u.email, password: fresh }),
    });
    check("and the new password works", (await signedIn.json()).access_token
          !== undefined, true);
    await page.close();
  }
} catch (err) {
  failures++;
  console.log("  FAIL " + err.message);
} finally {
  await browser.close().catch(() => {});
  server.kill();
  for (const u of users) {
    await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  }
  await admin("/rest/v1/invite_codes?note=eq.accounts", { method: "DELETE" });
  console.log(`\ncleaned up ${users.length} test users`);
}

console.log("\n" + (failures === 0 ? "ACCOUNTS PASSED"
                                   : `ACCOUNTS FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
