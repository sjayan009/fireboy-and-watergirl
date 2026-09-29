// Sanity sweep: every page loads without errors, keyboard reaches the theme
// control, arrow keys change theme, reduced motion lands scenes on their final
// frame, and nothing overflows horizontally at phone width.
import { chromium } from "playwright";
const PAGES = ["index.html", "developers/index.html", "developers/netcode.html", "developers/recovery.html", "developers/architecture.html",
  "board.html", "directions/doors.html", "directions/frames.html", "directions/recovered.html",
  "motion/theme-toggle.html", "motion/hero-sequence.html", "motion/rollback.html", "motion/invite-states.html", "motion/loading-geometry.html"];
const b = await chromium.launch();
let bad = 0;
for (const path of PAGES) {
  for (const [w, reduced] of [[1280, false], [375, true]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 800 }, reducedMotion: reduced ? "reduce" : "no-preference", colorScheme: "light" });
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(e.message));
    p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
    p.on("requestfailed", (r) => errs.push("failed " + r.url()));
    p.on("response", (r) => { if (r.status() >= 400) errs.push(`${r.status()} ${r.url()}`); });
    await p.goto(`http://localhost:5180/${path}`, { waitUntil: "networkidle" });
    const r = await p.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      done: document.querySelector(".scene")?.hasAttribute("data-done") ?? null,
      theme: document.documentElement.dataset.theme,
    }));
    // Keyboard: focus the checked theme radio and press → once (dark > light).
    // The theme commits inside a view transition, which can take a while on the
    // first, cold page: wait for it, up to a limit, rather than a fixed time.
    const radio = p.locator('.nav .theme button[aria-checked="true"]');
    let themeAfter = null;
    if (await radio.count()) { await radio.focus(); await p.keyboard.press("ArrowRight"); await p.waitForFunction(() => document.documentElement.dataset.theme === "light", null, { timeout: 3000 }).catch(() => {}); themeAfter = await p.evaluate(() => document.documentElement.dataset.theme); }
    const ok = !errs.length && r.overflow <= 0 && (themeAfter === null || themeAfter === "light") && (!reduced || r.done !== false);
    if (!ok) bad++;
    console.log(ok ? "ok  " : "FAIL", w, reduced ? "reduced" : "motion ", path, JSON.stringify({ ...r, themeAfter, errs }));
    await ctx.close();
  }
}
await b.close();
process.exit(bad ? 1 : 0);
