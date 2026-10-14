/**
 * What has to be true of the build before it goes anywhere.
 *
 * Three questions, none of which any other test asks:
 *
 *   * Did a secret get into something the browser downloads? The publishable
 *     key is meant to be public and the secret key bypasses row level security
 *     entirely, so this is the difference between a deployment and an incident.
 *     Grepping the output is crude and it is also exactly right: whatever
 *     mistake put a secret there, it is in these files or it is not.
 *   * Does every asset the manifests name actually exist, in the format they
 *     now claim? The build rewrites both manifests -- PNG to WebP, decoded WAV
 *     to the original MP3 -- and a mismatch is a game that renders nothing and
 *     says nothing, with no error anywhere.
 *   * Has the bundle quietly grown? A dependency added without noticing is
 *     noticed here, on the day it lands, rather than in a Lighthouse score
 *     months later.
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanClientSecrets } from "./secret-scan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DIST = resolve(ROOT, "dist");
const ASSETS = join(DIST, "extracted/assets");

let failures = 0;
function check(what, ok, detail = "") {
  if (!ok) failures++;
  // The detail is always a reason something failed, so it only belongs in the
  // output when something did.
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}` +
              (!ok && detail ? ": " + detail : ""));
}

if (!existsSync(DIST)) {
  console.log("no build to check -- run `npm run build` first");
  process.exit(1);
}

/** Every file under a directory, as absolute paths. */
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ---- secrets ---------------------------------------------------------------

console.log("nothing secret reached the build");
{
  const env = {};
  const envPath = resolve(ROOT, ".env.local");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  // The literal values where they exist, and the shapes regardless -- so this
  // still means something in CI, where .env.local does not exist and the
  // secrets arrive as environment variables under different names.
  // Source maps and public SVGs are just as readable as JavaScript.
  // Scan both sources: a CI override must not hide a leaked local secret.
  const { output: text, source, hits } = scanClientSecrets(ROOT, DIST, env, process.env);
  check(`${text.length} output and ${source.length} client source files carry no secret`, hits.length === 0,
        hits.join("; "));

  // The one value that IS meant to be there, so a build that silently lost its
  // configuration fails here rather than in front of somebody.
  //
  // Except on a run that HAS no project: a pull request from a fork, or from
  // Dependabot, gets no repository secrets, and this check used to demand the
  // presence of values GitHub had deliberately withheld. Those runs build
  // against documented placeholders instead, and the assertion becomes the one
  // that is true of them -- that the placeholder is what is in there, and not
  // a real project reached by accident.
  const bundles = text.filter((p) => p.endsWith(".js"));
  const bodies = bundles.map((p) => readFileSync(p, "utf8"));
  if (process.env.FBWG_PLACEHOLDER_ENV === "1") {
    check("this run has no project, and says so in the bundle",
          bodies.some((b) => b.includes("placeholder.supabase.co")));
    check("and reached no real one",
          !bodies.some((b) => /https:\/\/(?!placeholder)[a-z0-9]+\.supabase\.co/
            .test(b)));
  } else {
    check("but the project it talks to is configured",
          bodies.some((b) => /sb_publishable_|supabase\.co/.test(b)));
  }
}

// ---- the manifests tell the truth -----------------------------------------

