import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import { mkdirSync } from "node:fs";

const target = process.env.FBWG_TEST_URL || "http://127.0.0.1:5174/test/play-fixture.html";
if (!["localhost","127.0.0.1"].includes(new URL(target).hostname)) throw new Error("The isolated fixture must be local");
mkdirSync(".cache/play-evidence",{ recursive:true });
for (const [name,engine] of Object.entries({ chromium,firefox,webkit })) {
  const browser = await engine.launch(); // Missing browsers fail the release gate.
  try {
    const context = await browser.newContext();
    await context.route("**/*",route => new URL(route.request().url()).hostname === new URL(target).hostname ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror",e => errors.push(e.message));
    await page.goto(target);
    await page.waitForFunction(() => window.__fbwg?.view?.sprites && window.__fbwg.view.prepared);
    await page.waitForFunction(() => document.querySelector(".play-toolbar button")?.textContent === "Friends (50)");
    await page.evaluate(() => { window.originalView = window.__fbwg.view; });
    for (const [width,height] of [[1024,600],[1280,720],[1366,768],[1920,1080]]) {
      await page.setViewportSize({ width,height });
      const fit = async () => {
        await page.waitForFunction(() => {
          const r = document.querySelector("#stage").getBoundingClientRect();
          return r.width > 100 && r.bottom <= innerHeight && r.right <= innerWidth;
        });
        assert(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1),`${name} ${width} page must not scroll`);
        const box = await page.locator("#stage").boundingBox();
        assert(Math.abs(box.width / box.height - 4 / 3) < 0.02,"canvas keeps its aspect ratio");
      };
      await fit();
      await page.getByRole("button",{ name:"Friends (50)",exact:true }).click();
      await fit();
      await page.getByRole("button",{ name:"Invite",exact:true }).first().click();
      await page.getByLabel("Game mode",{ exact:true }).selectOption("puzzle");
      await page.getByLabel("Level",{ exact:true }).selectOption("2");
      await page.getByLabel("Characters",{ exact:true }).selectOption("them");
      await fit();
      await page.screenshot({ path:`.cache/play-evidence/${name}-${width}.png` });
      await page.getByRole("button",{ name:"Cancel",exact:true }).click();
      await page.keyboard.press("Escape");
      assert(await page.locator(".play-drawer").isHidden());
    }
    await page.locator("#stage").focus();
    await page.keyboard.down("ArrowRight");
    await page.getByRole("button",{ name:"Friends (50)",exact:true }).click();
    assert.equal(await page.evaluate(() => window.__fbwg.view.held.size),0,"opening a panel releases held input");
    await page.keyboard.up("ArrowRight");
    await page.keyboard.press("Escape");
    await page.getByRole("button",{ name:"Menu",exact:true }).click();
    await page.getByRole("button",{ name:"Settings",exact:true }).click();
    assert(await page.evaluate(() => window.originalView === window.__fbwg.view),"settings preserves the game instance");
    await page.keyboard.press("Escape");
    await page.locator("#stage").focus();
    assert.equal(await page.locator(".screen").evaluate(e => getComputedStyle(e).outlineStyle),"none");
    // Real IndexedDB: a late acknowledgement cannot delete a newer result.
    const durable = await page.evaluate(async () => {
      const outbox = await import("/src/outbox.ts");
      const owner="fixture-owner", peer="fixture-peer";
      const first={stats:Array(32).fill(0),times:Array(32).fill(0),timesString:Array(32).fill("")};
      first.stats[0]=1; first.times[0]=60;
      const old=await outbox.remember(owner,peer,first);
      first.stats[0]=3; first.times[0]=50;
      const fresh=await outbox.remember(owner,peer,first);
      await outbox.acknowledge(old);
      const remaining=await outbox.pendingFor(owner);
      const foreign=await outbox.pendingFor("another-owner");
      await outbox.acknowledge(fresh);
      return {count:remaining.length,medal:remaining[0].stats[0],time:remaining[0].times[0],foreign:foreign.length,final:(await outbox.pendingFor(owner)).length};
    });
    assert.deepEqual(durable,{count:1,medal:3,time:50,foreign:0,final:0});
    // Web Locks enforce ownership across tabs; a takeover releases the old lease.
    const other=await context.newPage();
    await other.goto(target);
    await other.waitForFunction(() => !!window.__fbwg);
    await page.evaluate(async () => { const {MatchLease}=await import("/src/matchlease.ts"); window.leaseTest=new MatchLease("fixture-exclusive",()=>{},()=>{window.wasTaken=true;}); window.acquired=await window.leaseTest.acquire(); });
    assert(await page.evaluate(() => window.acquired));
    await other.evaluate(async () => { const {MatchLease}=await import("/src/matchlease.ts"); window.leaseTest=new MatchLease("fixture-exclusive",()=>{},()=>{}); });
    assert.equal(await other.evaluate(() => window.leaseTest.acquire()),false);
    assert.equal(await other.evaluate(() => window.leaseTest.takeover()),true);
    assert.equal(await page.evaluate(() => window.wasTaken),true);
    await other.evaluate(() => window.leaseTest.close());
    await page.evaluate(() => window.leaseTest.close());
    assert.deepEqual(errors,[]);
    console.log(`PASS ${name}: four laptop sizes, invitation setup, panel lifetime, keyboard input, transactional saves, cross-tab takeover`);
  } finally { await browser.close(); }
}
