// Motion captures for render.mjs. Each job seeks its animation to exact times.
import sharp from "sharp";

const range = (a, b, step) => { const out = []; for (let t = a; t <= b + 1e-6; t += step) out.push(Math.round(t * 100) / 100); return out; };
const shrink = (bufs, width) => Promise.all(bufs.map((b) => sharp(b).resize(width).png().toBuffer()));

/** The hero: 20 fps animated WebP, plus a filmstrip of its beats. */
async function doorsSequence({ browser, BASE, capture, strip, animated }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/motion/hero-sequence.html?theme=dark`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const end = await page.evaluate(() => window.scene.duration);
  const seek = (t) => window.scene.seek(t);
  const times = range(0, end, 50);
  let frames = await shrink(await capture(page, "#scene", times, seek), 560);
  frames = [...frames, ...Array(24).fill(frames.at(-1))];      // hold the last frame 1.2 s
  await animated(frames, "doors-sequence.webp", 50);
  const T = await page.evaluate(async () => (await import("../shared/doors-scene.js")).TIMELINE);
  const beats = [[0, "0 ms · still"], [T.start + 400, `${T.start + 400} ms · running`], [T.fireArrive, `${T.fireArrive} ms · fire arrives`], [T.waterArrive, `${T.waterArrive} ms · water arrives`], [T.climb + 300, `${Math.round(T.climb + 300)} ms · climbing`], [T.end, `${Math.round(T.end)} ms · done`]];
  const shots = await shrink(await capture(page, "#scene", beats.map((b) => b[0]), seek), 420);
  await strip(shots, beats.map((b) => b[1]), "doors-filmstrip.png", { cols: 3 });
  await ctx.close();
}

/** The theme reveal, captured by pausing the View Transition and seeking it. */
async function themeReveal({ browser, BASE, OUT, strip, animated }) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1, colorScheme: "light" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/motion/theme-toggle.html`, { waitUntil: "networkidle" });
  await page.evaluate(() => { try { localStorage.setItem("fbwg.theme", "light"); } catch {} });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => { document.documentElement.dataset.revealScale = "200"; });
  await page.locator('#navTheme button[data-pref="dark"]').click();
  await page.waitForFunction(() => document.getAnimations().some((a) => String(a.effect?.pseudoElement || "").includes("view-transition-new")));
  await page.evaluate(() => { for (const a of document.getAnimations()) a.pause(); });
  const times = range(0, 420, 20);
  const frames = [];
  for (const t of times) {
    await page.evaluate((ms) => { for (const a of document.getAnimations()) a.currentTime = ms * 200; }, t);
    await page.waitForTimeout(40);
    frames.push(await page.screenshot());
  }
  const small = await shrink(frames, 600);
  const held = [...Array(10).fill(small[0]), ...small, ...Array(20).fill(small.at(-1))];
  await animated(held, "theme-reveal.webp", 40);
  const pick = [0, 2, 4, 7, 11, 21].map((i) => small[i]);
  await strip(pick, [0, 2, 4, 7, 11, 21].map((i) => `${times[i]} ms`), "theme-reveal-filmstrip.png", { cols: 3 });
  await page.evaluate(() => { for (const a of document.getAnimations()) a.finish(); });
  await ctx.close();

  // The three controls, in both themes.
  for (const theme of ["light", "dark"]) {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
    const p = await c.newPage();
    await p.goto(`${BASE}/motion/theme-toggle.html?theme=${theme}`, { waitUntil: "networkidle" });
    await p.locator(".specimens").screenshot({ path: `${OUT}theme-controls-${theme}.png` });
    console.log(`theme-controls-${theme}.png`);
    await c.close();
  }
}

/** Rollback at quarter speed: one frame per game frame x4. */
async function rollback({ browser, BASE, capture, strip, animated }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/motion/rollback.html?theme=dark&still`, { waitUntil: "networkidle" });
  const frames = await shrink(await capture(page, "#rb", range(96, 124, 1), (f) => window.rb.seek(f)), 720);
  // Linger on the two corrections so they can be read.
  const seq = frames.flatMap((f, i) => (i + 96 === 112 || i + 96 === 114 ? Array(8).fill(f) : [f, f]));
  await animated([...seq, ...Array(8).fill(frames.at(-1))], "rollback.webp", 77);
  const keys = [104, 110, 112, 114];
  const shots = await shrink(await capture(page, "#rb", keys, (f) => window.rb.seek(f)), 640);
  await strip(shots, keys.map((k) => `f${k}`), "rollback-filmstrip.png", { cols: 2 });
  await ctx.close();
}

async function invite({ browser, BASE, OUT }) {
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5, colorScheme: theme });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/motion/invite-states.html?theme=${theme}`, { waitUntil: "networkidle" });
    await page.locator("#sheet").screenshot({ path: `${OUT}invite-sheet${theme === "dark" ? "-dark" : ""}.png` });
    console.log("invite-sheet", theme);
    await ctx.close();
  }
}

async function loading({ browser, BASE, OUT }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/motion/loading-geometry.html?theme=dark`, { waitUntil: "networkidle" });
  await page.locator("#go").click();
  await page.waitForTimeout(450);
  const mid = await page.locator(".lanes3").screenshot();
  await page.waitForTimeout(1300);
  const done = await page.locator(".lanes3").screenshot();
  const m = await sharp(mid).metadata();
  await sharp({ create: { width: m.width, height: m.height * 2 + 24, channels: 3, background: "#14110e" } })
    .composite([{ input: mid, left: 0, top: 0 }, { input: done, left: 0, top: m.height + 24 }]).png().toFile(`${OUT}loading-geometry.png`);
  console.log("loading-geometry.png");
  await ctx.close();
}

export const JOBS = [doorsSequence, themeReveal, rollback, invite, loading];
