// Quick look at one page state: node peek.mjs <path> <out.png> [theme] [width] [js-to-run]
import { chromium } from "playwright";
const [path, out, theme = "dark", width = "1280", js = ""] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: Number(width), height: 900 }, colorScheme: theme });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await p.goto(`http://localhost:5180/${path}${path.includes("?") ? "&" : "?"}theme=${theme}&still`, { waitUntil: "networkidle" });
if (js) await p.evaluate(`(async () => { ${js} })()`);
await p.waitForTimeout(300);
await p.screenshot({ path: out, fullPage: process.env.FULL === "1" });
if (errors.length) console.log("ERRORS", errors);
await b.close();
