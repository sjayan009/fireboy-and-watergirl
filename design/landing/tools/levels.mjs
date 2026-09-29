// Renders all 32 levels through the engine's own harness (npm run serve, :5173)
// so the landing concepts show real levels rather than a title screen.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const OUT = new URL("../assets/levels/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const MODES = [[1, "adventure", 17], [2, "puzzle", 9], [3, "speed", 6]];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
await page.goto("http://localhost:5173/");
await page.waitForFunction(() => (globalThis).game, null, { timeout: 20000 });
await page.waitForTimeout(3000);
// The title screen first, as the rebuilt engine draws it.
await sharp(await page.locator("#stage").screenshot()).webp({ quality: 88 }).toFile(fileURLToPath(new URL("../title.webp", OUT)));
for (const [type, name, count] of MODES) {
  for (let n = 1; n <= count; n++) {
    await page.evaluate(([t, n]) => {
      const g = globalThis.game;
      if (g.m_level && g.m_level.parent) g.removeChild(g.m_level);
      for (const k of ["m_mainMenu", "m_introMenu", "m_levelMap", "m_map"]) {
        if (g[k] && g[k].parent) g.removeChild(g[k]);
      }
      g.StartGame(t, n);
    }, [type, n]);
    await page.waitForTimeout(700);
    const file = new URL(`${name}-${String(n).padStart(2, "0")}.webp`, OUT);
    const png = await page.locator("#stage").screenshot();
    await sharp(png).webp({ quality: 86 }).toFile(fileURLToPath(file));
    console.log("wrote", file.pathname.split("/").pop());
  }
}
await browser.close();
