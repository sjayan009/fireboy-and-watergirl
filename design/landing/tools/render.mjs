// Renders the exploration's images from the live pages (npx vite design/landing --port 5180).
//
//   node design/landing/tools/render.mjs            everything
//   node design/landing/tools/render.mjs pages      full pages + heroes, light and dark, desktop and phone
//   node design/landing/tools/render.mjs squint     the report's blur test on every hero
//   node design/landing/tools/render.mjs motion     filmstrips and animated WebPs of the motion studies
//
// Every animation is captured by SEEKING its Web Animations, never by
// screenshotting in real time, so each frame is exactly the frame at that
// millisecond and the output is identical run to run.
import { chromium } from "playwright";
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.DESIGN_URL || "http://localhost:5180";
const OUT = fileURLToPath(new URL("../renders/", import.meta.url));
mkdirSync(OUT, { recursive: true });
const only = process.argv[2];

export const PAGES = [
  ["hybrid", "index.html"],
  ["doors", "directions/doors.html"],
  ["frames", "directions/frames.html"],
  ["recovered", "directions/recovered.html"],
];
const VIEWPORTS = { desktop: { width: 1440, height: 900, deviceScaleFactor: 1 }, phone: { width: 390, height: 844, deviceScaleFactor: 2 } };

const browser = await chromium.launch();

async function open(path, vp, theme, extra = "") {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, colorScheme: theme });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/${path}?theme=${theme}&still${extra}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  // Every scene on a page is shown at its resting, final frame.
  await page.evaluate(() => { for (const s of Object.values(window.scenes || {})) s.finish?.(); window.scene?.finish?.(); window.rb?.seek?.(112); });
  await page.waitForTimeout(150);
  return { page, ctx };
}

async function pages() {
  for (const [name, path] of PAGES.filter(([n]) => !process.env.PAGE || process.env.PAGE === n)) {
    for (const theme of ["light", "dark"]) {
      for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
        const { page, ctx } = await open(path, vp, theme);
        // Lazy images: walk the page so they load before the full-page capture.
        await page.evaluate(async () => {
          for (const img of document.querySelectorAll("img[loading=lazy]")) img.loading = "eager";
          for (let y = 0; y < document.body.scrollHeight; y += 600) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
          scrollTo(0, 0);
          await Promise.all([...document.images].map((i) => i.decode().catch(() => 0)));
        });
        await page.screenshot({ path: `${OUT}${name}-${theme}-${vpName}-hero.png` });
        await page.screenshot({ path: `${OUT}${name}-${theme}-${vpName}-full.png`, fullPage: true });
        console.log("page", name, theme, vpName);
        await ctx.close();
      }
    }
  }
}

/*
 * The report's attention audit: "blur the screenshot slightly, squint, or
 * inspect at thumbnail size. The rank structure should remain legible."
 * Each hero, blurred and shrunk, beside the sharp original.
 */
async function squint() {
  const tiles = [];
  for (const [name] of PAGES.filter(([n]) => n !== "hybrid")) {
    for (const theme of ["light", "dark"]) {
      const src = `${OUT}${name}-${theme}-desktop-hero.png`;
      const sharpTile = await sharp(src).resize(480).png().toBuffer();
      const blurTile = await sharp(src).resize(480).blur(6).png().toBuffer();
      tiles.push({ sharpTile, blurTile });
    }
  }
  const W = 480, H = 300, gap = 16;
  const composite = [];
  tiles.forEach((t, i) => {
    const y = i * (H + gap);
    composite.push({ input: t.sharpTile, left: 0, top: y }, { input: t.blurTile, left: W + gap, top: y });
  });
  await sharp({ create: { width: W * 2 + gap, height: tiles.length * (H + gap) - gap, channels: 3, background: "#888" } })
    .composite(composite).png().toFile(`${OUT}squint-test.png`);
  console.log("squint-test.png");
}

/** Capture `frames` of one element while seeking `seek(ms)` inside the page. */
async function capture(page, selector, times, seekFn) {
  const el = page.locator(selector);
  const shots = [];
  for (const t of times) {
    await page.evaluate(seekFn, t);
    await page.waitForTimeout(30);
    shots.push(await el.screenshot());
  }
  return shots;
}

async function strip(shots, labels, file, { cols = shots.length, bg = "#0d0b09", fg = "#d9d0bf" } = {}) {
  const meta = await sharp(shots[0]).metadata();
  const w = meta.width, h = meta.height, pad = 12, lab = 34;
  const rows = Math.ceil(shots.length / cols);
  const composite = [];
  shots.forEach((s, i) => {
    const x = pad + (i % cols) * (w + pad), y = pad + Math.floor(i / cols) * (h + lab + pad);
    composite.push({ input: s, left: x, top: y });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${lab}"><text x="0" y="22" font-family="Consolas, monospace" font-size="${Math.max(13, Math.round(w / 26))}" fill="${fg}">${labels[i]}</text></svg>`;
    composite.push({ input: Buffer.from(svg), left: x, top: y + h + 4 });
  });
  await sharp({ create: { width: pad + cols * (w + pad), height: pad + rows * (h + lab + pad), channels: 3, background: bg } })
    .composite(composite).png().toFile(`${OUT}${file}`);
  console.log(file);
}

async function animated(shots, file, delayMs) {
  await sharp(shots, { join: { animated: true } })
    .webp({ quality: 82, loop: 0, delay: shots.map(() => delayMs) })
    .toFile(`${OUT}${file}`);
  console.log(file);
}

async function motion() {
  const mod = await import("./motion-captures.mjs");
  for (const job of mod.JOBS) await job({ browser, BASE, OUT, capture, strip, animated, open });
}

if (!only || only === "pages") await pages();
if (!only || only === "squint") await squint();
if (!only || only === "motion") await motion();
await browser.close();
