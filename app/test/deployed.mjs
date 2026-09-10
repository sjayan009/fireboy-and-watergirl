/**
 * The deployment itself, over the real internet.
 *
 * `production.mjs` serves the built `dist/` from a throwaway Node server on
 * localhost. That proves the ARTEFACT is good and says nothing about the thing
 * in front of it: the CDN, the headers `vercel.json` asks for, how an unknown
 * path is answered, TLS, and a Content-Security-Policy that is only enforced on
 * a real origin. Every one of those can be wrong while the bundle is perfect --
 * and three deployments in a row were.
 *
 * So this points a browser at the deployed URL, signs a real account in against
 * the live database, and plays a frame.
 *
 * It is not part of `npm test`: it needs the network, it needs the secret key,
 * and it asserts things about a deployment that may not exist yet. Run it after
 * a deploy.
 *
 *   node app/test/deployed.mjs [url]
 */
import { env } from "../../supabase/connect.mjs";

const SITE = (process.argv[2] ?? process.env.FBWG_URL ??
              "https://fireboy-and-watergirl-official.vercel.app")
  .replace(/\/+$/, "");

/**
 * The commit this run is about, if it was given one.
 *
 * Set by CI to the SHA it just pushed. Without it the test happily passes
 * against whatever is currently deployed, which after a failed build is the
 * PREVIOUS release -- a green check for a deployment that never happened.
 */
const WANT = process.env.FBWG_COMMIT ?? null;

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

const admin = (path, init = {}) => fetch(`${API}${path}`, {
  ...init,
  headers: {
    apikey: SECRET, Authorization: `Bearer ${SECRET}`,
    "content-type": "application/json", ...(init.headers ?? {}),
  },
});

console.log(`the deployment at ${SITE}\n`);

// ---------------------------------------------------------------- headers

const root = await fetch(`${SITE}/`);
const h = (r, k) => r.headers.get(k) ?? null;

check("the page is served", root.status, 200);

const version = (await (await fetch(`${SITE}/version.txt`)).text()).trim();
console.log(`  deployed commit: ${version}`);
if (WANT) {
  check("and it is the commit we are asking about", version, WANT);
}
check("frame-ancestors none", (h(root, "content-security-policy") ?? "")
      .includes("frame-ancestors 'none'"), true);
check("supabase is reachable under the csp",
      (h(root, "content-security-policy") ?? "")
        .includes("wss://*.supabase.co"), true);
check("X-Frame-Options", h(root, "x-frame-options"), "DENY");
check("X-Content-Type-Options", h(root, "x-content-type-options"), "nosniff");
check("Referrer-Policy", h(root, "referrer-policy"), "no-referrer");
check("X-Robots-Tag", h(root, "x-robots-tag"), "noindex, nofollow");
check("camera and mic are denied outright",
      (h(root, "permissions-policy") ?? "").includes("camera=()"), true);

// The HTML must NOT be immutable, or a deploy would never reach anybody who
// had already visited.
check("the page itself revalidates",
      (h(root, "cache-control") ?? "").includes("max-age=0"), true);

const robots = await fetch(`${SITE}/robots.txt`);
check("robots.txt disallows everything",
      (await robots.text()).includes("Disallow: /"), true);

const IMMUTABLE = "public, max-age=31536000, immutable";
const manifest = await fetch(`${SITE}/extracted/assets/sprites.json`);
check("the art is cached immutably", h(manifest, "cache-control"), IMMUTABLE);

const sprites = await manifest.json();
check("the manifest says webp", sprites.raster, "webp");

// The hashed bundle, taken from the page rather than guessed at.
const html = await root.clone().text();
const chunk = html.match(/\/assets\/[A-Za-z0-9._-]+\.js/)?.[0];
check("the page names a hashed chunk", typeof chunk, "string");
if (chunk) {
  const js = await fetch(`${SITE}${chunk}`);
  check("the bundle is cached immutably", h(js, "cache-control"), IMMUTABLE);
  const body = await js.text();
  // The one thing that must never be true of a file on a CDN.
  check("no secret key in the bundle", body.includes("sb_secret"), false);
}

/**
 * An unknown path 404s, and that is the intended answer.
 *
 * The reflex here is a catch-all rewrite to `index.html`, which every SPA guide
 * recommends. This app routes on the HASH -- `/#/login`, `/#/signup` -- so the
 * path is always `/`, including the origin Supabase sends people back to with a
 * code in the query string. There is no route a rewrite would rescue.
 *
 * There is one it would ruin: with a catch-all, a sprite whose name changed
 * comes back as 200 text/html instead of 404, the `nothing 404ed` check below
 * goes quiet, and the art silently stops loading in a way nothing reports. So
 * the 404 is asserted rather than tolerated.
 */
