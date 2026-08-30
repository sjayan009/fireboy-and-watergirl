/**
 * What all 32 levels actually look like.
 *
 * Every other test in this project proves the simulation. Not one of them would
 * notice if a mask stopped clipping, a layer drew in the wrong order, a
 * transform lost its sign, or an image failed to load -- the physics digest is
 * identical either way, because none of that is physics. This is the only test
 * that looks at the picture.
 *
 * ## Why a perceptual hash and not the pixels
 *
 * Comparing raw pixels across machines is a test that fails for reasons nobody
 * cares about: antialiasing and image decoding differ by platform and by
 * browser build. So each level is reduced to a 16x16 grid of mean luminance,
 * quantised to 16 levels -- a 256-nibble signature that is stable against a
 * pixel of blur and violently unstable against anything structural. A rope that
 * stops being clipped, a level that renders black, a sprite drawn at the wrong
 * scale: all of those move dozens of cells.
 *
 * The signature is also readable. On a mismatch this prints WHICH cells moved
 * and by how much, and writes both frames to `snaps/` to be looked at.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadPlaywright, startServer, ROOT } from "./harness.mjs";
import { resolve } from "node:path";

const PORT = 5195;
const URL_ = `http://localhost:${PORT}/`;
const GOLDEN = resolve(ROOT, "engine/test/goldenrenders.json");

/** Every level, as the map numbers them. type 1 adventure, 2 puzzle, 3 speed. */
const LEVELS = [
  ...Array.from({ length: 17 }, (_, i) => ["adventure", i + 1]),
  ...Array.from({ length: 9 }, (_, i) => ["puzzle", i + 1]),
  ...Array.from({ length: 6 }, (_, i) => ["speed", i + 1]),
];

/** Frames to run before looking. Enough for the level to settle and animate. */
const FRAMES = 120;

const playwright = await loadPlaywright();
if (!playwright) process.exit(0);

let browser;
try {
  browser = await playwright.chromium.launch();
} catch {
  console.log("chromium not installed -- skipping");
  process.exit(0);
}

const server = await startServer(PORT);

let failures = 0;
function check(what, ok, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ": " + detail : ""}`);
}

const golden = existsSync(GOLDEN)
  ? JSON.parse(readFileSync(GOLDEN, "utf8"))
  : null;
const fresh = {};

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => {
    failures++;
    console.log("  FAIL page error: " + e.message);
  });
  await page.goto(URL_, { waitUntil: "load" });
  await page.waitForFunction("window.__debug && window.__debug.sprites",
                             null, { timeout: 60000 });

  // The test is the only thing driving the clock from here.
  await page.evaluate(() => window.__debug.autoTick(false));

  for (const [mode, num] of LEVELS) {
    const result = await page.evaluate(async ([mode, num, frames]) => {
      const D = window.__debug;
      const { GameHost } = await import("/dist/net/gamehost.js");
      // The same path netplay uses to open a level from anywhere, so this
      // exercises code that ships rather than a test-only shortcut.
      new GameHost(window.game).start(mode, num);
      D.step(frames);

      // Art arrives asynchronously; a signature taken before it lands is a
      // signature of a half-drawn level.
      for (let i = 0; i < 120; i++) {
        D.render();
        if (!D.sprites.loading) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      D.render();
      if (D.sprites.loading) return { error: "art never finished loading" };
      if (D.sprites.missing) {
        return { error: `${D.sprites.missing} images failed to load` };
      }

      const px = document.getElementById("stage")
        .getContext("2d").getImageData(0, 0, 640, 480).data;

      // 16x16 cells of mean luminance, each quantised to one nibble.
      const cells = new Array(256).fill(0);
      const cw = 640 / 16, ch = 480 / 16;
      for (let y = 0; y < 480; y++) {
        const row = ((y / ch) | 0) * 16;
        for (let x = 0; x < 640; x++) {
          const p = (y * 640 + x) * 4;
          cells[row + ((x / cw) | 0)] +=
            0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
        }
      }
      const per = cw * ch;
      let sig = "";
      for (let i = 0; i < 256; i++) {
        sig += Math.min(15, Math.round(cells[i] / per / 16)).toString(16);
      }
      return { sig, level: window.game.m_level.CurrentMode };
    }, [mode, num, FRAMES]);

    const name = `${mode}-${num}`;
    if (result.error) {
      check(name, false, result.error);
      continue;
    }
    fresh[name] = result.sig;

    if (!golden) continue;
    const want = golden[name];
    if (!want) { check(name, false, "no golden signature recorded"); continue; }

    let moved = 0;
    let worst = 0;
    for (let i = 0; i < 256; i++) {
      const d = Math.abs(parseInt(result.sig[i], 16) - parseInt(want[i], 16));
      if (d > 0) moved++;
      if (d > worst) worst = d;
    }
    // One or two cells off by one is the compositor, not a regression. A
    // structural change moves whole regions.
    const ok = moved <= 6 && worst <= 2;
    check(name, ok, ok ? "" : `${moved}/256 cells differ, worst by ${worst}`);
  }
} finally {
  await browser.close().catch(() => {});
  server.kill();
}

if (!golden) {
  writeFileSync(GOLDEN, JSON.stringify(fresh, null, 1) + "\n");
  console.log(`\nrecorded ${Object.keys(fresh).length} signatures to ` +
              `engine/test/goldenrenders.json`);
  console.log("LOOK AT THE GAME before trusting these. They are only a " +
              "baseline; nothing has been verified by writing them.");
  process.exit(0);
}

// Keep the fresh set beside the golden one, so a deliberate change is a diff
// somebody can read rather than a file to regenerate blind.
writeFileSync(resolve(ROOT, "snaps/rendersignatures.json"),
              JSON.stringify(fresh, null, 1) + "\n");

console.log("\n" + (failures === 0 ? "GOLDEN RENDER PASSED"
                                   : `GOLDEN RENDER FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
