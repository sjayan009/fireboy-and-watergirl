// Records the Watch panel's finish from the real engine into a small animated
// WebP (assets/watch-finish.webp) plus a poster (assets/watch-poster.webp), so
// the landing page shows the engine's exact frames without loading the engine.
//   Needs the design server (:5180). Frames come from shared/watch.js, seeked
//   one engine frame at a time and read straight off its canvas.
import { chromium } from "playwright";
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../assets/", import.meta.url));
const WIDTH = Number(process.env.WIDTH ?? 768);
const QUALITY = Number(process.env.Q ?? 72);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://localhost:5180/tools/watch-capture.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.watch && window.watch.frames > 0, null, { timeout: 60000 });
const n = await p.evaluate(() => window.watch.frames);
const frames = [];
for (let f = 1; f <= n; f++) {
  const url = await p.evaluate((f) => { window.watch.seek(f); return document.querySelector("#watch canvas").toDataURL("image/png"); }, f);
  frames.push(await sharp(Buffer.from(url.split(",")[1], "base64")).resize(WIDTH).png().toBuffer());
}
await b.close();
// 26 fps played at 0.7x, as the live panel did: one engine frame every ~55 ms.
const delay = Math.round(1000 / 26 / 0.7);
await sharp(frames, { join: { animated: true } }).webp({ quality: QUALITY, effort: 6, loop: 1, delay: frames.map(() => delay) }).toFile(OUT + "watch-finish.webp");
await sharp(frames[0]).webp({ quality: 80 }).toFile(OUT + "watch-poster.webp");
await sharp(frames.at(-1)).webp({ quality: 80 }).toFile(OUT + "watch-end.webp");
console.log(JSON.stringify({ frames: n, delay, durationMs: n * delay }));
