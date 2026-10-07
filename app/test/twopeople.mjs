/**
 * Two people, two browsers, one game.
 *
 * This is the test the whole project has been building towards, and the only
 * one that exercises the real path from end to end: two separate accounts, each
 * in its own browser context with its own session and its own storage, finding
 * each other by username, agreeing who is Fireboy, connecting, and then
 * simulating the same physics.
 *
 * `twotabs.mjs` proved the browser wiring between two tabs that shared a
 * BroadcastChannel and needed no accounts. Everything between those tabs and
 * this -- the invite gate, the friendship, the private Realtime channel, the
 * role assignment, the peer connection -- is what this covers.
 *
 * Separate CONTEXTS, not tabs, and that matters: two tabs of one context share
 * localStorage, so they would share a Supabase session and be the same person.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { env } from "../../supabase/connect.mjs";
import { sweepStaleTestUsers } from "../../supabase/sweep.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");

const PORT = 5199;
const URL_ = `http://localhost:${PORT}/`;

const e = env();
const API = e.SUPABASE_URL;
const SECRET = e.SUPABASE_SECRET_KEY;

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` +
              (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

// ---- the accounts, made the way the admin API makes them -------------------

const stamp = Date.now();
// Before anything is made: whatever a killed run left behind.
// `finally` cannot run when a process is killed, so the only
// reachable place to tidy those away is the start of the next run.
await sweepStaleTestUsers("twopeople");
const users = [];

const admin = (path, init = {}) => fetch(`${API}${path}`, {
  ...init,
  headers: {
    apikey: SECRET, Authorization: `Bearer ${SECRET}`,
    "content-type": "application/json", ...(init.headers ?? {}),
  },
});

async function makeUser(tag) {
  const email = `fbwg_e2e_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_${tag}!A`;
  const created = await (await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true }),
  })).json();
  if (!created.id) throw new Error("could not create a user");
  const u = { id: created.id, email, password, tag,
              username: `e2e${tag}${stamp % 100000}` };
  users.push(u);
  return u;
}

// ---- the dev server --------------------------------------------------------

async function startVite() {
  // Spawned directly rather than through `npm run`, and waited on by ASKING THE
  // SERVER rather than by watching its output. Both matter on Windows: the npm
  // shim adds a shell layer that buffers stdout unpredictably, and a readiness
  // check that greps for a banner is a check on a log format.
  const vite = resolve(APP, "..", "node_modules", "vite", "bin", "vite.js");
  const server = spawn(
    process.execPath, [vite, "--port", String(PORT), "--strictPort"],
    { cwd: APP, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", (d) => process.stderr.write(d));

  const deadline = Date.now() + 60000;
  for (;;) {
    if (Date.now() > deadline) {
      server.kill();
      throw new Error("vite did not start");
    }
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

/** Sign in and claim a username, exactly as a person would. */
async function signIn(page, user) {
  await page.goto(URL_ + "#/login", { waitUntil: "load" });
  await page.waitForSelector("input[type=email]", { timeout: 30000 });
  await page.fill("input[type=email]", user.email);
  await page.fill("input[type=password]", user.password);
  await page.click("button[type=submit]");

  await page.waitForSelector("text=Pick a name", { timeout: 30000 });
  // One field. The invite code that used to sit beside it went when the gate
  // came down, and filling `nth(1)` now reaches whatever the form puts second.
  await page.locator("form input").first().fill(user.username);
  await page.click("button[type=submit]");
  await page.waitForSelector("#stage", { timeout: 30000 });
}