console.log("\nevery asset the manifests name is there");
{
  const read = (name) =>
    JSON.parse(readFileSync(join(ASSETS, name), "utf8"));

  const sprites = read("sprites.json");
  const raster = sprites.raster ?? "png";
  let missing = [];
  let checked = 0;

  for (const [id, sprite] of Object.entries(sprites.sprites)) {
    for (let f = 1; f <= sprite.frames; f++) {
      const geom = sprite.geom[f - 1];
      if (!geom) continue;
      const file = geom.children.length === 0
        ? `${f}.${raster}`
        : (geom.base ?? `${f}_base.svg`);
      checked++;
      if (!existsSync(join(ASSETS, "sprites", id, file))) {
        missing.push(`sprites/${id}/${file}`);
      }
    }
  }
  check(`${checked} sprite frames, format "${raster}"`, missing.length === 0,
        missing.slice(0, 5).join(", "));
  // A build that shipped the PNGs would work perfectly and be three times the
  // download, with nothing else in the project noticing.
  check("the sprites were converted, not copied", raster === "webp",
        `shipped as ${raster}`);

  // ---- the raster's canvas is the rect, plus an even margin ----------------
  //
  // `w/h/ox/oy` are read off JPEXS's SVG export, whose canvas IS the shape's
  // bounds rect. The raster is a separate export pass and it grows the canvas
  // when a filter bleeds outside those bounds -- symmetrically, which is the
  // whole reason the renderer can put the registration point back by halving
  // the difference. Nothing in the export says so, so it is asserted here: an
  // export that padded a frame unevenly would slide that art by half
  // the error, silently, exactly as the map's node glow slid 29px off its node
  // before the halving existed at all.
  const pad = [];
  for (const [id, sprite] of Object.entries(sprites.sprites)) {
    for (let f = 1; f <= sprite.frames; f++) {
      const geom = sprite.geom[f - 1];
      if (!geom || geom.children.length !== 0) continue;   // SVG base art
      const file = join(ASSETS, "sprites", id, `${f}.${raster}`);
      if (!existsSync(file)) continue;                     // already reported
      const { width, height } = await sharp(file).metadata();
      const dw = width - geom.w, dh = height - geom.h;
      // one pixel of slack each way: the SVG canvas is fractional and the
      // raster's is whole, so an unpadded frame lands a fraction over
      if (dw < -1 || dh < -1 || Math.abs(dw - dh) > 1) {
        pad.push(`${id}/${f} (${dw.toFixed(1)} x ${dh.toFixed(1)})`);
      }
    }
  }
  check("every raster frame is its rect plus a uniform margin",
        pad.length === 0, pad.slice(0, 5).join(", "));

  const sounds = read("sounds.json");
  const lost = Object.entries(sounds).filter(([, where]) =>
    !existsSync(join(ASSETS, where.includes("/") ? where : `sounds_wav/${where}`)));
  check(`${Object.keys(sounds).length} sounds`, lost.length === 0,
        lost.map(([k]) => k).join(", "));

  // Button parts are checked against the SOURCE, not against the manifest.
  // Thirty of the seventy-five were never exported by `export_assets.py` in the
  // first place -- the buttons render correctly without them, and the renderer
  // skips a part whose image will not load -- so asserting the manifest is
  // complete would be asserting something that has never been true. What must
  // be true is that the build loses nothing the extraction produced.
  const buttons = read("buttons.json");
  const SOURCE = resolve(ROOT, "extracted/assets");
  const where = (id, g, ext) =>
    g.from === "sprite" ? `sprites/${id}/1.${ext}` : `parts/${id}.svg`;
  const entries = Object.entries(buttons.parts ?? {});
  const inSource = entries.filter(([id, g]) =>
    existsSync(join(SOURCE, where(id, g, "png"))));
  const dropped = inSource.filter(([id, g]) =>
    !existsSync(join(ASSETS, where(id, g, raster))));
  check(`${inSource.length} of ${entries.length} button parts survived the build`,
        dropped.length === 0, dropped.map(([id]) => id).join(", "));
  if (inSource.length !== entries.length) {
    console.log(`       ${entries.length - inSource.length} were never ` +
                `exported; the buttons draw correctly without them`);
  }
}

// ---- what a first visit costs ---------------------------------------------

