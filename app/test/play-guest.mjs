/**
 * The play screen in guest mode: a level played on one keyboard, saved under
 * the guest key, and not one request to the Supabase host.
 *
 * Every request leaving the fixture's own host is aborted and written down, and
 * so is every WebSocket, so a lobby, a cloud save or a Realtime channel built
 * by mistake fails here rather than quietly costing a guest nothing visible.
 */
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const fixture = process.env.FBWG_TEST_URL || "http://127.0.0.1:5176/test/play-fixture.html";
const target = new URL("guest-fixture.html", fixture).href;
// By host AND port: a local Supabase stack is 127.0.0.1 too, on its own port.
const local = new URL(target).host;
if (!["localhost", "127.0.0.1"].includes(new URL(target).hostname)) throw new Error("The guest fixture must be local");

// Progress an earlier visit to the guest page left behind: level 10 with a B.
const stats = new Array(32).fill(-1), times = new Array(32).fill(0), timesString = new Array(32).fill("");
stats[0] = 0; stats[9] = 2; times[9] = 55; timesString[9] = "00:55";
const SEEDED = JSON.stringify({ stats, times, timesString });

for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const outside = [];
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.host === local) return route.continue();
      outside.push(url.href);
      return route.abort();
    });
    await context.addInitScript(value => { try { localStorage.setItem("FBCookie:guest", value); } catch { /* about:blank */ } }, SEEDED);
    const page = await context.newPage();
    const sockets = [];
    page.on("websocket", ws => { if (new URL(ws.url()).host !== local) sockets.push(ws.url()); });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));

    await page.goto(target);
    await page.waitForFunction(() => window.__fbwg?.view?.prepared);
    const supabaseHost = new URL(await page.evaluate(() => window.fixtureSupabaseUrl)).host;
    assert(supabaseHost, "the fixture names the Supabase host it would have used");

    assert.equal(await page.evaluate(() => window.__fbwg.view.game.The_cookie.data.stats[9]), 2,
      "the game opens on the guest's existing save");
    for (const tool of [".tool-friends", ".tool-leaderboard", ".copy-name"]) {
      assert(await page.locator(tool).isHidden(), `${tool} is not offered without an account`);
    }
    assert.equal(await page.getByRole("button", { name: "Sign out" }).count(), 0, "nor is signing out");
    assert(await page.locator(".play-drawer").isHidden(), "and no panel opens on its own");

    // Intro, then node 1 on the map: the same two presses a player makes.
    await page.evaluate(() => {
      const v = window.__fbwg.view;
      v.shell.pointerDown(v.game.m_introMenu.Buttons.Starter); v.shell.pointerUp();
    });
    await page.waitForFunction(() => window.__fbwg.view.game.m_mainMenu?.b_1_1);
    await page.evaluate(() => {
      const v = window.__fbwg.view;
      v.shell.pointerDown(v.game.m_mainMenu.b_1_1); v.shell.pointerUp();
    });
    await page.waitForFunction(() => window.__fbwg.view.level?.pers1 && window.__fbwg.view.level?.pers2);
    assert.equal(await page.evaluate(() => window.__fbwg.view.session), null, "played locally, with no session");

    // Two players, one keyboard: arrows move Fireboy and W A D move Watergirl.
    const at = () => page.evaluate(() => {
      const lv = window.__fbwg.view.level;
      return [lv.pers1.GetPosition().x, lv.pers2.GetPosition().x];
    });
    await page.locator("#stage").focus();
    const [fire, water] = await at();
    await page.keyboard.down("ArrowRight");
    await page.keyboard.down("KeyD");
    await page.waitForTimeout(1500);
    await page.keyboard.up("ArrowRight");
    await page.keyboard.up("KeyD");
    const [fire2, water2] = await at();
    assert(fire2 > fire + 0.5, `Fireboy moved right on the arrow key (${fire} -> ${fire2})`);
    assert(water2 > water + 0.5, `Watergirl moved right on D (${water} -> ${water2})`);

    // Both on their doors until the level is won, as engine/src/shelltest.ts does it.
    // Not before three seconds of level time: `mergeProgress` drops a faster
    // time as implausible, and the time is one of the things checked below.
    await page.waitForTimeout(3000);
    const saved = await page.evaluate(() => new Promise(resolve => {
      const until = performance.now() + 30000;
      const tick = () => {
        const cl = window.__fbwg.view.game.m_level?.myContactListener;
        if (cl) { cl.finish1 = 1; cl.finish2 = 1; }
        const now = JSON.parse(localStorage.getItem("FBCookie:guest") ?? "null");
        if (now?.stats?.[0] >= 1 || performance.now() > until) resolve(now); else requestAnimationFrame(tick);
      };
      tick();
    }));
    assert(saved.stats[0] >= 1, `the medal is written to FBCookie:guest (${saved.stats[0]})`);
    assert.equal(saved.stats[1], 0, "and the next node is opened");
    assert.match(saved.timesString[0], /^\d\d:\d\d$/, "with a time");
    assert.deepEqual([saved.stats[9], saved.timesString[9]], [2, "00:55"], "and the earlier progress is kept");
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("FBCookie") && k !== "FBCookie:guest")), [],
      "no other save key is written");

    await page.locator(".save-status").click();
    assert.equal(await page.locator(".save-status").innerText(), "Saved on device");
    await page.locator(".progress-results").getByText("Best Times").waitFor();

    // Leaving runs pagehide, the last place a save would have been sent from.
    await page.goto("about:blank");
    await page.waitForTimeout(500);

    assert.deepEqual(errors, [], "no page errors");
    assert.deepEqual(outside.filter(u => new URL(u).host === supabaseHost), [], "no request to the Supabase host");
    assert.deepEqual(sockets.filter(u => new URL(u).host === supabaseHost), [], "no socket to the Supabase host");
    console.log(`PASS ${name} guest play: local level, guest save, ${outside.length} outside requests, none to Supabase`);
  } finally { await browser.close(); }
}
