/**
 * Playing as a guest: `#/play` signed out, through the real app and router.
 *
 * A level played on one keyboard and saved under the guest key; every guest
 * panel opened (Friends, Leaderboard, Progress, Menu) and read; the two ways
 * to an account followed; `#/local` shown to be the same screen -- and not one
 * request or socket to the Supabase host throughout.
 *
 * Every request leaving the dev server's own host is aborted and written down,
 * so a lobby, a cloud save, a leaderboard query or a Realtime channel built by
 * mistake fails here rather than quietly costing a guest nothing visible.
 */
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";

const fixture = process.env.FBWG_TEST_URL || "http://127.0.0.1:5176/test/play-fixture.html";
const origin = new URL(fixture).origin;
// By host AND port: a local Supabase stack is 127.0.0.1 too, on its own port.
const local = new URL(origin).host;
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw new Error("The guest test must be local");

// Progress an earlier guest visit left behind: level 10 with a B.
const stats = new Array(32).fill(-1), times = new Array(32).fill(0), timesString = new Array(32).fill("");
stats[0] = 0; stats[9] = 2; times[9] = 55; timesString[9] = "00:55";
const SEEDED = JSON.stringify({ stats, times, timesString });
const SIZES = [[1024, 600], [1280, 720], [1366, 768], [1920, 1080]];

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
    await context.addInitScript(value => {
      try { if (!localStorage.getItem("FBCookie:guest")) localStorage.setItem("FBCookie:guest", value); } catch { /* about:blank */ }
    }, SEEDED);
    const page = await context.newPage();
    const sockets = [];
    page.on("websocket", ws => { if (new URL(ws.url()).host !== local) sockets.push(ws.url()); });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));

    const ready = () => page.waitForFunction(() => window.__fbwg?.view?.prepared && document.querySelector(".guest-chip"));
    await page.goto(origin + "/#/play");
    await ready();
    // The same module the app runs, so the same client and the same URL.
    const supabaseHost = new URL(await page.evaluate(async () => (await import("/src/supabase.ts")).supabase.supabaseUrl)).host;
    assert(supabaseHost && supabaseHost !== local, "the app names the Supabase host it would have used");
    const toSupabase = () => [...outside, ...sockets].filter(u => new URL(u).host === supabaseHost);
    assert.equal(await page.evaluate(() => location.hash), "#/play", "signed out, /play is not redirected");
    assert.equal(await page.evaluate(() => window.__fbwg.view.game.The_cookie.data.stats[9]), 2,
      "the game opens on the guest's existing save");

    // ---- the toolbar ---------------------------------------------------
    assert.equal(await page.locator(".guest-chip").innerText(), "Playing as a guest");
    assert.equal(await page.locator(".identity-detail .signin-link").getAttribute("href"), "#/login");
    assert.equal(await page.locator(".copy-name").count(), 0, "no username");
    for (const [tool, label] of [[".tool-friends", "Friends"], [".tool-leaderboard", "Leaderboard"]]) {
      const button = page.locator(`.play-toolbar ${tool}`);
      assert(await button.isVisible(), `${label} is still offered`);
      assert.equal(await button.getAttribute("data-locked"), "", `${label} is marked locked`);
      assert.equal(await page.getByRole("button", { name: new RegExp(`^${label}[ ,]+needs an account$`) }).count(), 1,
        `${label} says it needs an account to a screen reader`);
      const glyph = await button.evaluate(b => { const s = getComputedStyle(b, "::after"); return { content: s.content, width: s.width, mask: s.maskImage || s.webkitMaskImage || "" }; });
      assert(glyph.content !== "none" && glyph.width === "12px" && glyph.mask.includes("svg"), `${label} wears the lock glyph (${JSON.stringify(glyph)})`);
    }
    assert.equal(await page.locator(".tool-friends").evaluate(b => b.firstChild.textContent), "Friends", "and no friend count");

    // ---- wide: Friends opens on its own, as the pitch --------------------
    assert(await page.locator(".play-drawer").isVisible(), "a wide screen opens the Friends panel for a guest");
    assert.equal(await page.locator("#drawer-title").innerText(), "Play Together");
    assert.equal(await page.locator(".drawer-tabs [aria-current='true']").innerText(), "Friends");
    const card = page.locator(".online-card").first();
    assert.equal(await card.locator("h3").innerText(), "Play online");
    assert.equal(await card.locator("p").first().innerText(), "Your progress here stays on this device. A free account takes it everywhere.");
    assert.deepEqual(await card.locator("li").allInnerTexts(),
      ["Quick Match with someone new", "Invite friends and keep a shared save", "Post your times on the leaderboard"]);
    assert.equal(await card.getByRole("link", { name: "Create a free account" }).getAttribute("href"), "#/signup");
    assert.equal(await card.getByRole("link", { name: "Sign in" }).getAttribute("href"), "#/login");
    assert.equal(await card.locator(".pitch-fine").innerText(), "Accounts are for ages 13 and up. You keep this device's progress when you sign up.");
    assert.deepEqual(await page.locator(".local-keys .keyrow").allInnerTexts().then(t => t.map(s => s.replace(/\s+/g, " "))),
      ["Fireboy ← ↑ →", "Watergirl W A D"]);

    // ---- a level on one keyboard, panel docked beside it -----------------
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
    await page.waitForFunction(() => localStorage.getItem("fbwg.persistAsked") === "1");

    // ---- every panel ------------------------------------------------------
    await page.locator(".play-toolbar .tool-leaderboard").click();
    assert.equal(await page.locator("#drawer-title").innerText(), "The Fastest Pairs");
    const lock = page.locator(".board-lock");
    assert.equal(await lock.locator(".board-title").innerText(), "Two players. One great time.");
    assert.equal(await lock.locator("h3").innerText(), "See the fastest pairs");
    assert.equal(await lock.locator("h3 + p").innerText(), "The leaderboard is for players with an account, so names are only shown to other players.");
    assert.equal(await lock.locator(".ghost-rows").getAttribute("aria-hidden"), "true", "the placeholder rows are decoration");
    assert.equal(await lock.locator(".ghost-rows i").count(), 4);
    assert.equal(await lock.getByRole("link", { name: "Create a free account" }).getAttribute("href"), "#/signup");
    assert.equal(await lock.getByRole("link", { name: "Sign in" }).getAttribute("href"), "#/login");
    assert.equal(await page.locator(".leaderboard-table").count(), 0, "no board is built");

    await page.locator(".drawer-tabs [data-panel='progress']").click();
    assert.equal(await page.locator("#drawer-title").innerText(), "Progress");
    await page.locator(".drawer-content").getByText("Best Times").waitFor();
    assert(await page.locator(".drawer-content .row").filter({ hasText: "00:55" }).count() >= 1, "the guest's own map, earlier time and all");
    assert.match(await page.locator(".drawer-content .note").filter({ hasText: "of 32 finished" }).innerText(), /, on this device$/, "and it says where that map lives");

    await page.locator(".drawer-tabs [data-panel='friends']").click();
    assert.equal(await page.locator("#drawer-title").innerText(), "Play Together");

    await page.locator(".tool-menu").click();
    assert.equal(await page.locator("#drawer-title").innerText(), "Game Menu");
    assert.deepEqual(await page.locator(".menu-group h3").evaluateAll(h => h.filter(n => n.getClientRects().length).map(n => n.textContent)),
      ["At Your Fingertips", "About"], "only the groups a guest can use, and no empty heading");
    for (const label of ["Sign out", "Settings"]) assert.equal(await page.getByRole("button", { name: label, exact: true }).count(), 0, `no ${label}`);

    await page.locator(".save-status").click();
    assert.equal(await page.locator("#drawer-title").innerText(), "Progress");
    assert.equal(await page.locator(".save-status").innerText(), "Saved on this device");
    assert.equal(await page.locator(".save-status").getAttribute("data-state"), "local");

    // ---- four laptop sizes ----------------------------------------------
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await page.keyboard.press("Escape");
      await page.locator(".play-toolbar .tool-friends").click();
      await page.locator(".online-card h3").waitFor();
      await page.waitForFunction(() => {
        const r = document.querySelector("#stage").getBoundingClientRect();
        return r.width > 100 && r.bottom <= innerHeight && r.right <= innerWidth;
      });
      assert(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), `${name} ${width}: the page does not scroll`);
      const box = await page.locator("#stage").boundingBox();
      assert(Math.abs(box.width / box.height - 4 / 3) < 0.02, "the canvas keeps its aspect ratio");
      assert(await page.locator(".tool-leaderboard").isVisible() && await page.locator(".tool-menu").isVisible(), "every toolbar button fits");
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} ${width}: nothing overflows sideways`);
    }
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1366, height: 768 });

    // ---- reduced motion -------------------------------------------------
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator(".play-toolbar .tool-leaderboard").click();
    assert.equal(await page.locator(".drawer-content > *").first().evaluate(n => getComputedStyle(n).animationName), "none", "the panel arrives without motion");
    assert.equal(await page.locator(".board-lock .pitch-go").evaluate(n => getComputedStyle(n).transitionDuration), "0s", "and its buttons do not animate");
    await page.emulateMedia({ reducedMotion: "no-preference" });

    assert.deepEqual(toSupabase(), [], "no request or socket to the Supabase host from the guest screen");
    assert.deepEqual([...outside, ...sockets], [], "nor anywhere else off this host");

    // ---- the two ways to an account ---------------------------------------
    await page.locator(".board-lock").getByRole("link", { name: "Create a free account" }).click();
    await page.waitForFunction(() => location.hash === "#/signup");
    await page.getByText("To make an account, first tell us your date of birth.").waitFor();
    await page.goto(origin + "/#/play");
    await ready();
    await page.locator(".online-card").getByRole("link", { name: "Sign in" }).click();
    await page.waitForFunction(() => location.hash === "#/login");
    await page.locator("input[type=password]").waitFor();
    await page.goto(origin + "/#/play");
    await ready();
    await page.locator(".identity-detail .signin-link").click();
    await page.waitForFunction(() => location.hash === "#/login");
    await page.locator("input[type=password]").waitFor();

    // ---- the old address -------------------------------------------------
    await page.goto(origin + "/#/local");
    await ready();
    assert.equal(await page.evaluate(() => location.hash), "#/local", "#/local stays where it is");
    assert.equal(await page.locator("#drawer-title").innerText(), "Play Together", "and is the same guest screen");
    assert.equal(await page.evaluate(() => window.__fbwg.view.game.The_cookie.data.stats[0] >= 1), true, "with the same save");

    // Leaving runs pagehide, the last place a save would have been sent from.
    await page.goto("about:blank");
    await page.waitForTimeout(500);

    assert.deepEqual(errors, [], "no page errors");
    assert.deepEqual(toSupabase(), [], "no request or socket to the Supabase host");
    console.log(`PASS ${name} guest play at #/play and #/local: level, save, four panels, ${SIZES.length} sizes, reduced motion, sign-up and sign-in links; none to Supabase (the sign-in pages asked ${[...new Set(outside.map(u => new URL(u).host))].join(", ") || "nothing"} off-host)`);
  } finally { await browser.close(); }
}