console.log("\nthe download is the size it should be");
{
  // The landing page is budgeted on its own, with the landing stylesheets
  // (`base-*.js` whenever Rollup splits them out). It is lazy, and only a
  // signed-out visitor at the bare address downloads it -- a player never
  // does, so it would be wrong to let it eat the game's allowance, or to
  // raise the game's allowance to fit it.
  //
  // Guest play is not on this side any more. It used to be its own small page
  // (`guest-*.js`, sharing `base-*.js` with the landing page); since the guest
  // page was retired, a signed-out player at #/play runs the same play screen
  // as an account and downloads the game's own chunks. So guests are counted
  // by the game's budget below, and have a budget of their own after it for
  // the part of the game they actually fetch.
  const all = walk(join(DIST, "assets")).filter((p) => /\.(js|css)$/.test(p));
  const landing = all.filter((p) => /[\\/]landing-[\w-]+\.js$/.test(p));
  const signedOut = all.filter((p) => /[\\/](landing|base)-[\w-]+\.js$/.test(p));
  const code = all.filter((p) => !signedOut.includes(p));
  const bytes = code.reduce((n, p) => n + statSync(p).size, 0);
  // Audited networking rollout adds the runtime broker client, path manager,
  // presentation options and local QoE (~805 kB total in the enabled build).
  // The 17-improvement implementation adds bounded renderer/resource caches,
  // manifest preparation, coherent recovery and durable saving (~846 kB total).
  // Preserve a measured ceiling with20 kB headroom.
  // Quick Match adds the matchmaking flow, the card and its search animation
  // (~24 kB, ~884 kB total); the ceiling moves with it and keeps its headroom.
  // Keeping account code out of a guest's download (below) split it into more
  // chunks, at ~4 kB of import glue (~895 kB); the ceiling did not move.
  // The live keycaps, the stage glow, the toolbar emblem's hover and the
  // sliding character picker add ~15 kB (~910 kB); the ceiling moves to keep
  // its headroom.
  const BUDGET = 925_000;
  console.log(`  ${(bytes / 1000).toFixed(0)} kB of javascript and css ` +
              `across ${code.length} files`);
  check(`under the ${BUDGET / 1000} kB budget`, bytes < BUDGET,
        `${(bytes / 1000).toFixed(0)} kB`);

  // Markup, styles and behaviour of the whole page in one file (~82 kB with
  // its stylesheets, now that nothing else shares them).
  const LANDING_BUDGET = 100_000;
  const landingBytes = signedOut.reduce((n, p) => n + statSync(p).size, 0);
  check("the landing page is its own chunk", landing.length === 1,
        `${landing.length} files`);
  console.log(`  ${(landingBytes / 1000).toFixed(0)} kB for the landing page, ` +
              `fetched only by signed-out visitors`);
  check(`under its own ${LANDING_BUDGET / 1000} kB budget`,
        landingBytes < LANDING_BUDGET, `${(landingBytes / 1000).toFixed(0)} kB`);

  // What a signed-out visitor to #/play fetches: the entry and the play
  // screen, with everything they import statically -- the dynamic imports are
  // what a guest does NOT fetch, and they are the point. When guest play
  // first ran the account screen it fetched 888 kB, every chunk but the
  // landing and watch ones, because the play screen imported the lobby,
  // friends, Quick Match, the leaderboard and Settings, and the entry imported
  // the 217 kB Supabase client to boot. With those behind `import()` (online.ts
  // for the play screen, `loadClient` in auth.ts for the client) it is 587 kB,
  // under the ~760 kB of the old guest page. The ceiling keeps ~13 kB of
  // headroom; a static import that drags account code back in is far bigger.
  // Measured by reading the built chunks rather than a browser, so it holds
  // without one; app/test/play-guest.mjs is what proves a guest makes no
  // request to Supabase at run time.
  // The live keycaps, the glow and its switch, and the emblem's hover are
  // guest features too (~15 kB, ~601 kB); the ceiling moves with them, still
  // far below what one stray static import of account code would add.
  const GUEST_BUDGET = 615_000;
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  const entry = html.match(/<script type="module"[^>]*src="\/(assets\/index-[\w-]+\.js)"/)?.[1];
  const styles = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\/(assets\/[\w-]+\.css)"/g)].map((m) => m[1]);
  const play = all.filter((p) => /[\\/]play-[\w-]+\.js$/.test(p));
  /** A chunk and every chunk it imports statically, as Rollup writes them. */
  const closure = (file, seen = new Set()) => {
    if (seen.has(file)) return seen;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    // `import{a as b}from"./x.js"` and the bare `import"./x.js"`, but not
    // `import("./x.js")`, which is the dynamic kind.
    for (const m of text.matchAll(/\bimport\s*(?:[\w$*{},\s]+?\s*from\s*)?"\.\/([\w-]+\.js)"/g)) {
      closure(join(DIST, "assets", m[1]), seen);
    }
    return seen;
  };
  check("the entry and the play screen are where this expects", Boolean(entry) && play.length === 1,
        `entry ${entry}, ${play.length} play chunks`);
  if (entry && play.length === 1) {
    const guest = new Set([...closure(join(DIST, entry)), ...closure(play[0]),
                           ...styles.map((s) => join(DIST, s))]);
    const guestBytes = [...guest].reduce((n, p) => n + statSync(p).size, 0);
    console.log(`  ${(guestBytes / 1000).toFixed(0)} kB for a guest at #/play, ` +
                `across ${guest.size} files`);
    check(`under its own ${GUEST_BUDGET / 1000} kB budget`, guestBytes < GUEST_BUDGET,
          `${(guestBytes / 1000).toFixed(0)} kB`);
    // The same question asked by content rather than by size, so the answer
    // does not depend on a file name: supabase-js stamps every request with it.
    const client = [...guest].filter((p) => readFileSync(p, "utf8").includes("X-Client-Info"));
    check("and none of it is the Supabase client", client.length === 0,
          client.map((p) => p.slice(DIST.length + 1)).join(", "));
  }

  const assetBytes = walk(ASSETS).reduce((n, p) => n + statSync(p).size, 0);
  console.log(`  ${(assetBytes / 1e6).toFixed(1)} MB of art and audio, ` +
              `fetched only as levels need it`);
  check("the raw JPEXS intermediates are not in the build",
        !existsSync(join(ASSETS, "_raw")));
}

