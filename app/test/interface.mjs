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
import { connect as netConnect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { env } from "../../supabase/connect.mjs";
import { passCaptcha } from "./captcha.mjs";
import { sweepStaleTestUsers } from "../../supabase/sweep.mjs";

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
// Before anything is made: whatever a killed run left behind.
// `finally` cannot run when a process is killed, so the only
// reachable place to tidy those away is the start of the next run.
await sweepStaleTestUsers("interface");
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

  // The secret key, because Supabase lets it past Turnstile and a test
  // cannot solve one.
  const token = (await (await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SECRET, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })).json()).access_token;

  const username = `ui${tag}${stamp % 100000}`.slice(0, 20);
  await fetch(`${API}/rest/v1/rpc/claim_username`, {
    method: "POST",
    headers: { apikey: PUB, Authorization: `Bearer ${token}`,
               "content-type": "application/json" },
    body: JSON.stringify({ new_username: username }),
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
  // The dev server's own file handler, before any browser is involved.
  //
  // `vite.config.ts` serves `extracted/` straight off disk in development, and
  // its containment used to be `file.startsWith(ROOT)` -- a string prefix, and
  // against the REPOSITORY rather than against `extracted/`. So
  // `/extracted/..\.env.local` was "inside the root", was allowed, and returned
  // the file holding the Supabase secret key and the database password. Vite
  // binds to loopback, which narrows who could ask; it does not narrow it to
  // nobody, and a page in another tab is a local origin.
  //
  // Written onto a socket rather than through `fetch`, because a WHATWG URL
  // turns a backslash into a forward slash before anything is sent -- so a
  // `fetch` version of this test proves that `fetch` normalises and nothing
  // about the server.
  console.log("the dev server maps nothing outside extracted/");
  {
    const raw = (target) => new Promise((done) => {
      const socket = netConnect(PORT, "localhost", () => {
        const CRLF = "\r\n";
        socket.write(`GET ${target} HTTP/1.1${CRLF}` +
                     `Host: localhost:${PORT}${CRLF}` +
                     `Connection: close${CRLF}${CRLF}`);
      });
      const chunks = [];
      socket.on("data", (c) => chunks.push(c));
      socket.on("error", () => done(0));
      socket.on("close", () => done(Number(
        Buffer.concat(chunks).toString("latin1").split(" ")[1] ?? 0)));
    });
    for (const attack of ["/extracted/..%5C.env.local",
                          "/extracted/..\\.env.local",
                          "/extracted/../.env.local",
                          "/extracted/%2e%2e/.env.local"]) {
      check(`refused ${attack}`, (await raw(attack)) >= 400, true);
    }
    check("and a real asset is still served",
          await raw("/extracted/assets/sprites.json"), 200);
  }

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
      await passCaptcha(ctx, API, SECRET, (path) => { failures++; console.log(`  FAIL no Turnstile token sent to ${path}`); });
      const page = await ctx.newPage();
      const problems = [];
      page.on("pageerror", (err) => problems.push(err.message));

      await page.goto(URL_ + "#/login", { waitUntil: "load" });
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

        // The drawer has to be shut before the pointer means anything here.
        //
        // On a wide screen the friends panel opens by itself, and it is a panel
        // BESIDE the game. Narrow the window and the same open panel becomes a
        // modal dialog over it, so `syncModal` marks the viewport `inert` --
        // correctly, because that is what a modal is. This loop used to shrink
        // a window with the panel already open and then ask why the game was
        // not answering the mouse: it was answering exactly as designed, from
        // behind a dialog. What is under test is the hit test's arithmetic, so
        // the dialog is closed first and the arithmetic is asked on its own.
        const shut = page.locator("button.close-panel");
        if (await shut.count() && await shut.first().isVisible()) {
          await shut.first().click();
          await page.waitForTimeout(300);
        }

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

      // Put the window back. Everything below this runs in whatever size the
      // loop left behind, and it left 390px -- where the panels are a modal
      // over an inert viewport and the leaderboard is not a thing you can
      // click. That is how a stale viewport turned into a thirty-second
      // locator timeout several tests further down, blamed on the leaderboard.
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.waitForTimeout(500);

      // And put the panels back, because closing them above is not free either.
      // Everything below reaches into the drawer -- the leaderboard's own
      // toggle, the select inside it -- and reached it only because a wide
      // window opens the friends panel unasked. Having shut that to get a clean
      // pointer reading, the drawer has to be reopened deliberately rather than
      // left to a default that no longer applies.
      const boardTab = page.locator("button.tool-leaderboard");
      if (await boardTab.count()) {
        await boardTab.first().click();
        await page.waitForTimeout(600);
      }

      // What somebody arriving by keyboard or screen reader is handed.
      //
      // The game is pixels: its menus, its map, its results board and its two
      // characters exist only on the canvas, so none of them are in the
      // accessibility tree and no attribute can put them there. What CAN be
      // fixed is the part around it, and it was not -- a focusable canvas with
      // no name is a stop on the tab order that says nothing about itself, and
      // the connection status was a bare `span` rewritten by the network, so a
      // stall, a disconnection or a friend leaving was announced to nobody.
      //
      // This asserts the part an attribute can carry. A genuinely playable
      // alternative interface is a design job and is not claimed here.
      const shell = await page.evaluate(() => {
        const canvas = document.getElementById("stage");
        const status = document.querySelector(".status");
        const described = canvas?.getAttribute("aria-describedby");
        return {
          canvasNamed: (canvas?.getAttribute("aria-label") ?? "").length > 3,
          canvasRole: canvas?.getAttribute("role"),
          // The description has to point at something that exists, or the
          // reader announces nothing where the key list should be.
          describedByReal: !!described && !!document.getElementById(described),
          statusLive: status?.getAttribute("aria-live"),
          // Every control in the bar has to say what it is; an icon-only or
          // empty button is a button nobody can choose.
          unnamedButtons: [...document.querySelectorAll("header button, header a")]
            .filter((el) => !(el.textContent ?? "").trim() &&
                            !el.getAttribute("aria-label")).length,
        };
      });
      check("the canvas has a name", shell.canvasNamed, true);
      check("and a role", shell.canvasRole, "application");
      check("and its description points at something real",
            shell.describedByReal, true);
      check("the connection status announces itself", shell.statusLive, "polite");
      check("and every control in the bar is named", shell.unnamedButtons, 0);

      /*
       * The game's keys are bound to `window`, and the pickers are on the same
       * screen as the game.
       *
       * That binding is deliberate -- somebody who has just clicked "Mute" has
       * to be able to carry on playing -- but it meant every key on the page
       * arrived at the shell, including the ones aimed at a `<select>`. The
       * arrows that walk the leaderboard's options were being cancelled by the
       * handler's own `preventDefault` and fed to Fireboy at the same time, and
       * `r`, which a select reads as type-ahead, was sending Retry to a session
       * both people are in.
       *
       * `defaultPrevented` is the mechanism rather than a symptom of it: this
       * listener is registered after the shell's, on the same target, so it
       * sees whether the shell claimed a key that was not its to claim.
       */
      // Two stale assumptions lived in this locator, and both cost thirty
      // seconds each before saying anything useful.
      //
      // There is no Show/Hide: the board used to be a panel you expanded, and
      // the drawer redesign made it a tab that is simply open when chosen. No
      // source file has held the word "Show" since.
      //
      // And the panel does not say "Leaderboard" -- that is the TAB's label.
      // The panel itself is headed "Two players. One great time." So a filter
      // on `hasText: "Leaderboard"` matched nothing and always would have.
      //
      // What the test is about is a `<select>` on the same screen as a game
      // that binds its keys to `window`, so it asks for the select directly.
      const picker = page.locator(".drawer-content select.pick").first();
      await picker.waitFor({ state: "visible", timeout: 15000 });
      await picker.focus();

      // Bounded, and it has to be. This waited on a keydown that might already
      // have happened: the listener is installed by one round trip and the key
      // pressed by the next, so losing that race meant waiting forever -- not
      // failing, HANGING, with the suite pinning a core and saying nothing. A
      // seven-minute cap on the whole file turned that into "timed out" with no
      // clue which assertion did it.
      //
      // "timeout" is not silently tolerated either; it is a distinct value, so
      // a race that starts happening shows up as a failed assertion naming
      // itself rather than as a suite that never finishes.
      // Installed, confirmed, THEN pressed. Starting the listener and the key
      // press as two un-ordered round trips is a race, and chromium lost it
      // while firefox and webkit did not -- so the suite hung on the first
      // engine and passed on the other two, which reads like a chromium bug and
      // is really a test that never said when it was ready.
      //
      // The promise is parked on `window` so the page keeps it across both
      // calls; awaiting the first evaluate is what guarantees the listener
      // exists before anything is typed.
      await page.evaluate(() => {
        window.__keydownSeen = new Promise((resolve) => {
          const timer = setTimeout(() => resolve("timeout"), 10000);
          window.addEventListener("keydown", (e) => {
            clearTimeout(timer);
            resolve(e.defaultPrevented);
          }, { once: true });
        });
      });
      await page.keyboard.press("ArrowDown");
      check("an arrow aimed at a picker is left to the picker",
            await page.evaluate(() => window.__keydownSeen), false);
      check("and the picker still has the focus",
            await page.evaluate(() => document.activeElement?.tagName), "SELECT");

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
  console.log(`\ncleaned up ${users.length} test users`);
}

console.log("\n" + (failures === 0 ? "INTERFACE PASSED"
                                   : `INTERFACE FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
