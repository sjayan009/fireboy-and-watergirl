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

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");

const PORT = 5199;
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

// ---- the accounts, made the way the admin API makes them -------------------

const stamp = Date.now();
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

async function makeCode(n) {
  const code = `E2E-${stamp}-${n}`;
  await admin("/rest/v1/invite_codes", {
    method: "POST",
    body: JSON.stringify({ code, max_uses: 1, note: "twopeople" }),
  });
  return code;
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
async function signIn(page, user, code) {
  await page.goto(URL_, { waitUntil: "load" });
  await page.waitForSelector("input[type=email]", { timeout: 30000 });
  await page.fill("input[type=email]", user.email);
  await page.fill("input[type=password]", user.password);
  await page.click("button[type=submit]");

  await page.waitForSelector("text=Pick a name", { timeout: 30000 });
  const inputs = page.locator("form input");
  await inputs.nth(0).fill(user.username);
  await inputs.nth(1).fill(code);
  await page.click("button[type=submit]");
  await page.waitForSelector("#stage", { timeout: 30000 });
}

try {
  console.log("two accounts, two browser contexts");
  const alice = await makeUser("a");
  const bob = await makeUser("b");

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  for (const [tag, p] of [["A", a], ["B", b]]) {
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
  }

  await signIn(a, alice, await makeCode(0));
  await signIn(b, bob, await makeCode(1));
  check("both are signed in and named",
        await Promise.all([a, b].map((p) =>
          p.locator(".who").innerText())),
        [alice.username, bob.username]);

  console.log("\nthey become friends");
  await a.click("a[href='#/friends']");
  await a.waitForSelector("text=Send a request");
  await a.fill("form input", bob.username);
  await a.click("button[type=submit]");

  await b.click("a[href='#/friends']");
  await b.waitForSelector("text=Waiting for you", { timeout: 20000 });
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
  await a.click("a[href='#/play']");
  await b.click("a[href='#/play']");
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
   * Wait until the two peers are observably on the same frame with the same
   * digest.
   *
   * Under rollback the newest frame or two on each side is a prediction, so
   * two peers compared at an arbitrary instant legitimately differ -- that is
   * the mechanism working. They converge as the truth arrives, so this waits
   * for agreement rather than asserting it now.
   */
  const agree = () => until(() => ({
    frame: window.__fbwg.view.session.frame,
    digest: window.__fbwg.view.digest(),
  }), (both) => both[0].frame === both[1].frame &&
                !!both[0].digest && both[0].digest === both[1].digest);

  /** Poll both pages with one evaluate each until they agree with `want`. */
  const until = async (read, want, tries = 60, gap = 150) => {
    let last = null;
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
    await a.click(".panel .row button:has-text('Invite')");
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
          await a.locator(".panel .row button:has-text('Invite')").isEnabled(),
          true);
  }

  console.log("\nand declined, which is an answer and not silence");
  {
    // "Not now" used to do nothing at all, so the only way to decline was to say
    // nothing -- which is also what somebody who has walked away from their desk
    // does. The inviter waited out two full minutes either way.
    await a.click(".panel .row button:has-text('Invite')");
    await a.waitForSelector(".banner select");
    await a.click(".banner button:has-text('Send invite')");
    await b.waitForSelector(".banner:has-text('wants to play')", { timeout: 30000 });

    await b.click(".banner button:has-text('Not now')");
    await a.waitForSelector(".banner:has-text('not now')", { timeout: 20000 });
    check("alice hears it, well inside the two minutes she used to wait",
          /not now/.test(await a.locator(".banner").innerText()), true);
    check("and bob's banner is gone", await b.locator(".banner").isHidden(), true);
    await a.click(".banner button:has-text('Cancel')");
  }

  console.log("\nalice invites bob, and assigns the roles");
  await a.click(".panel .row button:has-text('Invite')");
  await a.waitForSelector(".banner select");
  // Alice deliberately makes BOB Fireboy, so the test proves the assignment
  // travels rather than each peer picking for itself.
  await a.selectOption(".banner select >> nth=2", "them");
  await a.click(".banner button:has-text('Send invite')");

  await b.waitForSelector(".banner:has-text('wants to play')", { timeout: 30000 });
  const offer = await b.locator(".banner span").first().innerText();
  check("bob is told he would be Fireboy",
        /would be Fireboy/.test(offer), true);
  await b.click(".banner button:has-text('Play')");

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
  await a.waitForTimeout(3000);
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
  let agreed = null;
  for (let i = 0; i < 40; i++) {
    // Frame, digest AND positions read in ONE evaluate per page. Reading them
    // in separate calls would sample two moments: both pages keep ticking in
    // real time between one round trip and the next, so the positions would
    // come from a later frame than the digest that vouched for them.
    const [x, y] = await Promise.all([a, b].map((p) => p.evaluate(() => {
      const v = window.__fbwg.view;
      const lv = v.level;
      return {
        frame: v.session.frame,
        digest: v.digest(),
        fire: lv ? +lv.pers1.GetPosition().x.toFixed(3) : null,
        water: lv ? +lv.pers2.GetPosition().x.toFixed(3) : null,
      };
    })));
    if (x.frame === y.frame && x.digest && x.digest === y.digest) {
      agreed = [x, y];
      break;
    }
    await a.waitForTimeout(100);
  }
  check("the two peers agree on the simulation", agreed !== null, true);
  if (agreed) {
    const [x, y] = agreed;
    console.log(`  frame ${x.frame}, digest ${x.digest}`);
    check("and on where both characters are",
          [x.fire, x.water], [y.fire, y.water]);
    check("having actually moved apart", x.fire > 20 && x.water < 5, true);
  }

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
    await pressInGame(b, "m_mainMenu.b_1_1");
    await b.waitForSelector(".banner:has-text('to pick')", { timeout: 10000 });
    check("bob is told the pick is not his",
          await b.evaluate(() => window.__fbwg.view.session.running), false);

    // Alice did, so hers starts it for both.
    await pressInGame(a, "m_mainMenu.b_1_1");
    const started = await until(() => ({
      running: window.__fbwg.view.session.running,
      mode: window.__fbwg.view.level?.CurrentMode ?? null,
      num: window.__fbwg.view.level?.CurrentLevel ?? null,
      digest: window.__fbwg.view.digest(),
      frame: window.__fbwg.view.session.frame,
    }), (both) => both[0].running && both[1].running &&
                  both[0].frame === both[1].frame &&
                  !!both[0].digest && both[0].digest === both[1].digest);
    check("and alice's pick starts the same level on both", started !== null, true);
    if (started) {
      check("the level they both got",
            [started[0].mode, started[0].num, started[1].mode, started[1].num],
            ["adventure", 1, "adventure", 1]);
    }
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

    await b.evaluate(() => {
      // Private only to TypeScript. The peer connection is the thing there is
      // to break, and closing it is what a network going away does.
      const t = window.__fbwg.view.session.transport;
      if (!t.pc) throw new Error("not a peer connection -- nothing to break");
      t.pc.close();
    });

    // The restart is asserted INSIDE the wait, not after it. A level that has
    // begun again counts up from zero at twenty-six frames a second, so by the
    // time a poll happens to catch both peers agreeing it can already be past
    // where the old one was -- and then "did it start again" reads as no.
    const back = await until(() => ({
      running: window.__fbwg.view.session?.running ?? false,
      frame: window.__fbwg.view.session?.frame ?? -1,
    }), (both) => both[0].running && both[1].running &&
                  both[0].frame < before[0] && both[1].frame < before[1],
      200, 250);
    check("both are back in a level, and it started again", back !== null, true);
    if (back) console.log(`  restarted at frame ${back[0].frame}, ` +
                          `where they had reached ${before[0]}`);
    const together = await agree();
    check("and they are in step in it", together !== null, true);
    if (together) console.log(`  frame ${together[0].frame}, ` +
                              `digest ${together[0].digest}`);
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
    await until(() => window.__fbwg.view.session.running,
                (both) => !both[0] && !both[1]);

    check("only alice can offer to hand it over",
          await Promise.all([a, b].map((p) =>
            p.locator("header button:has-text('Let')").isVisible())),
          [true, false]);

    // Whether the message arrives at all is worth seeing on failure: a
    // handover that does not land looks exactly like a page that ignored one.
    await b.evaluate(() => {
      window.__handovers = [];
      window.__fbwg.lobby.onHandover((h) => window.__handovers.push(h));
    });

    await a.click("header button:has-text('Let')");
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
    await pressInGame(a, "m_mainMenu.b_1_1");
    await a.waitForSelector(".banner:has-text('to pick')", { timeout: 10000 });
    check("alice is now the one who cannot start it",
          await a.evaluate(() => window.__fbwg.view.session.running), false);

    await pressInGame(b, "m_mainMenu.b_1_1");
    const started = await until(() => ({
      running: window.__fbwg.view.session.running,
      digest: window.__fbwg.view.digest(),
      frame: window.__fbwg.view.session.frame,
    }), (both) => both[0].running && both[1].running &&
                  both[0].frame === both[1].frame &&
                  !!both[0].digest && both[0].digest === both[1].digest);
    check("and bob's pick starts it for both", started !== null, true);
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
  });
  await a.waitForTimeout(3000);
  const wrote = await a.evaluate(() => ({
    saves: window.__fbwg.progress.saves,
    error: window.__fbwg.progress.lastError,
  }));
  check("the write reached the database", [wrote.error, wrote.saves > 0],
        [null, true]);
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
    // their partner stops moving and never starts again.
    await b.click("a[href='#/friends']");
    await a.waitForSelector(".banner:has-text('left the game')", { timeout: 20000 });
    check("alice is told",
          /left the game/.test(await a.locator(".banner").innerText()), true);
    check("and is out of the session rather than stalled in it",
          await a.evaluate(() => window.__fbwg.view.session === null), true);
    check("so she can start another game",
          await a.locator(".panel .row button:has-text('Invite')").isEnabled(),
          true);
    await b.click("a[href='#/play']");
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
      await ctx.addInitScript(() => { delete window.RTCPeerConnection; });
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector("#stage", { timeout: 40000 });
    }
    for (const p of [a, b]) {
      await p.waitForSelector(".panel .row button:not([disabled])",
                              { timeout: 40000 });
    }

    await a.click(".panel .row button:has-text('Invite')");
    await a.waitForSelector(".banner select");
    await a.click(".banner button:has-text('Send invite')");
    await b.waitForSelector(".banner:has-text('wants to play')", { timeout: 40000 });
    await b.click(".banner button:has-text('Play')");

    for (const p of [a, b]) {
      await p.waitForFunction("window.__fbwg && window.__fbwg.view.session",
                              null, { timeout: 90000 });
    }
    const how = await Promise.all([a, b].map((p) => p.locator(".status").innerText()));
    check("both fell back to the relay",
          how.every((t) => /relay/.test(t)), true);

    await Promise.all([a, b].map((p) => p.waitForFunction(
      "window.__fbwg.view.level !== null", null, { timeout: 40000 })));
    await a.click("#stage");
    await a.keyboard.down("ArrowRight");
    await a.waitForTimeout(2500);
    await a.keyboard.up("ArrowRight");

    let relayed = null;
    for (let i = 0; i < 60; i++) {
      const [x, y] = await Promise.all([a, b].map((p) => p.evaluate(() => ({
        frame: window.__fbwg.view.session.frame,
        digest: window.__fbwg.view.digest(),
      }))));
      if (x.frame === y.frame && x.digest && x.digest === y.digest) { relayed = x; break; }
      await a.waitForTimeout(150);
    }
    check("and still simulate the same game over it", relayed !== null, true);
    if (relayed) console.log(`  frame ${relayed.frame}, digest ${relayed.digest}`);
    check("with no desyncs",
          await Promise.all([a, b].map((p) =>
            p.evaluate(() => window.__fbwg.view.session.desyncs))), [0, 0]);
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
  await admin("/rest/v1/invite_codes?note=eq.twopeople", { method: "DELETE" });
  console.log(`\ncleaned up ${users.length} test users`);
}

console.log("\n" + (failures === 0
  ? "TWO PEOPLE PASSED"
  : `TWO PEOPLE FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
