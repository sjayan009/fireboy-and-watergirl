/**
 * Rendering facts that only a real canvas can settle.
 *
 * The physics tests prove the simulation; this proves the picture. Everything
 * here failed silently at some point: it looked plausible in a screenshot, or
 * the thing that was wrong was off the edge of the crop.
 */
import { loadPlaywright, startServer } from "./harness.mjs";

const PORT = 5197;
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
  const page = await browser.newPage();
  page.on("pageerror", (e) => {
    failures++;
    console.log("  FAIL page error: " + e.message);
  });
  await page.goto(URL_, { waitUntil: "load" });
  await page.waitForFunction("window.__debug && window.__debug.sprites",
                             null, { timeout: 30000 });

  // adventure 8 is the pulley level
  const ready = await page.evaluate(async () => {
    const D = window.__debug, g = window.game;
    const F = await import("/dist/flash/flash.js");
    const settle = async () => {
      for (let i = 0; i < 80; i++) {
        D.render();
        if (!D.sprites.loading) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      D.render();
    };
    document.getElementById("unlock").click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter",
                                                       bubbles: true }));
    D.step(30);
    const b = g.m_mainMenu.b_1_8;
    b.dispatchEvent(new F.MouseEvent("click", b));
    D.step(150);
    await settle();
    await settle();
    return g.m_level ? g.m_level.CurrentMode + " " + g.cur_lev : null;
  });
  check("adventure 8 is running", ready, "adventure 8");

  console.log("\nthe rope grows with the length the game sets");
  // level.as sets chain.y and ropeMask.height together to the anchor
  // distance. The mask is a ClipDepth mask -- nothing in the ActionScript says
  // it exists -- so without reading it out of the SWF the chain slid around at
  // its authored length and the rope never stretched.
  const rope = await page.evaluate(async () => {
    const D = window.__debug, g = window.game;
    const found = [];
    const walk = (n) => {
      for (const c of n.children || []) {
        if (c.symbol === "RopePulley") found.push(c);
        walk(c);
      }
    };
    walk(g.m_level);
    if (!found.length) return { error: "no RopePulley in adventure 8" };
    const r = found[0];
    if (!r.__clipMask) return { error: "the rope has no clip mask" };

    const ctx = document.getElementById("stage").getContext("2d");
    const settle = async () => {
      for (let i = 0; i < 80; i++) {
        D.render();
        if (!D.sprites.loading) break;
        await new Promise((res) => setTimeout(res, 100));
      }
      D.render();
    };
    /**
     * How tall the chain is on screen, isolated by differencing against a
     * render with the chain hidden -- the level has plenty of other pale art
     * in the same column (the second rope, the pulley wheel, the terrain), and
     * a colour threshold picks all of it up.
     */
    const grab = async () => {
      await settle();
      return ctx.getImageData(0, 0, 640, 480).data;
    };
    const extent = async (len) => {
      r.chain.y = len;
      r.ropeMask.height = len;
      r.chain.visible = false;
      const without = await grab();
      r.chain.visible = true;
      const with_ = await grab();
      let top = -1, bottom = -1;
      for (let i = 0; i < 640 * 480; i++) {
        const p = i * 4;
        const d = Math.abs(with_[p] - without[p]) +
                  Math.abs(with_[p + 1] - without[p + 1]) +
                  Math.abs(with_[p + 2] - without[p + 2]);
        if (d < 30) continue;
        const row = (i / 640) | 0;
        if (top < 0 || row < top) top = row;
        if (row > bottom) bottom = row;
      }
      return top < 0 ? 0 : bottom - top + 1;
    };
    const short = await extent(60);
    const medium = await extent(150);
    const long = await extent(240);
    return { short, medium, long };
  });

  if (rope.error) {
    failures++;
    console.log("  FAIL " + rope.error);
  } else {
    console.log(`  chain height on screen: ${rope.short} / ${rope.medium} / ` +
                `${rope.long} px for lengths 60 / 150 / 240`);
    check("a longer rope draws a longer chain",
          rope.medium > rope.short && rope.long > rope.medium, true);
    // 0.8 is the level scale; allow slack for the pulley art at either end
    check("it grows by roughly the length asked for",
          Math.abs((rope.long - rope.short) - (240 - 60) * 0.8) < 30, true);
  }
} finally {
  await browser.close();
  server.kill();
}

console.log("\n" + (failures === 0 ? "RENDER TEST PASSED"
                                   : `RENDER TEST FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
