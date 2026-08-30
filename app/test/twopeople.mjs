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
