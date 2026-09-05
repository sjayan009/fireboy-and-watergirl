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
    await page.waitForFunction(()=>document.querySelector(".play-toolbar button")?.textContent === "Friends (1)");
  }
  await left.getByRole("button",{name:"Friends (1)",exact:true}).click();
  // "Invite <username>", not "Invite": the accessible name carries the row.
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
  const serial = await left.evaluate(()=>window.__fbwg.view.session.runSerial);
  await left.getByRole("button",{name:"Friends (1)",exact:true}).click();
  assert.equal(await left.evaluate(()=>window.__fbwg.view.session.runSerial),serial,"a social panel preserves the running session");
  await left.keyboard.press("Escape");
  // Real shared Quit followed by the chooser's next Start.
  await left.evaluate(()=>window.__fbwg.view.session.send(4,window.__fbwg.view.slot));
  for (const page of [left,right]) await page.waitForFunction(()=>!window.__fbwg.view.session.running);
  await left.evaluate(()=>window.__fbwg.view.session.requestStart("puzzle",2));
  for (const page of [left,right]) {
    await page.waitForFunction(()=>window.__fbwg.view.session.selection.mode === "puzzle" && window.__fbwg.view.session.frame > 30);
    assert.equal(await page.evaluate(()=>window.__fbwg.view.session.selection.num),2);
  }
  // The opposite peer cannot override the current chooser's level.
  await right.evaluate(()=>window.__fbwg.view.session.send(4,window.__fbwg.view.slot));
  for (const page of [left,right]) await page.waitForFunction(()=>!window.__fbwg.view.session.running);
  assert.deepEqual(errors,[]);
  console.log("PASS two local players: forced relay, invite/accept, ready focus, panel lifetime, quit and new level");
} finally { await browser.close(); }
