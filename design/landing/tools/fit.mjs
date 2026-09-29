// Checks that "Online Multiplayer" fits in the window under
// the sticky nav, at common desktop sizes, when reached by the nav links.
//   node design/landing/tools/fit.mjs [out-prefix]
import { chromium } from "playwright";
const SIZES = [[1280, 720], [1280, 800], [1366, 768], [1440, 900], [1536, 864], [1600, 900], [1680, 1050], [1920, 1080], [2560, 1440]];
const b = await chromium.launch();
let bad = 0;
for (const [w, h] of SIZES) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.goto("http://localhost:5180/?still", { waitUntil: "networkidle" });
  const row = [];
  for (const [link, id] of [["Online Multiplayer", "multiplayer"]]) {
    await p.click(`.nav-links a:has-text("${link}")`);
    await p.waitForTimeout(700);
    const r = await p.evaluate((id) => {
      const nav = document.querySelector(".nav").getBoundingClientRect().bottom;
      // The section's heading must start under the nav and its last control
      // (the demo's Pause and Replay) must end inside the window. The section's
      // own bottom padding may run past; it is empty space.
      const s = document.getElementById(id).getBoundingClientRect();
      const last = document.querySelector(`#${id} .journey-bar`).getBoundingClientRect();
      return { top: Math.round(s.top - nav), bottom: Math.round(innerHeight - last.bottom), h: Math.round(s.height) };
    }, id);
    // Fits: starts right under the nav and ends inside the window.
    const ok = Math.abs(r.top) <= 1 && r.bottom >= -1;
    if (!ok) bad++;
    row.push(`${id}: ${ok ? "ok " : "NO "}top ${r.top} spare ${r.bottom}`);
    if (process.argv[2] && (w === 1440 || w === 1280 || w === 1920)) await p.screenshot({ path: `${process.argv[2]}-${id}-${w}.png` });
  }
  console.log(`${w}x${h}`.padEnd(10), row.join("   "));
  await p.close();
}
await b.close();
process.exit(bad ? 1 : 0);