const deep = await fetch(`${SITE}/some/path/that/does/not/exist`);
check("an unknown path 404s rather than soft-serving the app", deep.status, 404);

const hashRoute = await fetch(`${SITE}/#/signup`);
check("a hash route is just the page", hashRoute.status, 200);

// ---------------------------------------------------------------- the app

/**
 * Everything above needs no credentials. Everything below makes a throwaway
 * account and signs it in, which needs the secret key.
 *
 * Stopping here is said out loud, in the same shape as "playwright not
 * installed" below it. A check that quietly stops running is worse than one
 * that was never written: it leaves a green tick standing for an assertion
 * nobody is making any more.
 */
if (typeof SECRET !== "string" || SECRET.length < 20) {
  console.log("\nstopping after the headers -- there is no SUPABASE_SECRET_KEY " +
              "here.");
  console.log("  In CI that means the repository has no such secret; locally " +
              "it means .env.local");
  console.log("  has none. NOT CHECKED: signing a real account in, the art " +
              "the CDN serves, the");
  console.log("  sounds, and the browser console. Everything above was.");
  process.exit(failures === 0 ? 0 : 1);
}

let playwright;
try {
  playwright = await import("playwright");
} catch {
  console.log("\nplaywright not installed -- stopping after the headers");
  process.exit(failures === 0 ? 0 : 1);
}
let browser;
try {
  browser = await playwright.chromium.launch();
} catch {
  console.log("\nchromium not installed -- stopping after the headers");
  process.exit(failures === 0 ? 0 : 1);
}

const stamp = Date.now();
const users = [];

try {
  const email = `fbwg_dep_${stamp}@example.com`;
  const password = `pw_${stamp}_dep!A`;
  const created = await (await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true }),
  })).json();
  if (!created.id) throw new Error(`could not create a test user: ${JSON.stringify(created)}`);
  users.push(created.id);
  const token = (await (await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUB, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })).json()).access_token;
  await fetch(`${API}/rest/v1/rpc/claim_username`, {
    method: "POST",
    headers: { apikey: PUB, Authorization: `Bearer ${token}`,
               "content-type": "application/json" },
    body: JSON.stringify({ new_username: `dp${stamp % 100000}` }),
  });

  const page = await browser.newPage();
  const problems = [];
  const blocked = [];
  const missing = [];
  const webp = [];
  page.on("pageerror", (err) => problems.push(err.message));
  // A CSP refusal is not a failed request -- it never becomes one. It shows up
  // only here, which is why a policy can look fine in a header and break the
  // page.
  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to/i.test(t)) blocked.push(t);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`);
    // The PATH, not the whole URL. Asset requests carry `?v=<digest>` so that
    // the one-year `immutable` header on this subtree is a promise the build
    // can keep -- and `endsWith(".webp")` on the full URL therefore matched
    // nothing at all. The art was loading correctly the whole time; the test
    // had simply stopped being able to recognise it.
    if (new URL(r.url()).pathname.endsWith(".webp")) webp.push(r.url());
  });

  await page.goto(`${SITE}/#/login`, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector("input[type=email]", { timeout: 60000 });
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", password);
  await page.click("button[type=submit]");
  await page.waitForSelector("#stage", { timeout: 60000 });
  check("a real account signs in and reaches the game", true, true);

  // No `__fbwg` in a production build, so the art is waited for by watching the
  // canvas rather than by asking the engine.
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
  check("the menu draws from art served by the cdn", painted > 0.3, true);
  check("and that art was webp", webp.length > 0, true);

  check("no debug hook is shipped",
        await page.evaluate(() => "__fbwg" in window), false);

  const audio = await page.evaluate(async () => {
    const m = await (await fetch("/extracted/assets/sounds.json")).json();
    const ok = await Promise.all(Object.values(m).map(async (where) =>
      (await fetch("/extracted/assets/" + where, { method: "HEAD" })).ok));
    return { count: ok.length, ok: ok.every(Boolean) };
  });
  check(`all ${audio.count} sounds are fetchable`, audio.ok, true);

  check("nothing was refused by the csp", blocked.slice(0, 3), []);
  check("nothing 404ed", missing.slice(0, 3), []);
  check("and no page errors", problems, []);
} catch (err) {
  failures++;
  console.log("  FAIL " + err.message);
} finally {
  await browser.close().catch(() => {});
  for (const id of users) {
    await admin(`/auth/v1/admin/users/${id}`, { method: "DELETE" });
  }
  console.log(`\ncleaned up ${users.length} test user`);
}

console.log("\n" + (failures === 0 ? "DEPLOYED PASSED"
                                   : `DEPLOYED FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
