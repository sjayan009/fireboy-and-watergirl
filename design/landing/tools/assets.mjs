// Rasterises the SWF's own vector art into the sheets the concepts use.
// Vector frames are 300 KB apiece; a sheet of 22 is a few hundred KB of WebP.
import { chromium } from "playwright";
import sharp from "sharp";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const RAW = `${ROOT}/extracted/assets/_raw/svg/`;
const OUT = fileURLToPath(new URL("../assets/", import.meta.url));
mkdirSync(`${OUT}doors`, { recursive: true });
mkdirSync(`${OUT}sprites`, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

/** Render one SVG file at `scale`, transparent, and return a PNG buffer. */
async function raster(file, scale) {
  const svg = readFileSync(file, "utf8");
  const w = parseFloat(/width="([\d.]+)px"/.exec(svg)[1]);
  const h = parseFloat(/height="([\d.]+)px"/.exec(svg)[1]);
  const W = Math.round(w * scale), H = Math.round(h * scale);
  await page.setViewportSize({ width: W, height: H });
  const src = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block}</style><img width="${W}" height="${H}">`);
  await page.$eval("img", (img, src) => new Promise((ok) => { img.onload = ok; img.src = src; }), src);
  return { buf: await page.screenshot({ omitBackground: true }), W, H };
}

/** `crop` trims every frame to the same rows, measured off the alpha bounding box. */
async function sheet(name, files, scale, crop) {
  const frames = [];
  for (const f of files) {
    const r = await raster(f, scale);
    if (crop) {
      r.buf = await sharp(r.buf).extract({ left: 0, top: crop.top, width: r.W, height: crop.height }).png().toBuffer();
      r.H = crop.height;
    }
    frames.push(r);
  }
  const { W, H } = frames[0];
  await sharp({ create: { width: W * frames.length, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(frames.map((f, i) => ({ input: f.buf, left: i * W, top: 0 })))
    .webp({ quality: 76, alphaQuality: 90, effort: 6 }).toFile(`${OUT}${name}.webp`);
  console.log(name, `${frames.length} x ${W}x${H}`);
}

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
await sheet("doors/fire", range(22).map((i) => `${RAW}DefineSprite_159_FinishBoy/${i}.svg`), 4, { top: 160, height: 253 });
await sheet("doors/water", range(22).map((i) => `${RAW}DefineSprite_166_FinishGirl/${i}.svg`), 4, { top: 160, height: 253 });
await sheet("sprites/fire-run", range(8).map((i) => `${RAW}DefineSprite_242_FireBoyAndWaterGirl_fla.fire_running_40/${i}.svg`), 0.6);
await sheet("sprites/water-run", range(8).map((i) => `${RAW}DefineSprite_839_FireBoyAndWaterGirl_fla.water_running_283/${i}.svg`), 0.6, { top: 60, height: 186 });
await sheet("wall", [`${ROOT}/extracted/assets/shapes/346.svg`], 3);
// The game's own climb: FireBoystairs (25 frames) and WaterGirlStairs (35),
// placed at the door's origin when both doors are fully open (game.ts ~2105).
await sheet("doors/fire-stairs", range(25).map((i) => `${RAW}DefineSprite_250_FireBoystairs/${i}.svg`), 4);
await sheet("doors/water-stairs", range(35).map((i) => `${RAW}DefineSprite_876_WaterGirlStairs/${i}.svg`), 4);
mkdirSync(`${OUT}lever`, { recursive: true });
await sheet("lever/handle", [`${RAW}DefineSprite_444_LeverMc/1.svg`], 4);
await sheet("lever/base", [`${RAW}DefineSprite_442_LeverBase/1.svg`], 4);
await browser.close();