console.log("\nand search finds the landing page, not the game's art");
{
  // Indexing is on by choice: the bare address is the landing page. What is
  // kept out is the art extracted from the 2009 game, which the game fetches
  // and nobody reads.
  const robots = join(DIST, "robots.txt");
  check("robots.txt exists", existsSync(robots));
  if (existsSync(robots)) {
    const text = readFileSync(robots, "utf8");
    check("and does not disallow the whole site", !/Disallow:\s*\/\s*$/m.test(text));
    check("but does disallow the extracted art", /Disallow:\s*\/extracted\//m.test(text));
  }
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  check("the page does not ask not to be indexed", !/noindex/.test(html));
  check("and says what it is", /<meta name="description"/.test(html));
}

/*
 * What a reader that runs no script gets: crawlers and agents read the raw
 * HTML, and an agent asking for Markdown gets index.md (edge.mjs).
 */
console.log("\nand a reader that runs no script still gets the page");
{
  const text = (file) => readFileSync(file, "utf8")
    .replace(/<!--[\s\S]*?-->|<(script|style|noscript)\b[\s\S]*?<\/\1>|<head>[\s\S]*?<\/head>/g, "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  check("index.html has one <h1>", (html.match(/<h1\b/g) ?? []).length === 1);
  check("and 500+ characters of text without script", text(join(DIST, "index.html")).length >= 500,
        `${text(join(DIST, "index.html")).length} characters`);
  check("and links For Developers", /<a href="developers\/">/.test(html));
  const md = join(DIST, "index.md");
  check("index.md is the page as Markdown", existsSync(md) && /^# \S/.test(readFileSync(md, "utf8")));
  for (const name of ["about", "contact"]) {
    const path = join(DIST, `${name}.html`);
    check(`${name}.html has 500+ characters of its own`, existsSync(path) && text(path).length >= 500);
  }
  const llms = readFileSync(join(DIST, "llms.txt"), "utf8");
  check("llms.txt says when to use this site", llms.includes("## When to use this site"));
}

/*
 * The For Developers pages, built by design/landing/vite.config.mjs in ship
 * mode into dist/developers. Static pages under the same CSP as the app, so
 * the same rule as the 404 page: an inline script would be silently refused.
 */
console.log("\nand the For Developers pages are there and can run");
{
  for (const name of ["index", "netcode", "recovery", "architecture"]) {
    const path = join(DIST, "developers", `${name}.html`);
    check(`developers/${name}.html is in the build`, existsSync(path));
    if (!existsSync(path)) continue;
    const live = readFileSync(path, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    check("  with no inline script", !/<script\b(?![^>]*\bsrc=)/.test(live));
    check("  and nothing from another origin", !/(?:src|href)="https?:\/\//.test(live));
  }
}

/*
 * The page that has to work when nothing else did.
 *
 * `404.html` is copied out of `public/` and served by Cloudflare for any path that
 * matches nothing. It is checked here rather than trusted because everything
 * about it is easy to break silently: rename the file and the platform quietly
 * falls back to its own generic page, and nobody notices until somebody
 * mistypes a URL.
 *
 * The script assertion is the sharper one. The deployment's CSP allows
 * `script-src 'self'` with no `unsafe-inline`, so an inline script here would
 * be refused and do nothing -- the page would still LOOK fine, which is exactly
 * how it would survive review. Better to refuse to build.
 */
console.log("\nand there is a 404 page that can actually run");
{
  const path = join(DIST, "404.html");
  check("404.html is in the build", existsSync(path));
  if (existsSync(path)) {
    const page = readFileSync(path, "utf8");
    // Comments stripped first: the page EXPLAINS in prose that an inline
    // script would be refused, so those words appear in it legitimately and a
    // naive search finds them every time.
    const live = page.replace(/<!--[\s\S]*?-->/g, "");
    check("it carries no inline script the CSP would refuse",
          !/<script\b/.test(live));
    check("and nothing it needs comes from another origin",
          !/(?:src|href)="https?:\/\//.test(live));
    check("it offers a way back", /href="\/"/.test(live));
    check("and asks not to be indexed", /noindex/.test(page));
    // The CSP allows inline <style> by hash only, and this page's one block is
    // the hash it names. Edit the CSS without updating headers.json and the page
    // renders unstyled -- so the build refuses instead.
    const styles = [...live.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    const csp = JSON.parse(readFileSync(join(DIST, "..", "headers.json"), "utf8"))
      .headers.flatMap((h) => h.headers)
      .find((h) => h.key === "Content-Security-Policy")?.value ?? "";
    check("and its one <style> is the one the CSP names by hash",
          styles.length === 1 && csp.includes(
            `'sha256-${createHash("sha256").update(styles[0]).digest("base64")}'`));
  }
}

console.log("\n" + (failures === 0 ? "BUILD CHECK PASSED"
                                   : `BUILD CHECK FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
