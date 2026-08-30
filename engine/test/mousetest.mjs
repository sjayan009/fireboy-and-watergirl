/**
 * The mouse, driven for real.
 *
 * `shelltest` proves the shell responds when a MouseEvent is dispatched at a
 * button. That is only half the story: the other half is whether a pointer at
 * a given pixel finds the right button, and nothing about that is checkable
 * without a browser. The hit boxes come from the SWF's DefineButton2 *hit*
 * state through a transform walk that has to stay in step with the drawing
 * walk, and if the two drift, a button draws in one place and is clickable in
 * another -- exactly the kind of thing that looks fine in a screenshot.
 *
 * So this uses Playwright's real mouse: it asks the page where a control is on
 * the stage, converts that to a page coordinate, and clicks it.
 *
 * Covers what was asked for by name: Play, choosing a level, Retry Level, and
 * Main Menu.
 */
import { loadPlaywright, startServer } from "./harness.mjs";

const PORT = 5198;
const URL_ = `http://localhost:${PORT}/`;

const playwright = await loadPlaywright();
if (!playwright) process.exit(0);

const server = await startServer(PORT);

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` +
              (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

let browser;
try {
  browser = await playwright.chromium.launch();
} catch {
  console.log("chromium not installed -- skipping");
  server.kill();
  process.exit(0);
}

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on("pageerror", (e) => {
    failures++;
    console.log("  FAIL page error: " + e.message);
  });
  await page.goto(URL_, { waitUntil: "load" });

  // wait for the manifests, then for every image the first screen wants
  await page.waitForFunction("window.__debug && window.__debug.sprites",
                             null, { timeout: 30000 });

  /** Advance the simulation and draw, then let pending images arrive. */
  const settle = async (steps = 20) => {
    await page.evaluate(async (n) => {
      const D = window.__debug;
      D.step(n);
      for (let i = 0; i < 60; i++) {
        D.render();
        if (!D.sprites.loading) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      D.render();
    }, steps);
  };

  /**
   * Where a named control is, in page coordinates.
   *
   * The point is clamped into the stage, because a control can hang off the
   * edge and still be perfectly usable: the pause tray's pull tab sits at
   * y = 480 with half of it below the stage, and a player clicks the half they
   * can see. Takes the last match in draw order, which is the topmost -- the
   * results and game-over boards both have a button called ToMenuBtn.
   */
  const locate = (name) => page.evaluate((n) => {
    const hit = window.__debug.sprites.buttonBoxes(window.game)
      .filter((h) => h.node.name === n);
    if (hit.length === 0) return null;
    const r = document.getElementById("stage").getBoundingClientRect();
    const [sx, sy] = hit[hit.length - 1].centre;
    const cx = Math.min(639, Math.max(1, sx));
    const cy = Math.min(479, Math.max(1, sy));
    return { x: r.left + cx * r.width / 640, y: r.top + cy * r.height / 480 };
  }, name);

  /** Click a named control with the real mouse, or fail saying it was absent. */
  const clickControl = async (name) => {
    const at = await locate(name);
    if (!at) {
      failures++;
      console.log(`  FAIL no clickable control named ${name}`);
      return false;
    }
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.up();
    return true;
  };

  const screen = () => page.evaluate(
    () => window.game.children.map((c) => c.symbol).filter(Boolean));
  const clickable = () => page.evaluate(
    () => window.__debug.sprites.buttonBoxes(window.game)
      .map((h) => h.node.name).filter(Boolean));

  await settle();
  console.log("intro menu");
  check("boots on the intro menu", await screen(), ["IntroMenu"]);
  check("its buttons are clickable",
        (await clickable()).includes("Starter"), true);

  console.log("\nclicking Play");
  await clickControl("Starter");
  await settle(30);
  check("the level map opened", await screen(), ["MainMenu"]);

  console.log("\nchoosing a level");
  // a fresh save has only level 1 open, and a locked node is enabled = false,
  // so it must not even be in the clickable set
  const nodes = await clickable();
  check("only the unlocked node is clickable",
        nodes.filter((n) => n.startsWith("b_")), ["b_1_1"]);
  await clickControl("b_1_1");
  await settle(60);
  check("adventure 1 started",
        await page.evaluate(() => window.game.m_level?.CurrentMode), "adventure");

  console.log("\nRetry Level, from the pause tray");
  await clickControl("btn");                      // the tray's pull tab
  await settle(60);
  check("the tray is open and the level paused",
        await page.evaluate(() => window.game.m_level.pause), true);
  // tag the running level, so "did retry build a NEW one" is answerable
  await page.evaluate(() => { window.game.m_level.__tag = 1; });
  await clickControl("retryBtn");
  await settle(60);
  check("Retry Level built a fresh level",
        await page.evaluate(() => window.game.m_level.__tag === undefined),
        true);
  check("and it is running", await page.evaluate(
    () => window.game.m_level.pause), false);

  console.log("\nMain Menu, from the pause tray");
  await clickControl("btn");
  await settle(60);
  await clickControl("endGameBtn");
  await settle(30);
  check("back on the level map", (await screen()).includes("MainMenu"), true);

  console.log("\nRetry Level, from the game-over board");
  await clickControl("b_1_1");
  await settle(60);
  await page.evaluate(
    () => { window.game.m_level.myContactListener.deadFire = true; });
  await settle(90);
  check("the game-over board appeared",
        (await screen()).includes("GameOvero"), true);
  await clickControl("RetryBtn");
  await settle(40);
  check("the board is gone", (await screen()).includes("GameOvero"), false);
  check("a level is running again",
        await page.evaluate(() => !!window.game.m_level?.parent), true);

  console.log("\nMain Menu, from the results board");
  await page.evaluate(() => {
    const D = window.__debug, cl = window.game.m_level.myContactListener;
    for (let i = 0; i < 140; i++) { cl.finish1 = true; cl.finish2 = true; D.step(1); }
    D.step(45);
  });
  await settle(5);
  check("the results board appeared",
        (await screen()).includes("Recuento"), true);
  await clickControl("ToMenuBtn");
  await settle(30);
  // `includes`, not an exact list: RetryGame does not remove m_muter but
  // StartGame adds another one, so retrying leaks a mute button. That is the
  // original's own bug and the port keeps it -- they stack in the same place,
  // so it is invisible.
  check("back on the level map", (await screen()).includes("MainMenu"), true);
  check("finishing unlocked the next node",
        (await clickable()).filter((n) => n.startsWith("b_")).length >= 2, true);

  // MainMenu places EIGHT different clips all called "node_1", so matching a
  // child to its placement by name gave every one of them the first one --
  // the real level-1 node drew at x = -235, off the side of the stage, and the
  // map showed an empty socket where its medal should be.
  console.log("\nnodes draw at their own placements");
  check("no two clips share a placement",
        await page.evaluate(async () => {
          const man = await (await fetch("/extracted/assets/sprites.json"))
            .json();
          const geom = man.sprites[String(man.byName.MainMenu)].geom[0];
          const used = new Set();
          for (const c of window.game.m_mainMenu.children) {
            if (c.__place == null) continue;
            if (used.has(c.__place)) return "duplicate placement " + c.__place;
            used.add(c.__place);
            if (geom.children[c.__place].name !== c.name) {
              return "placement " + c.__place + " is " +
                     geom.children[c.__place].name + ", not " + c.name;
            }
          }
          return "ok";
        }), "ok");
  check("the completed node draws its medal, not an empty socket",
        await page.evaluate(async () => {
          const D = window.__debug, n = window.game.m_mainMenu.node_1;
          for (let i = 0; i < 40; i++) {
            D.render();
            if (!D.sprites.loading) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          D.render();
          const ctx = document.getElementById("stage").getContext("2d");
          const p = ctx.getImageData(Math.round(n.x), Math.round(n.y), 1, 1).data;
          // the medal gem is a strong orange; the empty socket is dull brown
          return p[0] > 150 && p[1] > 40 && p[1] < 150 && p[2] < 90;
        }), true);

  console.log("\nhover and press change the art");
  // Not a tint we invented: the SWF's own over state places a button's label
  // twice so it reads brighter, or swaps in a different label character
  // entirely, and the down state shrinks it.
  const artDiff = await page.evaluate(async () => {
    const D = window.__debug, g = window.game;
    const btn = g.m_mainMenu && g.m_mainMenu.BackToIntro;
    if (!btn) return { error: "not on the map" };
    const hit = D.sprites.buttonBoxes(g).find((h) => h.node === btn);
    if (!hit) return { error: "BackToIntro is not clickable" };
    const ctx = document.getElementById("stage").getContext("2d");
    const [cx, cy] = hit.centre;
    const w = Math.max(8, Math.min(200, Math.round(hit.box.w)));
    const h = Math.max(8, Math.min(60, Math.round(hit.box.h)));
    const x = Math.max(0, Math.min(640 - w, Math.round(cx - w / 2)));
    const y = Math.max(0, Math.min(480 - h, Math.round(cy - h / 2)));
    const grab = async (state) => {
      btn.__btnState = state;
      for (let i = 0; i < 40; i++) {
        D.render();
        if (!D.sprites.loading) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      D.render();
      return ctx.getImageData(x, y, w, h).data;
    };
    const up = await grab("up");
    const over = await grab("over");
    const down = await grab("down");
    btn.__btnState = "up";
    D.render();
    const diff = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) +
            Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
      }
      return n;
    };
    return { overVsUp: diff(up, over), downVsUp: diff(up, down) };
  });
  check("hovering changes the button art", artDiff.overVsUp > 100, true);
  check("pressing changes it again", artDiff.downVsUp > 100, true);

  console.log("\nhovering");
  const at = await locate("b_1_1");
  await page.mouse.move(at.x, at.y);
  check("rolling over a node lights it",
        await page.evaluate(() => window.game.m_mainMenu.node_1.Glower.visible),
        true);
  check("and the cursor says it is clickable",
        await page.evaluate(
          () => document.getElementById("stage").style.cursor), "pointer");
  await page.mouse.move(at.x, at.y - 200);
  check("moving off puts the light out",
        await page.evaluate(() => window.game.m_mainMenu.node_1.Glower.visible),
        false);
} finally {
  await browser.close();
  server.kill();
}

console.log("\n" + (failures === 0 ? "MOUSE TEST PASSED"
                                    : `MOUSE TEST FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