try {
  console.log("two accounts, two browser contexts");
  const alice = await makeUser("a");
  const bob = await makeUser("b");

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  // FBWG_FORCE_RELAY=1 runs every section on the relay instead of whatever the
  // machine's networking happens to allow. Which link a run gets is otherwise
  // luck, and the relay is the path players behind strict NATs depend on.
  if (process.env.FBWG_FORCE_RELAY) {
    for (const ctx of [ctxA, ctxB]) await ctx.addInitScript(() => { window.RTCPeerConnection = undefined; });
  }
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  function watchPage(tag, p) {
    p.on("pageerror", (err) => {
      failures++;
      console.log("  FAIL page error: " + err.message);
    });
    // Warnings from the page are the only place a channel that would not open
    // says so; without them a presence failure is just a timeout.
    p.on("console", (msg) => {
      if (msg.type() === "warning" || msg.type() === "error") {
        console.log(`  [${tag}] ${msg.text()}`);
      }
    });
    // What the console will NOT tell you. A failed fetch reaches it as
    // "Failed to load resource: the server responded with a status of 400" and
    // nothing else -- no method, no path, no body -- so a request that has been
    // failing on every run since somebody added it reads as background noise.
    // Once per distinct method-and-path, because a call that fails once fails
    // every time and a hundred identical lines hide the run.
    const said = new Set();
    p.on("response", async (r) => {
      if (r.status() < 400) return;
      const url = new URL(r.url());
      const what = `${r.request().method()} ${url.host}${url.pathname}`;
      if (said.has(what)) return;
      said.add(what);
      let body = "";
      try { body = (await r.text()).slice(0, 200); } catch { /* already gone */ }
      console.log(`  [${tag}] HTTP ${r.status()} ${what}${body ? " -- " + body : ""}`);
    });
  }
  watchPage("A", a);
  watchPage("B", b);

  await signIn(a, alice);
  await signIn(b, bob);
  /**
   * Back to the game.
   *
   * Also not a link any more. The shell IS the play screen -- the drawer opens
   * over it rather than replacing it -- so there is no anchor to click, and
   * `a[href='#/play']` matched nothing in six places. Asking the router
   * directly says what the test means and works from whichever screen the page
   * happens to be on.
   */
  async function goPlay(p) {
    await p.evaluate(() => { location.hash = "#/play"; });
    await p.waitForSelector("#stage", { timeout: 20000 });
  }

  /**
   * Show the friends panel, whatever state the drawer is in.
   *
   * There is no `#/friends` route to click any more -- friends became a TAB of
   * the play screen's drawer when the shell was redrawn, and `a[href='#/friends']`
   * has matched nothing since. This clicked it three times and spent thirty
   * seconds on each.
   *
   * Clicking the tab unconditionally is not the fix either: a wide window opens
   * the friends panel by itself, so a blind click would CLOSE the thing the
   * caller is asking to see. Hence the check first.
   */
  async function openFriends(p) {
    if (!await p.locator("text=Send a request").isVisible()) {
      await p.click("button.tool-friends");
    }
    await p.waitForSelector("text=Send a request", { timeout: 20000 });
  }

  // `.copy-name`, not `.who`. The username moved into the toolbar's identity
  // block when the shell was redrawn in 2bcef06 and `.who` stopped existing;
  // this went on asking for it and waiting the full thirty seconds to be told
  // no. A selector for a class that is in no source file is not a failing
  // test, it is an unasked one.
  check("both are signed in and named",
        await Promise.all([a, b].map((p) =>
          p.locator(".copy-name").innerText())),
        [alice.username, bob.username]);

  console.log("\nthey become friends");
  await openFriends(a);
  await a.fill("form input", bob.username);
  await a.click("button[type=submit]");

  await openFriends(b);
  await b.waitForSelector("text=Waiting for You", { timeout: 20000 });
  await b.click("button:has-text('Accept')");
  // Asserting a ROW exists would prove nothing: the pending request is a row
  // with the same name in it. Ask the database what it thinks instead.
  let status = null;
  for (let i = 0; i < 40; i++) {
    const r = await admin(
      `/rest/v1/friendships?select=status&user_a=eq.${
        alice.id < bob.id ? alice.id : bob.id}&user_b=eq.${
        alice.id < bob.id ? bob.id : alice.id}`);
    status = (await r.json())[0]?.status ?? null;
    if (status === "accepted") break;
    await b.waitForTimeout(250);
  }
  if (status !== "accepted") {
    const said = await b.locator(".error").innerText().catch(() => "(nothing)");
    console.log(`  [B] the accept said: ${said}`);
  }
  check("they are friends", status, "accepted");

  // A third person, befriended NOW rather than later. Everything below happens
  // mid-match, and opening the friends list tears the play screen down -- match
  // and all -- so a friendship made halfway through would end the game it was
  // made to watch.
  console.log("\nand a third person, who knows only alice");
  const carol = await makeUser("c");
  const ctxC = await browser.newContext();
  const c = await ctxC.newPage();
  c.on("pageerror", (err) => {
    failures++;
    console.log("  FAIL page error: " + err.message);
  });
  await signIn(c, carol);
  await openFriends(c);
  await c.fill("form input", alice.username);
  await c.click("button[type=submit]");
  await c.waitForSelector("text=Request sent", { timeout: 30000 });

  // Alice is already looking at her friends list -- the block above left her
  // there -- and she is NOT reloaded. That is the assertion.
  //
  // This used to be a loop that reloaded her page up to six times, waiting for
  // the request to appear, with a comment saying the screen draws once and does
  // not listen and that it was "not worth fixing here". It was worth fixing
  // there: a friend request that is invisible until you navigate away and back
  // is indistinguishable from one that was never sent, and a test that reloads
  // around it is a test that has agreed not to notice. The screen polls while
  // it is visible now, so this waits for the row rather than for a reload.
  const asked = await a.locator("button:has-text('Accept')")
    .waitFor({ timeout: 40000 }).then(() => true).catch(() => false);
  check("alice is asked, on the page she was already looking at", asked, true);
  await a.click("button:has-text('Accept')");

  // Friends with alice and not with bob, deliberately: the watch policy admits
  // friends of EITHER player, and somebody who knew both would not tell that
  // rule apart from the stricter one.
  await goPlay(c);
  await c.waitForSelector("#stage");

  // And wait until her client agrees that she has one. The channels a person
  // hears "we are playing, come and watch" on are built from the friends list
  // as the play screen loads, once, and the acceptance above is a few seconds
  // old -- so carol can easily arrive here before her own copy of that list
  // has caught up, end up with no channels at all, and then hear nothing for
  // the rest of the game no matter how many times alice announces.
  //
  // Same remedy the accept used a moment ago: come back to the screen until it
  // has caught up. Worth knowing that a friendship made while you are sitting
  // on this screen needs a revisit before it means anything.
  const carolLinked = async () => c.evaluate(() =>
    [...(window.__fbwg?.lobby?.channels ?? new Map()).values()]
      .some((ch) => ch.channel.state === "joined"));
  let linked = false;
  // Poll first and reload only when polling has given up. Reloading on every
  // turn of the loop is worse than not trying at all: subscribing takes a
  // moment, and tearing the page down a second later cancels the join that was
  // already on its way, over and over.
  for (let round = 0; round < 3 && !linked; round++) {
    if (round > 0) {
      await c.reload({ waitUntil: "load" });
      await c.waitForSelector("#stage", { timeout: 30000 });
    }
    for (let i = 0; i < 24 && !linked; i++) {
      linked = await carolLinked();
      if (!linked) await c.waitForTimeout(500);
    }
  }
  check("carol's client knows who her friend is", linked, true);

  // Seed a map for the pair, so the test can tell the pair's progress from the
  // solo progress each browser would otherwise be holding.
  const lo = alice.id < bob.id ? alice.id : bob.id;
  const hi = alice.id < bob.id ? bob.id : alice.id;
  const seeded = await admin("/rest/v1/pair_progress", {
    method: "POST",
    body: JSON.stringify([
      { user_a: lo, user_b: hi, node: 1, medal: 2,
        best_time_s: 60, best_time_str: "01:00" },
      // Same keys on both, or PostgREST refuses the batch outright.
      { user_a: lo, user_b: hi, node: 2, medal: 0,
        best_time_s: null, best_time_str: null },
    ]),
  });
  if (!seeded.ok) throw new Error("could not seed: " + (await seeded.text()));

  console.log("\nand see each other come online");
  // Signing in already opens the friend channel. Navigating Bob away closes
  // that subscription while retaining his session in this browser context.
  await b.goto("about:blank");
  await goPlay(a);
  await a.waitForFunction(() => {
    const pair = [...(window.__fbwg?.lobby?.channels?.values() ?? [])][0];
    return pair && !pair.occupied;
  }, null, { timeout: 30000 });

  // Alice is in the lobby and bob is not yet, which is the only window in this
  // file where somebody holds a channel with nobody on the other end -- and it
  // is the ordinary case in production, where most of a friends list is
  // offline most of the time.
  //
  // `Lobby.setActivity` tells every open channel at once, so before the gate
  // an activity change announced to all of them regardless. Realtime meters a
  // presence call on the way out and again per subscriber, and that fan-out
  // times the transitions the play loop makes is the largest standing draw on
  // the message allowance -- larger than a relayed game, and it is spent
  // talking to nobody.
  //
  // Asked of the channel's own state rather than by watching the socket for a
  // send that should not happen: proving a negative over the wire means
  // waiting out a full `PRESENCE_MS` window to be sure nothing was merely
  // deferred, and the two things this needs to distinguish -- not announced,
  // and not scheduled either -- are both readable here immediately.
  {
    const gated = await a.evaluate(() => {
      const lobby = window.__fbwg?.lobby;
      const pair = [...(lobby?.channels?.values() ?? [])][0];
      if (!pair) return "alice has no channel";
      // The premise, not the assertion. If bob's context has already put him
      // on the channel there is nothing here to test, and a pass would mean
      // nothing.
      if (pair.occupied) return "bob is already on the channel";
      lobby.setActivity("in_game");
      const seen = {
        scheduled: pair.presenceTimer !== null,
        held: pair.activity,
        announced: pair.announced,
      };
      lobby.setActivity("in_lobby");
      return seen;
    });
    // Said out loud, because the two ways this can be vacuous both return a
    // sentence explaining themselves and would otherwise read as three
    // assertions failing on `undefined`.
    if (typeof gated === "string") throw new Error(`offline presence premise: ${gated}`);
    check("an activity change with nobody listening is not announced",
          gated.scheduled, false);
    check("and is not quietly deferred to the next window either",
          gated.announced === "in_game", false);
    // The other half of the gate, and the reason it can be a gate at all: what
    // was not said is still known, so the arrival edge has something true to
    // send when bob turns up. A version that dropped the value instead would
    // leave him reading `online` for a player who is mid-level.
    check("but the activity is still held for when they arrive",
          gated.held, "in_game");
  }

  await b.goto(URL_, { waitUntil: "load" });
  await b.waitForSelector("#stage", { timeout: 30000 });
  await goPlay(b);
  const seeEachOther = async () => {
    for (let i = 0; i < 150; i++) {
      const ok = await Promise.all([a, b].map((p) => p.evaluate(() =>
        (window.__fbwg?.lobby?.list ?? []).some((f) => f.activity !== null))));
      if (ok[0] && ok[1]) return true;
      await a.waitForTimeout(200);
    }
    // Whatever is wrong, it is one of these three: the friendship is not
    // accepted on one side, the channel did not open, or presence never
    // arrived. Printing all three is faster than guessing between them.
    for (const [tag, p] of [["A", a], ["B", b]]) {
      const dump = await p.evaluate(() => ({
        lobby: (window.__fbwg?.lobby?.list ?? []).map((f) =>
          ({ u: f.username, s: f.status, a: f.activity })),
        panel: document.querySelector(".panel")?.textContent?.trim().slice(0, 160),
      }));
      console.log(`  [${tag}] ${JSON.stringify(dump)}`);
    }
    return false;
  };
  check("each sees the other online", await seeEachOther(), true);

  /**
   * Press a button INSIDE the canvas, the way a mouse does.
   *
   * Through the shell rather than at a pixel, because the point of the test is
   * what happens after the button is identified -- and hard-coding where a map
   * node is drawn would make it a test of the artwork.
   */
  const pressInGame = (page, path) => page.evaluate((where) => {
    const v = window.__fbwg.view;
    const target = where.split(".").reduce((o, k) => o && o[k], v.game);
    if (!target) throw new Error("no such button: " + where);
    v.shell.pointerDown(target);
    v.shell.pointerUp();
  }, path);

  /**
   * The same press, but arrived at the way a real mouse arrives at it: through
   * the renderer's hit test at the point the button is actually drawn.
   *
   * The helper above takes an object path, which is precise and is also why the
   * suite could not see a screen that had been left on top of everything else:
   * a results board covering the map is not a thing an object path notices, and
   * every button in this file was pressed through one. This asks the renderer
   * what is under the button's own centre and refuses if the answer is
   * something else -- which is the assertion, not the click.
   */
  const clickInGame = (page, path) => page.evaluate((where) => {
    const v = window.__fbwg.view;
    const want = where.split(".").reduce((o, k) => o && o[k], v.game);
    if (!want) throw new Error("no such button: " + where);
    if (!v.sprites) throw new Error("the art has not loaded");
    // Where the renderer says that button is, in stage coordinates.
    const boxes = v.sprites.buttonBoxes(v.game);
    const box = boxes.find((h) => h.node === want);
    if (!box) {
      // "Not on screen" has three quite different causes and used to name
      // none of them: the node can be invisible, it can be `enabled = false`
      // (which is how the map locks a level nobody has reached, and which
      // `buttonBoxes` skips), or the screen it lives on can not be up at all.
      // Saying which turns a ten-minute rerun into a read.
      throw new Error(`that button is not on screen: ${where} -- ` +
        JSON.stringify({
          visible: want.visible, enabled: want.enabled,
          alpha: want.alpha, parent: !!want.parent,
          screens: v.game.children.map((c) => c.symbol).filter(Boolean),
          clickable: boxes.length,
        }));
    }
    const [x, y] = box.centre;
    const hit = v.sprites.hitTest(v.game, x, y);
    if (hit !== want) {
      throw new Error(`something else is over ${where}: ` +
                      `${(hit && hit.name) || hit}`);
    }
    v.shell.pointerDown(hit);
    v.shell.pointerUp();
  }, path);

  /**
   * Press one of the play screen's actions, wherever the shell keeps them.
   *
   * Not `header button`, which is where this file looked for all three of them
   * for months. `PlayShell` is handed `[hand, share, leave, ...]` and puts every
   * one into the Menu panel's "This Session" group; the header kept only the
   * tabs and the tools. Three separate assertions went stale on that at once,
   * and none of them said so -- a Playwright locator that matches nothing
   * answers `isVisible()` with false and times out on `click()`, so "the button
   * moved" arrives as "alice cannot hand over the pick" and as a thirty-second
   * wait with no name on it.
   *
   * Closing is the panel's own close button and only when it is showing.
   * NOT Escape: `PlayShell` swallows Escape only while a panel is open, so an
   * Escape sent to a closed drawer reaches the game -- where in a live session
   * it is the blunt "leave this level" and sends `Command.Quit`.
   */
  const openMenu = (p) => p.click("header button:has-text('Menu')");
  const closePanel = async (p) => {
    const close = p.locator(".close-panel");
    if (await close.isVisible()) await close.click();
  };
  const menuAction = async (p, label) => {
    await openMenu(p);
    await p.click(`.menu-actions button:has-text('${label}')`);
    await closePanel(p);
  };

  /** What the game has on screen, for the assertions about leftovers. */
  const onScreen = (page) => page.evaluate(() => ({
    symbols: window.__fbwg.view.game.children
      .map((c) => c.symbol).filter(Boolean),
    boards: window.__fbwg.view.game.children
      .filter((c) => c.Rboard || c.GOboard).length,
    maps: window.__fbwg.view.game.children
      .filter((c) => c.symbol === "MainMenu").length,
  }));

  /**
   * Arrange for the NEXT level to end the moment it begins.
   *
   * The engine's shell test ends a level by setting a flag on the contact
   * listener once per simulated frame, interleaved with its own `step()`.
   * There is no per-frame hook out here, and reaching for a wall-clock timer
   * instead is what makes it wrong: the two pages are separate simulations
   * kept together by nothing but their inputs, so a timer fires at a DIFFERENT
   * frame at each end and injects state that was never in the input stream.
   * The peers diverge, and rollback re-simulates those frames from a snapshot
   * and wipes the poke anyway.
   *
   * So make it a property of the level rather than an event in time.
   * `StartGame` builds `new level(...)` synchronously and the constructor makes
   * the contact listener, so wrapping it here -- while NO level exists, on both
   * pages -- means the Start command, which lands on the same frame at both
   * ends, builds an identical level at each. A constant reads the same on every
   * frame including a re-simulated one, so the two stay in step and this block
   * can go on asserting no desyncs.
   *
   * Death rather than completion, and that is the whole reason this is
   * survivable: `deadFire`'s frame 32 calls `GameOver()`, which only puts the
   * board up. `Recuent` would ALSO write a medal and a best time into the pair's
   * shared progress -- and a level finished in no time flat beats the row seeded
   * at the top of this file, which two later blocks read back. The board is the
   * thing under test, and both boards are taken down by the same code.
   */
  //
  // Both wrappers are NON-ENUMERABLE own properties, and that is load-bearing.
  // The rollback snapshot walks every enumerable field of the Game and puts each
  // one back on restore, functions included. A plain `g.StartGame = ...` was
  // therefore simulation state: a correction that restored a snapshot taken
  // while it was installed resurrected it on that one peer, after
  // `playNormally` had removed it -- and that peer's next level died at frame
  // 0 while the other's ran. That is the `desync at frame 8: a69475f3` this
  // block reported intermittently, locally and in CI. The game was in step;
  // the test had put its own patch inside what it was comparing.
  const endNextLevel = (page) => page.evaluate(() => {
    const g = window.__fbwg.view.game;
    if (Object.hasOwn(g, "StartGame")) return;
    const real = g.StartGame;
    Object.defineProperty(g, "StartGame", { configurable: true, writable: true, enumerable: false, value: function (...args) {
      const out = real.apply(this, args);
      // A getter, because the level writes to this itself -- it is set from the
      // physics contact and cleared on the way in. The setter swallows both.
      Object.defineProperty(this.m_level.myContactListener, "deadFire", {
        get: () => true, set: () => {}, configurable: true,
      });
      return out;
    } });
  });

  /** Put `StartGame` back, or every level after this one dies as it begins. */
  const playNormally = (page) => page.evaluate(() => {
    // Deleting the own property uncovers the prototype's method again.
    delete window.__fbwg.view.game.StartGame;
  });

  /** Wait for the results or game-over board to reach both of them. */
  const awaitBoard = () => until(
    () => window.__fbwg.view.game.children
      .some((c) => c.Rboard || c.GOboard),
    (both) => both[0] && both[1], 200);

  /**
   * Are the two of them playing the same game?
   *
   * Asked of their HISTORIES, not of their present. Comparing two live pages at
   * one instant asks them to be on the same frame at the same millisecond,
   * which under rollback they legitimately are not -- the newest frame or two
   * on each side is a prediction -- and which on a loaded machine they simply
   * are not, because each round trip costs frames. That assertion measured how
   * busy the computer was.
   *
   * `session.log` is the combined input the session actually simulated each
   * frame, corrected in place when a prediction turns out wrong. Two peers
   * whose logs agree over a settled prefix ran the same frames, and the engine
   * being a pure function of that log is proved exhaustively elsewhere. The
   * present tense is left to `desyncs`, which the sessions compare digests for
   * continuously and report on their own.
   *
   * Twenty frames back from the nearer frontier, because the last few are the
   * predictions.
   */
  const agree = async (minFrame = 60) => {
    for (let i = 0; i < 80; i++) {
      const [x, y] = await Promise.all([a, b].map((p) => p.evaluate(() => {
        const s = window.__fbwg.view.session;
        return { frame: s.frame, log: s.log };
      })));
      const upto = Math.min(x.frame, y.frame) - 20;
      if (upto >= minFrame) {
        const mine = x.log.slice(0, upto).join();
        const theirs = y.log.slice(0, upto).join();
        if (mine === theirs) return { frame: upto, x, y };
        return null;                      // they ran different games
      }
      await a.waitForTimeout(250);
    }
    return null;
  };

  /**
   * Alice's Invite button for a particular friend.
   *
   * Scoped to the row, because she has more than one friend now and the bare
   * selector matches every Invite on the panel -- which Playwright rejects
   * rather than guessing at, correctly.
   */
  const inviteRow = (page, who) =>
    page.locator(`.friend-row:has-text("${who}") button.invite-friend`);

  /** Poll both pages with one evaluate each until they agree with `want`. */
  const until = async (read, want, tries = 60, gap = 150) => {
    let last;
    for (let i = 0; i < tries; i++) {
      last = await Promise.all([a, b].map((p) => p.evaluate(read)));
      if (want(last)) return last;
      await a.waitForTimeout(gap);
    }
    return null;
  };

  console.log("\nan invitation can be taken back");
  {
    // Cancel used to hide the banner and nothing else: the invitation carried
    // on being accepted behind it and the game started anyway.
    await inviteRow(a, bob.username).click();
    await a.waitForSelector(".banner select");
    await a.click(".banner button:has-text('Send invite')");
    await b.waitForSelector(".banner:has-text('wants to play')", { timeout: 30000 });

    await a.click(".banner button:has-text('Cancel')");
    await b.waitForSelector(".banner:has-text('called that off')", { timeout: 20000 });
    check("bob is told, rather than left holding an invitation",
          /called that off/.test(await b.locator(".banner").innerText()), true);
    check("and neither of them ended up in a game",
          await Promise.all([a, b].map((p) =>
            p.evaluate(() => window.__fbwg.view.session === null))),
          [true, true]);
    await b.click(".banner button:has-text('Dismiss')");
    check("and alice can invite again",
          await inviteRow(a, bob.username).isEnabled(),
          true);
  }

  console.log("\nand declined, which is an answer and not silence");
  {
    // Declining used to do nothing at all, so the only way to say no was to say
    // nothing -- which is also what somebody who has walked away from their desk
    // does. The inviter waited out two full minutes either way.
    await inviteRow(a, bob.username).click();
    await a.waitForSelector(".banner select");
    await a.click(".banner button:has-text('Send invite')");
    await b.waitForSelector(".banner:has-text('wants to play')", { timeout: 30000 });

    await b.click(".banner button:has-text('Decline')");
    await a.waitForSelector(".banner:has-text('not now')", { timeout: 20000 });
    check("alice hears it, well inside the two minutes she used to wait",
          /not now/.test(await a.locator(".banner").innerText()), true);
    await b.locator(".banner").waitFor({ state: "hidden", timeout: 5000 });
    check("and bob's banner is gone", await b.locator(".banner").isHidden(), true);
    await a.click(".banner button:has-text('Cancel')");
  }

  console.log("\nalice invites bob, and assigns the roles");
  await inviteRow(a, bob.username).click();
  await a.waitForSelector(".banner select");
  // Alice deliberately makes BOB Fireboy, so the test proves the assignment
  // travels rather than each peer picking for itself.
  await a.selectOption(".banner select >> nth=2", "them");
  await a.click(".banner button:has-text('Send invite')");

  await b.waitForSelector(".banner:has-text('wants to play')", { timeout: 30000 });
  const offer = await b.locator(".banner span").first().innerText();
  check("bob is told he would be Fireboy",
        /would be Fireboy/.test(offer), true);
  await b.click(".banner button:has-text('Accept')");

  console.log("\nthey connect and start the same level");
  for (const p of [a, b]) {
    await p.waitForFunction("window.__fbwg && window.__fbwg.view.session",
                            null, { timeout: 60000 });
  }
  const slots = await Promise.all([a, b].map((p) =>
    p.evaluate(() => window.__fbwg.view.slot)));
  check("bob took Fireboy, alice Watergirl", slots, [1, 0]);

  const kinds = await Promise.all([a, b].map((p) =>
    p.locator(".status").innerText()));
  console.log(`  link: ${kinds.join("  |  ")}`);

  await Promise.all([a, b].map((p) => p.waitForFunction(
    "window.__fbwg.view.level !== null", null, { timeout: 30000 })));
  check("both are in a level",
        await Promise.all([a, b].map((p) =>
          p.evaluate(() => window.__fbwg.view.level.CurrentMode))),
        ["adventure", "adventure"]);

  console.log("\nthey play, and simulate the same game");
  // Each peer drives its OWN character with whatever keys it likes; the engine
  // maps either scheme onto the one character you have.
  const fire = slots[0] === 0 ? a : b;
  const water = slots[0] === 0 ? b : a;
  await fire.click("#stage");
  await water.click("#stage");
  await fire.keyboard.down("ArrowRight");
  await water.keyboard.down("ArrowLeft");
  // Held until they have gone somewhere, not for a fixed three seconds. The
  // game runs on wall time, and wall time buys fewer frames on a machine
  // running three browsers than on an idle one -- so a fixed wait is a bet on
  // how busy the machine is, and this test lost it.
  //
  // Asked of BOTH pages, never one. The peer that is ahead draws the other
  // character from a prediction of keys still held down -- which is how alice
  // could see bob's Fireboy at x = 22 while bob, the only one whose keyboard
  // moves him, had got him to 15. Releasing on her say-so let go of his key
  // early, and the real Fireboy stopped short of the line this asserts.
  for (let i = 0; i < 60; i++) {
    await a.waitForTimeout(250);
    const far = await Promise.all([a, b].map((p) => p.evaluate(() => {
      const lv = window.__fbwg.view.level;
      return lv ? lv.pers1.GetPosition().x > 22 && lv.pers2.GetPosition().x < 4
                : false;
    })));
    if (far.every(Boolean)) break;
  }
  await fire.keyboard.up("ArrowRight");
  await water.keyboard.up("ArrowLeft");

  /**
   * Wait for the two to agree.
   *
   * Under rollback the newest frame or two on each side is a PREDICTION, so two
   * peers compared at an arbitrary instant legitimately differ -- that is the
   * mechanism working. They converge as the truth arrives, so the assertion is
   * that they agree within a couple of seconds, not that they agree right now.
   */
  const agreed = await agree();
  check("the two peers agree on the simulation", agreed !== null, true);
  if (agreed) console.log(`  identical for ${agreed.frame} frames`);

  // Where the characters are, which is the thing a person would look at. Read
  // in one evaluate per page so the two numbers come from one moment -- and
  // not during a correction, which replays across ticks with the picture held
  // still and the level itself wound back to the snapshot underneath it.
  await until(() => window.__fbwg.view.session.recovering, (both) => both.every((r) => !r));
  const where = await Promise.all([a, b].map((p) => p.evaluate(() => {
    const lv = window.__fbwg.view.level;
    return lv ? [+lv.pers1.GetPosition().x.toFixed(1),
                 +lv.pers2.GetPosition().x.toFixed(1)] : null;
  })));
  check("having actually moved apart",
        !!where[0] && where[0][0] > 20 && where[0][1] < 5, true);

  const desyncs = await Promise.all([a, b].map((p) =>
    p.evaluate(() => window.__fbwg.view.session.desyncs)));
  check("no desyncs", desyncs, [0, 0]);

  console.log("\nthe buttons inside the game reach both machines");
  {
    // The bug this is here for: a click on the canvas ran the ported 2009
    // handler locally and told nobody, so it either desynced the pair or -- if
    // it landed inside the rollback window -- was erased by the next correction
    // restoring a snapshot that still had the screen it was meant to dismiss.
    await pressInGame(b, "m_pauseMenu.btn");
    const paused = await until(
      () => !!window.__fbwg.view.game.m_level?.pause,
      (both) => both[0] && both[1]);
    check("one player's mouse on the pause tab pauses both", paused, [true, true]);

    const before = await Promise.all([a, b].map((p) =>
      p.evaluate(() => window.__fbwg.view.simFrame)));
    await pressInGame(b, "m_pauseMenu.retryBtn");
    // Two claims, asked separately, because they are true at different times.
    // "Both rebuilt" is visible the moment the frame counter drops; "both agree"
    // needs the two peers observed on the same frame, which under rollback is a
    // moment that has to be waited for. Requiring them in one sample means
    // waiting for a window where both hold at once -- narrow, and for no reason.
    const rebuilt = await until(() => ({
      frame: window.__fbwg.view.session.frame,
      paused: !!window.__fbwg.view.game.m_level?.pause,
    }), (both) => both[0].frame < before[0] && both[1].frame < before[1]);
    check("one player's mouse on retry rebuilds the level on both",
          rebuilt !== null, true);
    if (rebuilt) {
      check("with nobody left paused in it",
            [rebuilt[0].paused, rebuilt[1].paused], [false, false]);
    }
    check("and they are in step in it", (await agree()) !== null, true);
    check("still no desyncs",
          await Promise.all([a, b].map((p) =>
            p.evaluate(() => window.__fbwg.view.session.desyncs))), [0, 0]);
  }

  console.log("\nback to the map, which has to be a place they can use");
  {
    // Quitting used to stop the world. The page handed its clock to a session
    // that returns immediately when no level is running, so the map never drew
    // a frame and a level built by the next click never advanced one.
    await pressInGame(b, "m_pauseMenu.endGameBtn");
    const left = await until(
      () => ({ running: window.__fbwg.view.session.running,
               level: window.__fbwg.view.level !== null }),
      (both) => !both[0].running && !both[1].running &&
                !both[0].level && !both[1].level);
    check("both are out of the level", left !== null, true);

    const first = await Promise.all([a, b].map((p) =>
      p.evaluate(() => window.__fbwg.view.simFrame)));
    await a.waitForTimeout(1000);
    const second = await Promise.all([a, b].map((p) =>
      p.evaluate(() => window.__fbwg.view.simFrame)));
    const moving = [second[0] > first[0], second[1] > first[1]];
    check("and the map is running, not frozen", moving, [true, true]);
    if (!moving[0] || !moving[1]) {
      // A frozen map and a map that is not there at all look identical from a
      // frame counter, and they have nothing to do with each other.
      for (const [tag, p] of [["A", a], ["B", b]]) {
        console.log(`  [${tag}] ` + JSON.stringify(await p.evaluate(() => {
          const v = window.__fbwg.view;
          return {
            screens: v.game.children.map((c) => c.symbol).filter(Boolean),
            map: !!v.game.m_mainMenu,
            node: !!(v.game.m_mainMenu && v.game.m_mainMenu.b_1_1),
            level: !!v.game.m_level,
            onStage: !!(v.game.m_level && v.game.m_level.parent),
            session: v.session === null ? null : v.session.running,
            sessionFrame: v.session === null ? null : v.session.frame,
            viewFrame: v.simFrame,
          };
        })));
      }
    }

    // Bob did not send the invitation, so the levels are not his to pick.
    await clickInGame(b, "m_mainMenu.b_1_1");
    await b.waitForSelector(".banner:has-text('to pick')", { timeout: 10000 });
    check("bob is told the pick is not his",
          await b.evaluate(() => window.__fbwg.view.session.running), false);

    // Alice did, so hers starts it for both.
    await clickInGame(a, "m_mainMenu.b_1_1");
    const started = await until(() => ({
      running: window.__fbwg.view.session.running,
      mode: window.__fbwg.view.level?.CurrentMode ?? null,
      num: window.__fbwg.view.level?.CurrentLevel ?? null,
    }), (both) => both[0].running && both[1].running &&
                  both[0].mode !== null && both[1].mode !== null);
    check("and alice's pick starts the same level on both", started !== null, true);
    if (started) {
      check("the level they both got",
            [started[0].mode, started[0].num, started[1].mode, started[1].num],
            ["adventure", 1, "adventure", 1]);
    }
    check("and they are playing it together", (await agree(40)) !== null, true);
    check("with no desyncs from any of it",
          await Promise.all([a, b].map((p) =>
            p.evaluate(() => window.__fbwg.view.session.desyncs))), [0, 0]);
  }

  console.log("\na link that dies is rebuilt, and the level starts again");
  {
    // Killing the data channel from inside the page is as close to pulling the
    // wifi as a test can get: the peer connection goes, both sides find out
    // from their own transports, and everything after that is the real path.
    // Wait for them to be properly into it. The scene before this one started
    // a fresh level, so measuring immediately would compare a restart against
    // a level that had barely begun and prove nothing either way.
    const under = await until(() => window.__fbwg.view.session.frame,
                              (both) => both[0] > 80 && both[1] > 80);
    check("they were some way into the level", under !== null, true);
    const before = under ?? [0, 0];

    // Which link there is to break depends on the machine. A pair reaches each
    // other over WebRTC when their NATs allow it and over the pair's Realtime
    // channel when they do not, and this section is about neither -- it is
    // about what happens when the one they got dies. So: find the real thing at
    // the bottom of the chain and break THAT.
    //
    // `session.transport` is not it. It is a stack of wrappers -- `WatchMirror`
    // when the pair is sharing, then `boundedTransport` always -- and each one
    // holds the next as `inner`. This used to reach straight for `.pc`, which
    // was correct on the day it was written and stopped being correct the day
    // `boundedTransport` was added on top: a plain object literal with no `pc`
    // and no `pair`, so the reach failed on EVERY path and read as "WebRTC did
    // not establish on this machine". It was not the machine.
    const broke = await b.evaluate(async () => {
      let t = window.__fbwg.view.session.transport;
      while (t.inner) t = t.inner;

      // WebRTC. Closing the peer connection is what the wifi going away does:
      // `onconnectionstatechange` reports `closed` here, and the far side's
      // ICE fails a moment later.
      if (t.pc) { t.pc.close(); return "peer connection"; }

      // The relay. `RealtimeTransport` holds a `ByteChannel` -- deliberately
      // narrow, so a spectator riding the same transport is not handed the
      // pair's presence and invitations -- which means there is no channel to
      // close through it, and that narrowing is worth more than this test is.
      //
      // The pair channel is reachable through the lobby instead, and killing
      // it is the failure the app was written for: the server pushes
      // `phx_close`, presence, invitations and the game all die together, and
      // `PairChannel.rejoin` builds a replacement. Six seconds of grace pass
      // before the status is believed; the wait below is fifty.
      if (t.pair) {
        const pairs = [...(window.__fbwg.lobby?.channels?.values() ?? [])];
        if (!pairs.length) return null;
        await Promise.all(pairs.map((p) => p.channel.unsubscribe()));
        return "relay";
      }
      return null;
    });
    check("there was a link to break", broke !== null, true);
    console.log(`  (the pair was on a ${broke})`);

    // The restart is asserted INSIDE the wait, not after it. A level that has
    // begun again counts up from zero at twenty-six frames a second, so by the
    // time a poll happens to catch both peers agreeing it can already be past
    // where the old one was -- and then "did it start again" reads as no.
    //
    // Which way back is right depends on what broke. A dead peer connection is
    // a dead session: the pair rebuild it, and the level starts again. A relay
    // channel the client rejoins inside its grace period is not reported to
    // anyone -- the pipe is replaced underneath -- so the right outcome there
    // is that the game simply carries on: each stalled peer repeats its input
    // until the other hears it. Before that repeat existed, both sat on
    // "Waiting for your friend" for good, and this section said so.
    const relay = broke === "relay";
    const back = await until(() => ({
      running: window.__fbwg.view.session?.running ?? false,
      frame: window.__fbwg.view.session?.frame ?? -1,
    }), (both) => both[0].running && both[1].running && (relay
      ? both.every((x, i) => x.frame < before[i] || x.frame > before[i] + 60)
      : both[0].frame < before[0] && both[1].frame < before[1]),
      200, 250);
    check(relay ? "both are playing again" : "both are back in a level, and it started again",
          back !== null, true);
    if (!back) {
      // Which half did not come back: the channel, the session, or the level.
      for (const [tag, p] of [["A", a], ["B", b]]) {
        console.log(`  [${tag}] ` + JSON.stringify(await p.evaluate(() => {
          const v = window.__fbwg.view, s = v.session;
          let t = s?.transport;
          while (t?.inner) t = t.inner;
          return {
            session: !!s, running: s?.running ?? null, frame: s?.frame ?? null,
            generation: s?.generation ?? null, linkDown: s?.linkDown ?? null,
            kind: t?.kind ?? null,
            channels: [...(window.__fbwg.lobby?.channels?.values() ?? [])]
              .map((ch) => `${ch.topic?.slice(0, 18)}=${ch.channel?.state}`),
            status: document.querySelector(".status")?.textContent?.slice(0, 80),
            banner: document.querySelector(".banner")?.hidden ? null
              : document.querySelector(".banner")?.textContent?.slice(0, 100),
          };
        })));
      }
    }
    if (back) console.log(`  restarted at frame ${back[0].frame}, ` +
                          `where they had reached ${before[0]}`);
    const together = await agree();
    check("and they are in step in it", together !== null, true);
    if (together) console.log(`  identical for ${together.frame} frames`);
    check("with no desyncs",
          await Promise.all([a, b].map((p) =>
            p.evaluate(() => window.__fbwg.view.session.desyncs))), [0, 0]);
  }

  console.log("\nand the level pick can be handed over");
  {
    // Alice invited, so the picks are hers. Giving them away is a message on
    // the pair's channel rather than a command, because between levels nothing
    // is being simulated and there is no frame to agree on.
    await pressInGame(b, "m_pauseMenu.endGameBtn");
    // Asserted, not merely awaited. The button below exists only between
    // levels, so a pair still IN one fails the next check instead of this one
    // -- which reads as "the handover is broken" when what actually happened is
    // that nobody left the level.
    const out = await until(() => window.__fbwg.view.session.running,
                            (both) => !both[0] && !both[1]);
    check("bob's End game takes them both back to the map", out !== null, true);

    // Matched on "pick" rather than on "Let", because `has-text` is a
    // case-insensitive substring and that same group also holds "Let friends
    // watch". Opened by hand rather than through `menuAction`, because this
    // asserts on what the menu SHOWS before pressing anything.
    const offer = ".menu-actions button:has-text('pick')";
    await Promise.all([a, b].map(openMenu));
    const offered = await Promise.all([a, b].map((p) =>
      p.locator(offer).isVisible()));
    check("only alice can offer to hand it over", offered, [true, false]);
    if (offered[0] !== true || offered[1] !== false) {
      // `showHand` wants a match, a stopped session and the pick. Which of the
      // three is missing is the whole question, and a boolean cannot say.
      for (const [tag, p] of [["A", a], ["B", b]]) {
        console.log(`  [${tag}] ` + JSON.stringify(await p.evaluate(() => {
          const v = window.__fbwg.view;
          return {
            running: v.session?.running ?? null,
            canChooseLevel: v.canChooseLevel,
            level: v.level !== null,
            paused: !!v.game.m_level?.pause,
            actions: [...document.querySelectorAll(".menu-actions button")]
              .map((el) => ({ text: el.textContent, hidden: el.hidden })),
          };
        })));
      }
    }
    await closePanel(b);

    // Whether the message arrives at all is worth seeing on failure: a
    // handover that does not land looks exactly like a page that ignored one.
    await b.evaluate(() => {
      window.__handovers = [];
      window.__fbwg.lobby.onHandover((h) => window.__handovers.push(h));
    });

    // Alice's menu is still open from the check above, which is where the
    // button lives.
    await a.click(offer);
    await closePanel(a);
    // Alice is the one who loses it, so Alice is the one told a name; bob is
    // told it is his.
    try {
      await a.waitForSelector(".banner:has-text('picks the next level')",
                              { timeout: 15000 });
      await b.waitForSelector(".banner:has-text('You pick the next level')",
                              { timeout: 15000 });
    } catch (err) {
      // The message rides the pair's channel, which is also presence and
      // invitations -- so if it did not arrive, say whether the channel is
      // even open before blaming the feature.
      for (const [tag, p] of [["A", a], ["B", b]]) {
        console.log(`  [${tag}] ` + JSON.stringify(await p.evaluate(() => ({
          channels: [...window.__fbwg.lobby.channels.values()]
            .map((c) => c.channel.state),
          heard: window.__handovers ?? null,
        }))));
      }
      throw err;
    }
    check("and after that it is bob who picks",
          await Promise.all([a, b].map((p) =>
            p.evaluate(() => window.__fbwg.view.canChooseLevel))),
          [false, true]);

    // Which is to say the refusal has swapped sides too.
    await clickInGame(a, "m_mainMenu.b_1_1");
    await a.waitForSelector(".banner:has-text('to pick')", { timeout: 10000 });
    check("alice is now the one who cannot start it",
          await a.evaluate(() => window.__fbwg.view.session.running), false);

    await clickInGame(b, "m_mainMenu.b_1_1");
    const started = await until(() => window.__fbwg.view.session.running,
                                (both) => both[0] && both[1]);
    check("and bob's pick starts it for both", started !== null, true);
    check("and they are playing it together", (await agree(40)) !== null, true);
  }

  console.log("\na level that ends leaves nothing behind, and the next is clean");
  {
    // The case the whole suite used to walk around. Every other route out of a
    // level here goes through the pause tray's End Game, and no board is ever
    // on screen when the command is applied -- so the fact that `EndGame` and
    // `RetryGame` do not remove one, and that the only code which did was the
    // click listener the intent hook now swallows, was invisible. What it looks
    // like in front of a person is a near-opaque board sitting over the map and
    // over every level after it, answering the keyboard for the rest of the
    // evening.
    await pressInGame(b, "m_pauseMenu.endGameBtn");
    const onMap = await until(
      () => window.__fbwg.view.session?.running ?? null,
      (both) => both.every((x) => x === false));
    check("the pause tray put them back on the map", onMap !== null, true);

    // Ask who is holding the pick rather than assuming it. Which of them it is
    // depends on every handover and reconnection above this line, and a block
    // that guesses wrong does not fail as "the wrong person picked" -- it fails
    // as a level that never started, three assertions later.
    const holds = await Promise.all([a, b].map((p) =>
      p.evaluate(() => window.__fbwg.view.canChooseLevel)));
    check("exactly one of them is holding the pick",
          holds.filter(Boolean).length, 1);
    const picker = holds[0] ? a : b;
    const other = holds[0] ? b : a;

    // Both of them, and BEFORE the level exists, so the level each of them
    // builds for the coming Start is the same level.
    await endNextLevel(a);
    await endNextLevel(b);

    await clickInGame(picker, "m_mainMenu.b_1_1");
    const board = await awaitBoard();
    check("both of them see the board", board !== null, true);

    // Back to survivable levels before anybody picks another one.
    await playNormally(a);
    await playNormally(b);

    check("and it is the death screen",
          await a.evaluate(() => window.__fbwg.view.game.children
            .some((x) => x.GOboard)), true);

    // The one who did NOT pick the level presses it: either of them may, it
    // travels as a command, and it has to land on both.
    await other.evaluate(() => {
      const v = window.__fbwg.view;
      const board = v.game.children.filter((x) => x.GOboard).pop();
      v.shell.pointerDown(board.GOboard.ToMenuBtn);
      v.shell.pointerUp();
    });

    const clean = await until(
      () => ({
        running: window.__fbwg.view.session?.running ?? null,
        boards: window.__fbwg.view.game.children
          .filter((x) => x.Rboard || x.GOboard).length,
        maps: window.__fbwg.view.game.children
          .filter((x) => x.symbol === "MainMenu").length,
      }),
      (both) => both.every((x) => x.running === false && x.boards === 0 &&
                                  x.maps === 1));
    if (!clean) {
      for (const [tag, p] of [["A", a], ["B", b]]) {
        console.log(`  [${tag}] ` + JSON.stringify(await onScreen(p)));
      }
    }
    check("back takes the board down on BOTH machines, onto one map",
          clean !== null, true);

    // Which is the thing an object path could never see: with a board left up,
    // this throws rather than quietly pressing through it.
    await clickInGame(picker, "m_mainMenu.b_1_1");
    const next = await until(() => ({
      running: window.__fbwg.view.session?.running ?? null,
      boards: window.__fbwg.view.game.children
        .filter((x) => x.Rboard || x.GOboard).length,
    }), (both) => both.every((x) => x.running));
    check("and the next pick starts a level with nothing over it",
          next && [next[0].boards, next[1].boards], [0, 0]);
    check("in step, as ever", (await agree(40)) !== null, true);
    check("with no desyncs",
          await Promise.all([a, b].map((p) =>
            p.evaluate(() => window.__fbwg.view.session?.desyncs ?? -1))),
          [0, 0]);
  }

  console.log("\nand a third person can watch, once they are let in");
  {
    // Determinism is what makes this nearly free: the simulation is a pure
    // function of the level and the input log, so a watcher fed the two
    // players' three bits each per frame reaches the same world. What the test
    // is really asking is whether the same world actually arrives.
    // Nothing is publishable until the pair says so, so there is nothing for
    // carol to join yet.
    check("nothing to watch before they share it",
          await c.locator(".panel button.watch").count(), 0);

    // BOTH of them, and that is the feature rather than a detail of the test.
    // `match_consent` returns `shared` as `consent_a and consent_b`, because
    // being watched is not something one of two people gets to decide for the
    // other. This section pressed only alice's button, which is why it never
    // reached the assertion below: her switch turns into "Cancel sharing
    // request" and waits.
    //
    // The wait is asserted rather than passed through. A pair that published a
    // feed on one consent would be a real hole, and it would show up here as
    // nothing worse than a test that got further than usual.
    // Exercise a control-plane response that outlives the menu animation.
    await a.route('**/rest/v1/rpc/match_consent', async route => {
      await new Promise(resolve => setTimeout(resolve,750));
      await route.continue();
    }, {times:1});
    await menuAction(a, "Let friends watch");
    const shareLabels = (p) =>
      p.locator(".menu-actions button").allTextContents();
    // Consent is an RPC followed by a UI refresh. Closing the menu does not
    // wait for that round trip, so wait for its acknowledged pending state.
    await a.waitForFunction(() => [...document.querySelectorAll('.menu-actions button')]
      .some(button => button.textContent === 'Cancel sharing request'));
    check("one player asking is not enough",
          (await shareLabels(a)).some((t) => t === "Cancel sharing request"),
          true);
    check("and there is still nothing for carol to join",
          await c.locator(".panel button.watch").count(), 0);

    await menuAction(b, "Let friends watch");
    let offered = false;
    for (let i = 0; i < 60 && !offered; i++) {
      await c.waitForTimeout(500);
      offered = (await c.locator(".panel button.watch").count()) > 0;
    }
    if (!offered) {
      const look = (p) => p.evaluate(() => ({
        channels: [...(window.__fbwg.lobby?.channels ?? new Map()).entries()]
          .map(([, ch]) => `${ch.topic.slice(0, 18)}=${ch.channel.state}`),
        share: [...document.querySelectorAll(".menu-actions button")]
          .map((b) => b.textContent + (b.hidden ? " (hidden)" : "")),
      }));
      console.log("  [A] " + JSON.stringify(await look(a)));
      console.log("  [B] " + JSON.stringify(await look(b)));
      console.log("  [C] " + JSON.stringify(await look(c)));
    }
    check("and a row appears once they do", offered, true);

    await c.click(".panel button.watch");
    await c.waitForSelector("#stage", { timeout: 20000 });
    await c.waitForFunction(
      "window.__fbwgWatch && window.__fbwgWatch.view.session", null,
      { timeout: 30000 });
    check("carol is watching, not playing",
          await c.evaluate(() => window.__fbwgWatch.view.watching), true);

    // Carol can be replaying a confirmed snapshot of the current level while
    // the players move on. A running watcher is therefore not sufficient:
    // wait for the generation of the new level before comparing input logs.
    //
    // Bob starts it, because the scene before this one handed him the pick.
    await pressInGame(b, "m_pauseMenu.endGameBtn");
    await until(() => window.__fbwg.view.session.running,
                (both) => !both[0] && !both[1]);
    await clickInGame(b, "m_mainMenu.b_1_1");
    await b.waitForFunction(() => window.__fbwg.view.session.running);
    const watchGeneration=await b.evaluate(() => window.__fbwg.view.session.generation);

    let saw = null;
    for (let i = 0; i < 120 && !saw; i++) {
      const st = await c.evaluate(() => {
        const v = window.__fbwgWatch.view;
        return { running: v.session?.running ?? false,
                 generation: v.session?.generation,
                 frame: v.session?.frame ?? -1, digest: v.digest() };
      });
      if (st.running && st.generation === watchGeneration && st.frame > 30 && st.digest) saw = st;
      else await c.waitForTimeout(250);
    }
    check("the watcher reaches the level the pair started", saw !== null, true);
    if (!saw) {
      // Which half is quiet: the pair not publishing, or the watcher not
      // hearing. The mirror counts what it actually put on the topic.
      console.log("  [A] " + JSON.stringify(await a.evaluate(() => ({
        sharing: window.__fbwg.view.session?.running ?? null,
        mirrored: window.__fbwg.view.session?.transport?.sent ?? "no mirror",
      }))));
      console.log("  [C] " + JSON.stringify(await c.evaluate(() => ({
        session: !!window.__fbwgWatch.view.session,
        running: window.__fbwgWatch.view.session?.running ?? null,
        frame: window.__fbwgWatch.view.session?.frame ?? -1,
        banner: document.querySelector(".banner")?.textContent?.slice(0, 80),
      }))));
    }

    if (saw) {
      // Compared at the same frame rather than the same moment: a watcher runs
      // a little behind because it waits for both players instead of guessing
      // at either, so "now" is not a fair question to ask of both.
      // Bounded by what alice has CONFIRMED, and taken across a run that did
      // not change underneath. Both of those are needed, and neither was here.
      //
      // `log[frame]` is written on the speculative pass and REWRITTEN when a
      // rollback corrects the guess, so alice's entries above `confirmed` are
      // provisional; the watcher's are not, because a watcher waits for both
      // players rather than guessing at either. Comparing up to the watcher's
      // frame therefore compared settled bytes against unsettled ones. And
      // `resetLog` empties the log outright on a new run, so two reads that
      // straddle a level change are comparing two different levels.
      //
      // This passed at frame 35 and at 43 and failed at 297 -- not because
      // anything differed, but because a longer game gives both of those more
      // room. An assertion that holds only while the window is small is not
      // holding for the reason it claims.
      let at = 0, theirs = "", watched = "", comparable = false;
      for (let i = 0; i < 10; i++) {
        const before = await a.evaluate(() => ({
          run: window.__fbwg.view.session.runSerial,
          generation: window.__fbwg.view.session.generation,
          confirmed: window.__fbwg.view.session.confirmed,
          log: window.__fbwg.view.session.log.slice(),
        }));
        const observer=await c.evaluate(() => ({
          generation: window.__fbwgWatch.view.session.generation,
          frame: window.__fbwgWatch.view.session.frame,
          log: window.__fbwgWatch.view.session.log.slice(),
        }));
        if (before.generation !== watchGeneration || observer.generation !== watchGeneration) {
          await a.waitForTimeout(250); continue;
        }
        at = Math.min(observer.frame, before.confirmed, before.log.length, observer.log.length);
        if (at < 20) { await a.waitForTimeout(250); continue; }
        theirs = before.log.slice(0,at).join();
        watched = observer.log.slice(0,at).join();
        const after = await a.evaluate(() =>
          window.__fbwg.view.session.runSerial);
        if (after === before.run) { comparable = true; break; }
        // The level changed mid-comparison. Nothing is wrong; read it again.
        theirs = ""; watched = "";
      }
      check("and every frame it ran was the frame they ran",
            comparable && at >= 20 && watched === theirs, true);
      console.log(`  compared ${at} confirmed frames in generation ${watchGeneration}`);
    }

    // Closing it takes the row away again.
    await menuAction(a, "Stop letting friends watch");
    await goPlay(c);
    await c.waitForSelector("#stage", { timeout: 20000 });
    let gone = false;
    for (let i = 0; i < 40; i++) {
      if (await c.locator(".panel button.watch").count() === 0) {
        gone = true; break;
      }
      await c.waitForTimeout(250);
    }
    check("and closing it takes the row away", gone, true);

    // Carol is done. Closed here rather than at the end, because everything
    // below is about two people on the slowest path there is -- a relayed pair
    // batching every 115 ms -- and a third browser on the same machine is load
    // that scene was never written to carry.
    await ctxC.close();
  }

  console.log("\nthe progress they see is the pair's, not each browser's");
  const seen = await Promise.all([a, b].map((p) => p.evaluate(() => {
    const cookie = window.__fbwg.view.game.The_cookie;
    return {
      shared: window.__fbwg.progress.shared,
      first: cookie.data.stats[0],
      second: cookie.data.stats[1],
      third: cookie.data.stats[2],
      time: cookie.data.timesString[0],
    };
  })));
  check("both adopted the pair's map",
        seen.map((x) => [x.shared, x.first, x.second, x.third]),
        [[true, 2, 0, -1], [true, 2, 0, -1]]);
  check("including the pair's best time", seen.map((x) => x.time),
        ["01:00", "01:00"]);

  console.log("\nand finishing a level writes it back for both of them");
  // Written the way `Recuent` writes it -- straight into the arrays, then the
  // ordinary flush the game loop already performs. Playing an entire level to
  // its exit doors through two browsers would take minutes and prove nothing
  // more about the SAVE path, which is what is under test here; that the
  // simulation reaches the same result on both sides is what the digest above
  // already established.
  //
  // The simulation is STOPPED first, and that is not a convenience. The save is
  // reachable from the Game, so it is part of what a rollback restores: writing
  // to it while corrections are still arriving means the write is reverted
  // within a frame or two. That is exactly the intended behaviour during play --
  // a medal awarded on a frame that gets taken back should be taken back with
  // it -- and it is why the real write is sent a second and a half later, from
  // whatever the arrays say once things have settled.
  await Promise.all([a, b].map((p) =>
    p.evaluate(() => window.__fbwg.view.setRunning(false))));

  await a.evaluate(() => {
    const cookie = window.__fbwg.view.game.The_cookie;
    cookie.data.stats[0] = 3;
    cookie.data.times[0] = 25;
    cookie.data.timesString[0] = "00:25";
    cookie.data.stats[2] = 0;          // finishing node 1 opens node 3
    cookie.flush();
    // `cookie.flush()` alone queues NOTHING once a pair is loaded. `store.flush`
    // is `if (!friendId) local.flush()` -- the solo path only -- because a pair's
    // results do not belong to this browser. What carries them is
    // `progress.confirm(...)`, which the game loop calls from `onConfirmed`
    // every 26th frame; and the loop was deliberately stopped two lines up so
    // that rollback cannot take the write back. So the loop's own call is made
    // here, standing in for it, which is what "the ordinary flush the game loop
    // already performs" meant.
    window.__fbwg.progress.confirm(cookie.data);
  });
  await a.waitForTimeout(3000);
  const wrote = await a.evaluate(() => ({
    saves: window.__fbwg.progress.saves,
    error: window.__fbwg.progress.lastError,
    // Where it stopped, if it did. `waiting` is the outbox depth: queued but
    // not drained is a different failure from never queued at all, and
    // `storageError` is the third -- IndexedDB refusing the record.
    waiting: window.__fbwg.progress.waiting,
    storage: window.__fbwg.progress.storageError,
  }));
  check("the write reached the database", [wrote.error, wrote.saves > 0],
        [null, true]);
  if (!(wrote.saves > 0)) console.log("  " + JSON.stringify(wrote));
  const stored = async () => {
    const r = await admin(`/rest/v1/pair_progress?select=node,medal,` +
      `best_time_s,best_time_str&user_a=eq.${lo}&user_b=eq.${hi}&order=node`);
    return (await r.json()).map((x) =>
      [x.node, x.medal, x.best_time_s, x.best_time_str]);
  };
  check("the better result is stored, and the new node opened",
        await stored(),
        [[1, 3, 25, "00:25"], [2, 0, null, null], [3, 0, null, null]]);

  // The other peer computes the same thing and writes it too. It must be safe.
  await b.evaluate(() => {
    const cookie = window.__fbwg.view.game.The_cookie;
    cookie.data.stats[0] = 1;
    cookie.data.times[0] = 300;
    cookie.data.timesString[0] = "05:00";
    cookie.flush();
  });
  await b.waitForTimeout(3000);
  check("and a worse one from the other peer changes nothing",
        await stored(),
        [[1, 3, 25, "00:25"], [2, 0, null, null], [3, 0, null, null]]);

  console.log("\nand one of them walking off mid-game says so");
  {
    // The block above deliberately stopped both loops to let a save settle, and
    // a session only applies a command on a frame it actually runs.
    // One page at a time, and asked whether the hook is there before reaching
    // through it: driving both at once caught a page mid-render once and threw
    // an error about the test harness rather than about the app.
    for (const [tag, p] of [["A", a], ["B", b]]) {
      const ready = await p.evaluate(() => typeof window.__fbwg === "object");
      if (!ready) {
        console.log(`  [${tag}] ` + JSON.stringify(await p.evaluate(() => ({
          hash: location.hash,
          stage: !!document.getElementById("stage"),
        }))));
        throw new Error(`page ${tag} has no play screen to resume`);
      }
      await p.evaluate(() => window.__fbwg.view.setRunning(true));
    }

    // Opening the friends list used to tear this screen down without a word,
    // which to the other person is indistinguishable from the game having died:
    // their partner stops moving and never starts again. This section used that
    // as the way to make bob leave.
    //
    // It is not one any more, and that is the FIX rather than a regression:
    // friends became a tab of this same drawer when the shell was redrawn, so
    // the game carries on behind it. So the old trigger becomes an assertion
    // that it no longer triggers anything...
    await openFriends(b);
    check("opening the friends list no longer ends the game",
          await b.evaluate(() => window.__fbwg.view.session !== null), true);
    await closePanel(b);

    // ...and leaving becomes what it now is: a deliberate act, from the Menu,
    // behind a confirm. Playwright dismisses a native dialog unless something
    // answers it, and a dismissed confirm means `endSession` is never called --
    // which would look exactly like the app ignoring the button.
    b.once("dialog", (d) => d.accept());
    await menuAction(b, "Leave game");
    await a.waitForSelector(".banner:has-text('left the game')", { timeout: 20000 });
    check("alice is told",
          /left the game/.test(await a.locator(".banner").innerText()), true);
    check("and is out of the session rather than stalled in it",
          await a.evaluate(() => window.__fbwg.view.session === null), true);
    // Bob's page said "online" as it was torn down, and that has to travel to
    // alice through presence before her row for him means anything. Asking the
    // instant her banner appears is asking too early.
    // Alice's drawer has been on other tabs since the watch section, and her
    // row for bob only exists while the friends tab is showing.
    await openFriends(a);
    let canInvite = false;
    for (let i = 0; i < 40 && !canInvite; i++) {
      // `isEnabled` THROWS on a locator that matches nothing, rather than
      // answering false the way `isVisible` does. So a missing row took the
      // whole run down thirty seconds later, and took the diagnostic below --
      // written for exactly this -- down with it, unrun.
      canInvite = await inviteRow(a, bob.username)
        .isEnabled({ timeout: 1000 }).catch(() => false);
      if (!canInvite) await a.waitForTimeout(500);
    }
    if (!canInvite) {
      // Which of the three reasons the button has for being dead is it? The
      // row is disabled by `!online || match !== null || pending !== null`, and
      // they are three different bugs.
      console.log("  [A] " + JSON.stringify(await a.evaluate((who) => ({
        friends: (window.__fbwg.lobby?.list ?? [])
          .map((f) => `${f.username}=${f.activity}`),
        rows: [...document.querySelectorAll(".friend-row")]
          .map((r) => r.textContent),
        mine: [...document.querySelectorAll(".friend-row button")]
          .map((x) => `${x.textContent}:${x.disabled ? "off" : "on"}`),
        who,
      }), bob.username)));
    }
    check("so she can start another game", canInvite, true);
    await goPlay(b);
    await b.waitForSelector("#stage", { timeout: 20000 });
  }

  console.log("\nand again with no peer connection available at all");
  {
    // The path a pair behind a strict NAT takes: no RTCPeerConnection, so the
    // game itself relays over the same Realtime channel that carried the
    // invitation. It is the reason this needs no TURN server, and until now it
    // was only tested with two tabs on a BroadcastChannel -- not over Realtime,
    // which is what a real pair would actually be using.
    for (const [ctx, page] of [[ctxA, a], [ctxB, b]]) {
      await ctx.addInitScript(() => { window.RTCPeerConnection = undefined; });
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector("#stage", { timeout: 40000 });
    }
    // Through `openFriends`, not straight at the row. A reload restores the
    // drawer from `localStorage` and a narrow window restores it closed, so
    // waiting for a friend row assumes a tab that may not be showing -- and
    // waits the full forty seconds to find out.
    for (const p of [a, b]) {
      await openFriends(p);
      await p.waitForSelector(".friend-row button:not([disabled])",
                              { timeout: 40000 });
    }

    await inviteRow(a, bob.username).click();
    await a.waitForSelector(".banner select");
    await a.click(".banner button:has-text('Send invite')");
    await b.waitForSelector(".banner:has-text('wants to play')", { timeout: 40000 });
    await b.click(".banner button:has-text('Accept')");

    for (const p of [a, b]) {
      await p.waitForFunction("window.__fbwg && window.__fbwg.view.session",
                              null, { timeout: 90000 });
    }
    // Status copy describes the player, not the implementation of the link.
    // Inspect the actual unwrapped transport so a working direct link cannot
    // accidentally satisfy this forced-NAT-failure test.
    const relayKinds = () => Promise.all([a, b].map(p => p.evaluate(async () => {
      const {RealtimeTransport} = await import('/src/net/realtime.ts');
      let transport = window.__fbwg.view.session.transport;
      while (transport.inner) transport = transport.inner;
      return transport instanceof RealtimeTransport;
    })));
    check("both fell back to the relay", await relayKinds(), [true, true]);

    await Promise.all([a, b].map((p) => p.waitForFunction(
      "window.__fbwg.view.level !== null", null, { timeout: 40000 })));
    await a.click("#stage");
    await a.keyboard.down("ArrowRight");
    await a.waitForTimeout(2500);
    await a.keyboard.up("ArrowRight");

    // Asked of their histories, like every other one of these. A relayed pair
    // batch every 115 ms, so the instant at which they happen to be on the same
    // frame is even harder to catch here than on a direct link -- and no more
    // interesting.
    const relayed = await agree(40);
    check("and still simulate the same game over it", relayed !== null, true);
    if (relayed) console.log(`  identical for ${relayed.frame} frames`);
    check("with no desyncs",
          await Promise.all([a, b].map((p) =>
            p.evaluate(() => window.__fbwg.view.session.desyncs))), [0, 0]);

    // And now the sequence that actually broke, which is not a hostile network
    // at all -- it is two people getting on with it.
    //
    // Realtime allows a client FIVE presence calls per channel per thirty
    // seconds, and the sixth does not fail: the server logs
    // ClientPresenceRateLimitReached and closes the channel. A pair spends
    // that budget by playing, because every level says "in a game" when it
    // starts and "in the lobby" when it ends -- and for a relayed pair the
    // channel that dies is the game link itself. Three levels was enough.
    //
    // Level one each time, and as fast as the two of them can be driven, so
    // the transitions land inside one window rather than being spread out by
    // a person actually reading the map.
    const started = Date.now();
    let churn = true;
    for (let i = 1; i <= 4 && churn; i++) {
      await pressInGame(b, "m_pauseMenu.endGameBtn");
      const off = await until(
        () => window.__fbwg.view.session?.running ?? null,
        (both) => both.every((r) => r === false));
      await clickInGame(a, "m_mainMenu.b_1_1");
      const on = await until(
        () => window.__fbwg.view.session?.running ?? null,
        (both) => both.every((r) => r === true));
      if (off === null || on === null) {
        churn = false;
        check(`transition ${i} of 4 completed`, { off, on }, "both");
      }
    }
    check("four level transitions in a row, on the relay", churn, true);
    console.log(`  took ${((Date.now() - started) / 1000).toFixed(1)}s` +
                " -- the budget window is 30s");

    // The channel is the thing under test. If it went, both of these say so:
    // the session is dropped and the header says what it is doing about it.
    check("both still hold a session",
          await Promise.all([a, b].map((p) =>
            p.evaluate(() => window.__fbwg.view.session !== null))),
          [true, true]);
    const saying = await Promise.all([a, b].map((p) =>
      p.locator(".status").innerText()));
    check("and neither is reconnecting",
          saying.map((t) => /reconnect/i.test(t)), [false, false]);
    check("still relayed", await relayKinds(), [true, true]);
    check("still in step after the transitions", await agree(40) !== null, true);
    check("and still no desyncs",
          await Promise.all([a, b].map((p) =>
            p.evaluate(() => window.__fbwg.view.session.desyncs))), [0, 0]);
  }

  // ---- a result that has to survive the page --------------------------------
  //
  // Writes are debounced a second and a half so that a medal awarded on a frame
  // the rollback takes back is taken back with it. That delay is also exactly
  // as long as it takes somebody who has just finished a level to click
  // "Friends" -- and `release()` used to start the final request without
  // awaiting it, clear the friend identity in the next statement, and return.
  // Route teardown then destroyed the view and the browser cancelled the
  // request. The screen had shown the medal; nothing anywhere had recorded it.
  //
  // Two halves, tested separately, because they fail in different ways.
  console.log("\na result written and abandoned still arrives");
  {
    // One: leave INSIDE the settle window. Friends is now an overlay and does
    // not release the pair. Open the menu before writing, then activate the
    // real Leave handler in the same task as the write, before its debounce.
    await openMenu(a);
    a.once("dialog", d => d.accept());
    await a.evaluate(() => {
      const cookie = window.__fbwg.view.game.The_cookie;
      cookie.data.stats[2] = 3;
      cookie.data.times[2] = 31;
      cookie.data.timesString[2] = "00:31";
      cookie.flush();
      // As in the save test above, only confirmed state may enter the outbox.
      window.__fbwg.progress.confirm(cookie.data);
      document.querySelector('.menu-actions button.leave').click();
    });
    await closePanel(a);
    // No wait at all: straight off the screen, well inside the 1500 ms timer.
    await openFriends(a);
    await a.waitForSelector("text=Send a request", { timeout: 20000 });
    await a.waitForTimeout(3000);
    const after = await stored();
    check("leaving the screen immediately still records it",
          after.find((r) => r[0] === 3), [3, 3, 31, "00:31"]);

    // Two: the request never happened at all. An entry left in the outbox --
    // which is what a cancelled request, a failed one, or a closed tab leaves
    // behind -- is replayed by the next authenticated session rather than lost.
    const friendId = await a.evaluate(() => window.__fbwg.progress.shared);
    check("and the screen has handed the pair's map back", friendId, false);

    await a.evaluate(async ({owner,them}) => {
      const {remember} = await import('/src/outbox.ts');
      const stats = new Array(32).fill(-1);
      const times = new Array(32).fill(0);
      const strs = new Array(32).fill("");
      stats[4] = 3; times[4] = 44; strs[4] = "IGNORED";
      await remember(owner,them,{stats,times,timesString:strs});
      // Ownerless legacy entries are quarantined, never silently attributed to
      // whichever account signs in next. Retain one alongside the valid entry.
      localStorage.setItem("fbwg.pairoutbox",JSON.stringify({legacy:'unassigned'}));
    }, {owner:alice.id,them:bob.id});
    check("there is something waiting to be sent",
          await a.evaluate(async owner => {
            const {pendingFor}=await import('/src/outbox.ts');
            return (await pendingFor(owner)).length;
          },alice.id),
          1);

    // Recreate the authenticated screen: setting the already-active play hash
    // does not mount a new session or replay its outbox.
    await a.reload({ waitUntil: "load" });
    await a.waitForSelector("#stage", { timeout: 20000 });
    await a.waitForTimeout(4000);
    const replayed = await stored();
    check("the next session sends it",
          replayed.find((r) => r[0] === 5), [5, 3, 44, "00:44"]);
    check("with a canonical time label",
          replayed.find((r) => r[0] === 5)?.[3], "00:44");
    check("and the outbox is empty again",
          await a.evaluate(async owner => {
            const {pendingFor}=await import('/src/outbox.ts');
            return (await pendingFor(owner)).length;
          },alice.id),0);
    check("ownerless legacy data remains quarantined",
          await a.evaluate(() => localStorage.getItem("fbwg.pairoutbox")),
          JSON.stringify({legacy:'unassigned'}));
  }

} catch (err) {
  failures++;
  console.log("  FAIL " + err.message);
} finally {
  await browser.close().catch(() => {});
  server.kill();
  // Deleting the users cascades through friendships to pair_progress.
  for (const u of users) {
    await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  }
  console.log(`\ncleaned up ${users.length} test users`);
}

console.log("\n" + (failures === 0
  ? "TWO PEOPLE PASSED"
  : `TWO PEOPLE FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
