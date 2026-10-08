/**
 * The built app, in a browser, exactly as it will be served.
 *
 * Every other app test drives the Vite DEV server, because that is where the
 * test hooks exist. That leaves a real gap: the thing people will actually load
 * is a different artefact -- bundled, minified, chunk-split, with
 * `import.meta.env.DEV` false and the debug hook compiled out, reading WebP
 * sprites and MP3 audio from rewritten manifests rather than the originals.
 *
 * None of that is exercised anywhere else, and all of it can break
 * independently of the source. So this loads the built `dist/` over plain HTTP,
 * with no bundler anywhere near it, signs in, and looks at the pixels.
 *
 * It deliberately uses nothing but the DOM and the canvas -- there is no
 * `__fbwg` in a production build, which is the point of not shipping one.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../../supabase/connect.mjs";
import { passCaptcha } from "./captcha.mjs";
import { resolveUnder } from "../../safepath.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "../../dist");
const PORT = 5192;
const URL_ = `http://localhost:${PORT}/`;

const e = env();
const API = e.SUPABASE_URL;
const PUB = e.SUPABASE_PUBLISHABLE_KEY;
const SECRET = e.SUPABASE_SECRET_KEY;

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` +
              (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

if (!existsSync(DIST)) {
  console.log("no build to serve -- run `npm run build` first");
  process.exit(1);
}

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".webp": "image/webp", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".ttf": "font/ttf", ".woff2": "font/woff2", ".txt": "text/plain",
  ".map": "application/json",
};

/**
 * Static files, and index.html for anything else -- as a CDN would.
 *
 * The mapping goes through `safepath.mjs` like the other two servers in this
 * repository. It had the same hole they did: a `/`-only filter for `..`
 * followed by `path.join`, which on Windows honours `\` as a separator too, so
 * `..%5C` walked out of `dist/` while this test was running. It is a test
 * server on a developer's machine and that is exactly the machine with the
 * credentials on it.
 *
 * Bound to loopback explicitly, for the same reason.
 */
const server = createServer(async (req, res) => {
  let file = resolveUnder(DIST, req.url);
  if (file === null) { res.writeHead(400); res.end("no"); return; }
  if (file === DIST || !existsSync(file)) file = join(DIST, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));

const admin = (path, init = {}) => fetch(`${API}${path}`, {
  ...init,
  headers: {
    apikey: SECRET, Authorization: `Bearer ${SECRET}`,
    "content-type": "application/json", ...(init.headers ?? {}),
  },
});

const stamp = Date.now();
const users = [];

let playwright;
try {
  playwright = await import("playwright");
} catch {
  console.log("playwright not installed -- skipping");
  process.exit(0);
}
let browser;
try {
  browser = await playwright.chromium.launch();
} catch {
  console.log("chromium not installed -- skipping");
  process.exit(0);
}

try {
  // An account that is already all the way in, so this tests the build rather
  // than re-testing sign-up.
  const email = `fbwg_prod_${stamp}@example.com`;
  const password = `pw_${stamp}_prod!A`;
  const created = await (await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true }),
  })).json();
  users.push(created.id);
  // The secret key, because Supabase lets it past Turnstile and a test
  // cannot solve one.
  const token = (await (await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SECRET, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })).json()).access_token;
  await fetch(`${API}/rest/v1/rpc/claim_username`, {
    method: "POST",
    headers: { apikey: PUB, Authorization: `Bearer ${token}`,
               "content-type": "application/json" },
    body: JSON.stringify({ new_username: `pr${stamp % 100000}` }),
  });

  const page = await browser.newPage();
  await passCaptcha(page.context(), API, SECRET, (path) => { failures++; console.log(`  FAIL no Turnstile token sent to ${path}`); });
  const problems = [];
  const missing = [];
  page.on("pageerror", (err) => problems.push(err.message));
  page.on("response", (r) => {
    if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`);
  });

  console.log("the built app, served as static files");
  // The bare address, signed out, is the landing page, and its Sign In is the
  // way to the form.
  await page.goto(URL_, { waitUntil: "load" });
  await page.waitForSelector("#scene", { timeout: 40000 });
  check("the bare address shows the landing page", true, true);
  await page.click('.nav a[href="#/login"]');
  await page.waitForSelector("input[type=email]", { timeout: 40000 });
  check("and its Sign In reaches the form", await page.evaluate(() => location.hash), "#/login");
  await page.goto(URL_ + "#/login", { waitUntil: "load" });
  await page.waitForSelector("input[type=email]", { timeout: 40000 });
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", password);
  await page.click("button[type=submit]");
  await page.waitForSelector("#stage", { timeout: 40000 });
  check("signs in and reaches the game", true, true);

  // Signed in, the same bare address skips the landing page for the game.
  await page.goto(URL_, { waitUntil: "load" });
  await page.waitForFunction(() => location.hash === "#/play", null, { timeout: 40000 });
  await page.waitForSelector("#stage", { timeout: 40000 });
  check("signed in, the bare address goes straight to /play",
        await page.evaluate(() => !!document.querySelector("#scene")), false);

  // No __fbwg here, so the art is waited for by watching the canvas settle.
  const paint = () => page.evaluate(() => {
    const px = document.getElementById("stage").getContext("2d")
      .getImageData(0, 0, 640, 480).data;
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] + px[i + 1] + px[i + 2] > 60) lit++;
    }
    return lit / (px.length / 4);
  });
  let painted = 0;
  for (let i = 0; i < 60; i++) {
    painted = await paint();
    if (painted > 0.3) break;
    await page.waitForTimeout(500);
  }
  check("the WebP art loads and the menu draws", painted > 0.3, true);

  check("no debug hook is shipped",
        await page.evaluate(() => "__fbwg" in window), false);

  // The audio manifest now points at `sounds/*.mp3` rather than the decoded
  // WAVs; a wrong path here is silence, with nothing in the console.
  const audio = await page.evaluate(async () => {
    const r = await fetch("/extracted/assets/sounds.json");
    const m = await r.json();
    const checks = await Promise.all(Object.values(m).map(async (where) => {
      const res = await fetch("/extracted/assets/" + where, { method: "HEAD" });
      return res.ok;
    }));
    return { count: checks.length, ok: checks.every(Boolean) };
  });
  check(`all ${audio.count} sounds are fetchable`, audio.ok, true);

  check("nothing 404ed", missing.slice(0, 3), []);
  check("and no page errors", problems, []);
} catch (err) {
  failures++;
  console.log("  FAIL " + err.message);
} finally {
  await browser.close().catch(() => {});
  server.close();
  for (const id of users) {
    await admin(`/auth/v1/admin/users/${id}`, { method: "DELETE" });
  }
  console.log(`\ncleaned up ${users.length} test user`);
}

console.log("\n" + (failures === 0 ? "PRODUCTION PASSED"
                                   : `PRODUCTION FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
