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
    await page.waitForFunction(() => document.querySelector(".tool-friends")?.textContent === "Friends (50)");
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
      if (await page.locator(".play-drawer").isHidden()) await page.getByRole("button",{ name:"Friends (50)",exact:true }).click();
      await fit();
      // By the accessible name, which names the FRIEND: fifty buttons reading
      // "Invite" told a screen reader nothing about which row it was on, so
      // each one is now "Invite <username>". Matching the prefix rather than
      // the whole string is what keeps this test from caring who is first.
      await page.getByRole("button",{ name:/^Invite \S/ }).first().click();
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

    /*
     * Fifty rows, fifty distinct names, and one tab that says it is current.
     *
     * Both of these were the same bug in two places: the list said which
     * friend a row was about in a span nothing associated with the button, and
     * the tab strip said which panel was open in no way at all. Somebody
     * reading the page through its accessibility tree got "Invite" fifty times
     * and three identical tabs.
     */
    const names = await page.getByRole("button",{ name:/^Invite \S/ })
      .evaluateAll(list => list.map(b => b.getAttribute("aria-label")));
    assert.equal(names.length,50,"every friend row offers an invitation");
    assert.equal(new Set(names).size,50,"and each one names the friend it invites");
    assert.equal(
      await page.locator(".drawer-tabs button[aria-current='true']").innerText(),
      "Friends","the open panel's tab is the one marked current");

    await page.keyboard.up("ArrowRight");
    await page.keyboard.press("Escape");

    /*
     * The button that opened the drawer closes it again.
     *
     * Both of these used to only ever open: pressing Friends while the friends
     * panel was showing re-rendered it and left it there, so Close or Escape
     * were the only ways out. Pressing one toolbar button while the OTHER's
     * panel is open still switches rather than closing -- that is a different
     * gesture and it has to stay one.
     */
    const drawer = page.locator(".play-drawer");
    const friendsButton = page.getByRole("button",{ name:"Friends (50)",exact:true });
    const menuButton = page.getByRole("button",{ name:"Menu",exact:true });
    await friendsButton.click();
    assert(await drawer.isVisible(),"Friends opens the drawer");
    await friendsButton.click();
    assert(await drawer.isHidden(),"and Friends again closes it");
    await menuButton.click();
    assert.equal(await page.locator("#drawer-title").innerText(),"Game Menu");
    await friendsButton.click();
    assert(await drawer.isVisible() &&
      await page.locator("#drawer-title").innerText() === "Play Together",
      "the other button switches panels rather than closing");
    // `aria-expanded` belongs to the control, not to the drawer: only the
    // button whose panel is showing may claim it.
    assert.equal(await friendsButton.getAttribute("aria-expanded"),"true");
    assert.equal(await menuButton.getAttribute("aria-expanded"),"false");
    await friendsButton.click();
    assert(await drawer.isHidden());
    assert.equal(await friendsButton.getAttribute("aria-expanded"),"false");
    // Focus must never be left on a control inside the hidden drawer.
    assert(await page.evaluate(
      () => !document.querySelector(".play-drawer").contains(document.activeElement)),
      "closing does not strand focus inside the drawer");

    /*
     * And the footer's save indicator, which is the third control pointing at
     * the drawer: it opens Progress, so it closes Progress. Not a tab -- the
     * tab strip switches between panels and deliberately does not toggle.
     */
    const saved = page.locator(".save-status");
    await saved.click();

    /*
     * The panel is called Progress, and stays called Progress.
     *
     * It briefly renamed itself to match whichever map was on show, which
     * fought the thing a tab is for -- you find it again by it being in the
     * same place with the same name. The picker one line below the heading
     * already says which map it is.
     */
    assert.equal(await page.locator("#drawer-title").innerText(),"Progress");
    assert.equal(await page.locator(".drawer-tabs button[data-panel='progress']").innerText(),"Progress");

    /*
     * And the picker that chooses which map is on show -- which is also the
     * only place the app answers "am I playing locally or online". There is no
     * mode screen and deliberately never was one: the app already knows, and
     * asking a question you can answer yourself is a step in the way of
     * playing.
     *
     * "On This Device", not "Just me". The subject is a SAVE, and this game has
     * never had a one-person mode -- somebody playing "alone" is driving both
     * characters, or sharing a keyboard with whoever is next to them. What
     * distinguishes this option is where the progress lives.
     */
    const whose = page.getByLabel("Whose progress",{ exact:true });
    assert.equal(await whose.inputValue(),"","alone, the panel starts on this account's own map");
    const options = await whose.locator("option").allInnerTexts();
    assert.equal(options[0],"On This Device");
    assert(!/just me/i.test(options.join(" ")),
      `the local save is not "just me" -- two characters are always playing: ${JSON.stringify(options)}`);
    assert(options.length > 1,`the picker should offer the friends there are: ${JSON.stringify(options)}`);
    assert(options.slice(1).every(o => o.startsWith("With ")),
      `every other option names a friend: ${JSON.stringify(options)}`);

    /*
     * What the panel CLAIMS about where progress lives.
     *
     * This is here because the claim went stale and nothing noticed. Solo
     * progress moved out of one browser-wide localStorage key and into
     * `solo_progress`, keyed to the account -- and the line under Best Times
     * went on saying "on this browser" for a release afterwards, telling people
     * their own account's progress belonged to the machine they were sitting
     * at. Every test passed the whole time, because none of them read the
     * sentence.
     *
     * It is one string and it is the only place the app explains this to
     * anybody, so it is worth an assertion of its own.
     */
    const summary = await page.locator(".drawer-content .note").filter({ hasText: "of 32 finished" }).innerText();
    assert(/of 32 finished/.test(summary), `progress summary missing: ${summary}`);
    assert(!/this browser|this device/i.test(summary),
      `the progress panel still claims progress is browser-local: ${summary}`);
    assert(/on your account|together/.test(summary),
      `the progress panel should say whose progress it is: ${summary}`);
    /*
     * Ask for a friend's shared map, and the label stops saying "Local".
     *
     * Reading one must never adopt it: `adopt` swaps the store the running
     * engine writes through, and looking at what you and somebody else managed
     * on Puzzle 3 is not a reason to change what the game is saving into.
     */
    const before = await page.evaluate(() => window.__fbwg.view.game.The_cookie.data.stats.join(","));
    await whose.selectOption({ index: 1 });
    await page.locator(".drawer-content .note").filter({ hasText: "together with" }).waitFor();
    const shared = await page.locator(".drawer-content .note").filter({ hasText: "of 32 finished" }).innerText();
    assert(/together with /.test(shared),`a shared map says whose it is: ${shared}`);
    assert.equal(await page.evaluate(() => window.__fbwg.view.game.The_cookie.data.stats.join(",")),before,
      "reading a friend's progress never touches the save the game is writing through");
    assert.equal(await page.locator("#drawer-title").innerText(),"Progress","the heading does not follow the subject");
    await whose.selectOption({ index: 0 });
    await page.locator(".drawer-content .note").filter({ hasText: "on your account" }).waitFor();

    assert.equal(await saved.getAttribute("aria-expanded"),"true");
    await saved.click();
    assert(await drawer.isHidden(),"the save indicator closes the panel it opened");
    assert.equal(await saved.getAttribute("aria-expanded"),"false");

    await menuButton.click();
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
      await outbox.deliveryFailed(old,"late refusal",true,0);
      const remaining=await outbox.pendingFor(owner);
      const foreign=await outbox.pendingFor("another-owner");
      assertMetadata(remaining[0]);
      function assertMetadata(record) { if (record.quarantine || record.error) throw new Error("Late failure quarantined a newer earned result"); }
      await outbox.deliveryFailed(fresh,"HTTP 403",true,0);
      const refused=(await outbox.pendingFor(owner))[0];
      await outbox.retryDelivery(owner,peer);
      const retry=(await outbox.pendingFor(owner))[0];
      await outbox.acknowledge(fresh);
      return {count:remaining.length,medal:remaining[0].stats[0],time:remaining[0].times[0],foreign:foreign.length,
        quarantined:refused.quarantine,error:refused.error,retry:!retry.quarantine&&!retry.error&&retry.revision===fresh.revision,
        final:(await outbox.pendingFor(owner)).length};
    });
    assert.deepEqual(durable,{count:1,medal:3,time:50,foreign:0,quarantined:true,error:"HTTP 403",retry:true,final:0});
    // The actual panel exposes retained refusals, a scoped retry, and a data-only export.
    await page.evaluate(async () => {
      const outbox=await import("/src/outbox.ts"), {ProgressPanel}=await import("/src/ui/progress.ts");
      const data={stats:Array(32).fill(0),times:Array(32).fill(0),timesString:Array(32).fill("")};
      data.stats[0]=3; data.times[0]=50;
      const record=await outbox.remember("fixture-owner","fixture-peer",data);
      await outbox.deliveryFailed(record,"HTTP 403",true,0);
      const host=document.createElement("section"); host.id="delivery-test"; document.body.append(host);
      window.deliveryTest=new ProgressPanel(host,{progress:{own:data,shared:false,
        pendingResults:()=>outbox.pendingFor("fixture-owner"),retryPending:()=>outbox.retryDelivery("fixture-owner","fixture-peer")},
        solo:{pending:false},friends:()=>[{id:"fixture-peer",username:"FixtureFriend",status:"accepted"}],partner:()=>null,table:()=>Array(32).fill("1_1")});
      window.deliveryTest.open();
      const create=URL.createObjectURL, anchorClick=HTMLAnchorElement.prototype.click;
      URL.createObjectURL=blob=>{window.exportData=blob.text();return create(blob);};
      HTMLAnchorElement.prototype.click=function(){window.exportName=this.download;};
      window.restoreExport=()=>{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=anchorClick;};
    });
    const delivery=page.locator("#delivery-test");
    await delivery.getByText(/the cloud refused this save/).waitFor();
    await delivery.getByRole("button",{name:"Download unsent results"}).click();
    const exported=await page.evaluate(async()=>({name:window.exportName,data:JSON.parse(await window.exportData)}));
    assert.equal(exported.name,"unsent-game-results.json");
    assert.equal(exported.data.schema,1);
    assert.equal(exported.data.results[0].stats[0],3);
    assert(!/access_token|authorization|password/i.test(JSON.stringify(exported)),"export contains only retained results");
    await page.evaluate(()=>window.restoreExport());
    await delivery.getByRole("button",{name:"Retry saving with FixtureFriend"}).click();
    await delivery.getByText(/waiting for cloud confirmation/).waitFor();
    await page.evaluate(async()=>{
      window.deliveryTest.destroy();document.querySelector("#delivery-test").remove();
      const outbox=await import("/src/outbox.ts");await outbox.acknowledge((await outbox.pendingFor("fixture-owner"))[0]);
    });
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
