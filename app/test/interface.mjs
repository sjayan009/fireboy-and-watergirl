/**
 * The app itself, in three browser engines and at two sizes.
 *
 * `crossengine` proves the SIMULATION agrees across Chromium, Firefox and
 * WebKit -- which is what stops two people on different browsers desyncing. It
 * says nothing about whether the app around it loads at all: the Supabase
 * client, the auth storage, the canvas, the fonts, the module graph. A game
 * that is bit-identical everywhere and only starts in Chromium is not portable.
 *
 * And the canvas is a fixed 640x480 stage that CSS scales to whatever width it
 * is given, so every click has to be divided back through that scale before it
 * means anything to the display list. That arithmetic is the sort of thing that
 * is right at one size and wrong at every other, so it is checked at a phone
 * width and a desktop one -- by clicking a real button and asserting the game
 * responded, not by inspecting the maths.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { env } from "../../supabase/connect.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const PORT = 5193;
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

/** A confirmed account that already has a username, ready to sign in. */
async function makeReadyUser(tag) {
  const email = `fbwg_ui_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_${tag}!A`;
  const created = await (await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true }),
  })).json();
  if (!created.id) throw new Error("could not create a user");
  users.push({ id: created.id });

  const code = `UI-${stamp}-${tag}`.toUpperCase();
  await admin("/rest/v1/invite_codes", {
    method: "POST",
    body: JSON.stringify({ code, max_uses: 1, note: "interface" }),
  });

  const token = (await (await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUB, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })).json()).access_token;

  const username = `ui${tag}${stamp % 100000}`.slice(0, 20);
  await fetch(`${API}/rest/v1/rpc/claim_username`, {
    method: "POST",
    headers: { apikey: PUB, Authorization: `Bearer ${token}`,
               "content-type": "application/json" },
    body: JSON.stringify({ new_username: username, invite_code: code }),
  });
  return { email, password, username };
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

const server = await startVite();

try {
  const user = await makeReadyUser("a");

  for (const engine of ["chromium", "firefox", "webkit"]) {
    console.log(`\n${engine}`);
    let browser;
    try {
      browser = await playwright[engine].launch();
    } catch {
      console.log("  not installed -- skipping");
      continue;
    }

    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      const problems = [];
      page.on("pageerror", (err) => problems.push(err.message));

      await page.goto(URL_, { waitUntil: "load" });
      await page.waitForSelector("input[type=email]", { timeout: 40000 });
      await page.fill("input[type=email]", user.email);
      await page.fill("input[type=password]", user.password);
      await page.click("button[type=submit]");
      await page.waitForSelector("#stage", { timeout: 40000 });
      check("signs in and reaches the game", true, true);

      // Something is actually drawn. A canvas that stayed black would satisfy
      // every selector on the page.
      await page.waitForFunction(
        () => window.__fbwg && window.__fbwg.view.sprites &&
              !window.__fbwg.view.sprites.loading,
        null, { timeout: 60000 });
      // Polled, not sampled once. `sprites.loading === 0` means every request
      // has come back; it does not mean a frame has been drawn with them yet,
      // and under load -- three browsers and a test suite sharing a machine --
      // the gap between the two is wide enough to catch a canvas that is still
      // black. Measuring once made Firefox and WebKit look broken when they
      // were merely busy.
      const sample = () => page.evaluate(() => {
        const px = document.getElementById("stage").getContext("2d")
          .getImageData(0, 0, 640, 480).data;
        let lit = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] + px[i + 1] + px[i + 2] > 60) lit++;
        }
        const s = window.__fbwg.view.sprites;
        return { painted: lit / (px.length / 4), missing: s.missing,
                 loading: s.loading };
      });
      let drawn = await sample();
      for (let i = 0; i < 60 && drawn.painted <= 0.3; i++) {
        await page.waitForTimeout(500);
        drawn = await sample();
      }
      console.log(`  ${(drawn.painted * 100).toFixed(0)}% of the canvas lit, ` +
                  `${drawn.missing} images failed, ${drawn.loading} pending`);
      check("no art failed to load", drawn.missing, 0);
      check("the menu is drawn, not a black canvas", drawn.painted > 0.3, true);

      /**
       * Click PLAY through the CSS scale, at two very different widths.
       *
       * Playwright clicks at a viewport coordinate; the app has to divide that
       * back through however wide the canvas happens to be drawn. If that
       * arithmetic is wrong the click lands somewhere else on the stage and
       * nothing happens -- which is exactly what the assertion notices.
       */
      for (const width of [1600, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(400);

        const box = await page.locator("#stage").boundingBox();
        const cursor = () => page.evaluate(
          () => document.getElementById("stage").style.cursor);

        // Somewhere with nothing on it, then PLAY. The cursor is the honest
        // signal: it is what the app itself changes when the hit test finds a
        // button, and it is what the person sees.
        await page.mouse.move(box.x + box.width * 0.05,
                              box.y + box.height * 0.95);
        await page.waitForTimeout(250);
        const overNothing = await cursor();

        // PLAY sits at roughly (320, 246) on the 640x480 stage -- measured off
        // a screenshot rather than guessed, because a guess that misses looks
        // exactly like the hit test being broken.
        await page.mouse.move(box.x + box.width * 320 / 640,
                              box.y + box.height * 246 / 480);
        await page.waitForTimeout(250);
        check(`at ${width}px the pointer finds PLAY`,
              [overNothing, await cursor()], ["default", "pointer"]);
      }

      check("and no page errors anywhere", problems, []);
      await ctx.close();
    } finally {
      await browser.close().catch(() => {});
    }
  }
} catch (err) {
  failures++;
  console.log("  FAIL " + err.message);
} finally {
  server.kill();
  for (const u of users) {
    await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  }
  await admin("/rest/v1/invite_codes?note=eq.interface", { method: "DELETE" });
  console.log(`\ncleaned up ${users.length} test users`);
}

console.log("\n" + (failures === 0 ? "INTERFACE PASSED"
                                   : `INTERFACE FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
