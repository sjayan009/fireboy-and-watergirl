import assert from "node:assert/strict";
import { chromium } from "playwright";
const target = process.env.FBWG_TEST_URL || "http://127.0.0.1:5174/test/play-fixture.html";
if (!["localhost","127.0.0.1"].includes(new URL(target).hostname)) throw new Error("Pair fixtures must stay local");
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport:{width:1024,height:600} });
  await context.route("**/*",r => new URL(r.request().url()).hostname === new URL(target).hostname ? r.continue() : r.abort());
  const left = await context.newPage(), right = await context.newPage();
  const errors=[];
  for (const page of [left,right]) page.on("pageerror",e=>errors.push(e.message));
  await Promise.all([left.goto(target+"?pair=left"),right.goto(target+"?pair=right")]);
  for (const page of [left,right]) {
    await page.waitForFunction(()=>window.__fbwg?.view?.prepared);
    await page.waitForFunction(()=>document.querySelector(".tool-friends")?.textContent === "Friends (1)");
  }
  await left.getByRole("button",{name:"Friends (1)",exact:true}).click();
  // "Invite <username>", not "Invite": the accessible name carries the row.
  await left.getByRole("button",{name:/^Invite \S/}).click();
  await right.locator("#stage").focus();
  await left.getByRole("button",{name:"Send invite",exact:true}).click();
  await right.getByRole("button",{name:"Accept",exact:true}).waitFor();
  assert(await right.locator("#stage").evaluate(e=>e===document.activeElement),"incoming invitation never steals focus");
  assert(await right.locator(".play-drawer").isHidden(),"incoming invitation does not open a panel");
  await left.getByRole("button",{name:"Cancel",exact:true}).click();
  await right.getByRole("button",{name:"Accept",exact:true}).waitFor({state:"hidden"});
  assert(await right.evaluate(()=>!window.__fbwg.view.session),"canceled invitation does not start a game");
  await left.getByRole("button",{name:/^Invite \S/}).click();
  await left.getByRole("button",{name:"Send invite",exact:true}).click();
  try { await right.getByRole("button",{name:"Accept",exact:true}).click(); }
  catch (error) {
    console.error("Local fixture left:",await left.locator("body").innerText());
    console.error("Local fixture right:",await right.locator("body").innerText());
    console.error("Browser errors:",errors);
    throw error;
  }
  for (const page of [left,right]) await page.waitForFunction(()=>window.__fbwg.view.session?.frame > 30,{},{timeout:30000});
  for (const page of [left,right]) {
    assert(await page.locator(".play-drawer").isHidden(),"ready peers collapse the setup drawer");
    assert(await page.evaluate(()=>document.documentElement.scrollHeight <= innerHeight+1));
  }
  /*
   * The link, measured rather than assumed.
   *
   * Two peers on two machines do not advance time together, and until this
   * release nothing reconciled that: the session computed how far ahead the
   * peer was, put it in a field called `lead`, and no line of code read it. The
   * peer whose clock wandered ahead was the one that hit the edge of the
   * rollback window and sat there saying "waiting for your friend", while the
   * other side saw a perfectly healthy game.
   *
   * These are the numbers that were not there. They ride the input packets --
   * no extra messages, which on the relay is the only reason it is affordable
   * -- so this asserts the real browser path, over the real batched transport,
   * and not just the netcode harness.
   */
  for (const page of [left,right]) {
    await page.waitForFunction(()=>window.__fbwg.view.session?.rttMs !== null,{},{timeout:20000});
    const link = await page.evaluate(()=>{
      const s = window.__fbwg.view.session;
      return { rtt: s.rttMs, jitter: s.jitterMs, advantage: s.advantage,
               dilation: s.dilation, age: s.inputAgeMs, window: s.windowMs,
               delay: s.inputDelay, pressure: s.pressure };
    });
    assert(link.rtt >= 0 && link.rtt < 5000, `a round trip was measured: ${link.rtt}`);
    // Thirty frames at 26 Hz. It was fourteen, and the redundancy that caps it
    // was sixteen -- a ratio of 1.14 where GGPO runs eight.
    assert(Math.round(link.window) === 1154, `the window is thirty frames: ${link.window}`);
    // Two tabs on one machine share a clock, so there is nothing to correct.
    assert(link.dilation === 1, `a pair on one clock is not dilated: ${link.dilation}`);
    assert(link.delay === 0, `and is given no input delay: ${link.delay}`);
    assert(link.pressure < 1, `with the window comfortably covering it: ${link.pressure}`);
  }
  // And the development readout that reports all of it, which is what gets read
  // while actually playing.
  // Waited for rather than sampled: the readout is deliberately rate-limited to
  // once a second, because `sent` changes constantly and is not in the engine's
  // state key -- without the limit the counter alone would rewrite the status
  // line on every state change, which is the layout thrash this screen spent a
  // release removing.
  await left.waitForFunction(
    () => /rtt/.test(document.querySelector(".status").textContent),
    {}, { timeout: 15000 });
  const readout = await left.locator(".status").innerText();
  assert(/rtt/.test(readout), `the readout names the round trip: ${readout}`);
  assert(/adv /.test(readout), `and the frame advantage: ${readout}`);
  assert(/age \d+\/\d+ms/.test(readout), `and the input age against the window: ${readout}`);

  const serial = await left.evaluate(()=>window.__fbwg.view.session.runSerial);
  await left.getByRole("button",{name:"Friends (1)",exact:true}).click();
  assert.equal(await left.evaluate(()=>window.__fbwg.view.session.runSerial),serial,"a social panel preserves the running session");
  await left.keyboard.press("Escape");
  await left.setViewportSize({width:1366,height:768});
  await left.getByRole("button",{name:"Friends (1)",exact:true}).click();
  await left.locator("#stage").focus();
  await left.keyboard.down("ArrowRight");
  assert(await left.evaluate(()=>window.__fbwg.view.held.has("ArrowRight")),"a docked panel permits live character input");
  await left.getByLabel("Their username",{exact:true}).fill("Friend");
  assert.equal(await left.evaluate(()=>window.__fbwg.view.held.size),0,"editing a friend form releases movement");
  await left.keyboard.up("ArrowRight");
  await left.keyboard.press("Escape");
  await left.getByRole("button",{name:"Mute",exact:true}).click();
  await left.keyboard.down("ArrowRight");
  assert(await left.evaluate(()=>window.__fbwg.view.held.has("ArrowRight")),"muting does not require another click to keep playing");
  await left.keyboard.up("ArrowRight");
  /*
   * A match points the Progress picker at the pair, without renaming the tab.
   *
   * Read off the select rather than off the label: the tab is called Progress
   * either way, on purpose, and what actually changed is which map is on show.
   * Ready peers collapse the drawer -- the assertion three lines above is the
   * one that checks it -- so this reads the detached control directly rather
   * than through a locator that insists on visibility.
   */
  for (const page of [left,right]) {
    // The tab strip is always in the document; the PANEL is only in it while it
    // is the one showing, so the picker has to be opened to be read.
    assert.equal(await page.locator(".drawer-tabs button[data-panel='progress']").textContent(),"Progress",
      "the tab keeps its name, so it stays where you last found it");
    await page.locator(".tool-leaderboard").click();
    await page.locator(".drawer-tabs button[data-panel='progress']").click();
    const whose = page.getByLabel("Whose progress",{exact:true});
    assert.notEqual(await whose.inputValue(),"","a match points the picker at the pair's map");
    assert.match(await whose.locator("option:checked").innerText(),/^With /);
    assert.equal(await page.locator("#drawer-title").innerText(),"Progress");
    await page.keyboard.press("Escape");
    await page.locator(".play-drawer").waitFor({state:"hidden"});
  }
  await left.locator("#stage").focus();

  // Real shared Quit followed by the chooser's next Start.
  await left.evaluate(()=>window.__fbwg.view.session.send(4,window.__fbwg.view.slot));
  for (const page of [left,right]) await page.waitForFunction(()=>!window.__fbwg.view.session.running);

  /*
   * The banner the other person could not get rid of.
   *
   * `left` went back to the map, so `right` is told -- and that message used to
   * be a string whose only way off the screen was the Dismiss button. It sat
   * there through the whole of the next level, so somebody who had already
   * chosen one was reading "they went back to the map" over the top of the
   * level they were playing, and the person who chose it saw nothing at all and
   * had no idea it was happening.
   *
   * A level running is proof the gap between levels is over. Asserted from both
   * ends, because the bug was only ever visible from one of them.
   */
  await right.locator(".banner").waitFor();
  assert.match(await right.locator(".banner").innerText(),/went back to the map/);
  await left.evaluate(()=>window.__fbwg.view.session.requestStart("puzzle",2));
  for (const page of [left,right]) {
    await page.waitForFunction(()=>window.__fbwg.view.session.selection.mode === "puzzle" && window.__fbwg.view.session.frame > 30);
    assert.equal(await page.evaluate(()=>window.__fbwg.view.session.selection.num),2);
  }
  for (const page of [left,right]) {
    await page.locator(".banner").waitFor({state:"hidden"});
    assert(await page.locator(".banner").isHidden(),
      "a level starting takes down the messages about there not being one, on both sides");
  }
  assert.equal(await right.getByRole("button",{name:"Dismiss",exact:true}).count(),0,
    "and nobody had to press Dismiss to get their screen back");
  // The opposite peer cannot override the current chooser's level.
  await right.evaluate(()=>window.__fbwg.view.session.send(4,window.__fbwg.view.slot));
  for (const page of [left,right]) await page.waitForFunction(()=>!window.__fbwg.view.session.running);
  assert.deepEqual(errors,[]);
  console.log("PASS two local players: forced relay, invite/accept, ready focus, panel lifetime, quit, self-clearing notices and new level");
} finally { await browser.close(); }
