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
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const forbidden = [
    ["the secret key", env.SUPABASE_SECRET_KEY, /sb_secret_[A-Za-z0-9_-]{10,}/],
    ["the database password", env.SUPABASE_DB_PASSWORD, null],
    ["a service-role JWT", null, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ];

  // Source maps are shipped and are just as readable as the code.
  const text = walk(DIST).filter((p) =>
    /\.(js|css|html|map|json|txt)$/i.test(p));
  const hits = [];
  for (const file of text) {
    const body = readFileSync(file, "utf8");
    for (const [name, literal, shape] of forbidden) {
      if (literal && literal.length > 8 && body.includes(literal)) {
        hits.push(`${name} appears verbatim in ${file}`);
      } else if (shape && shape.test(body)) {
        hits.push(`something shaped like ${name} appears in ${file}`);
      }
    }
  }
  check(`${text.length} text files carry no secret`, hits.length === 0,
        hits.join("; "));

  // The one value that IS meant to be there, so a build that silently lost its
  // configuration fails here rather than in front of somebody.
  const bundles = text.filter((p) => p.endsWith(".js"));
  const configured = bundles.some((p) =>
    /sb_publishable_|supabase\.co/.test(readFileSync(p, "utf8")));
  check("but the project it talks to is configured", configured);
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
  const code = walk(join(DIST, "assets")).filter((p) => /\.(js|css)$/.test(p));
  const bytes = code.reduce((n, p) => n + statSync(p).size, 0);
  const BUDGET = 800_000;
  console.log(`  ${(bytes / 1000).toFixed(0)} kB of javascript and css ` +
              `across ${code.length} files`);
  check(`under the ${BUDGET / 1000} kB budget`, bytes < BUDGET,
        `${(bytes / 1000).toFixed(0)} kB`);

  const assetBytes = walk(ASSETS).reduce((n, p) => n + statSync(p).size, 0);
  console.log(`  ${(assetBytes / 1e6).toFixed(1)} MB of art and audio, ` +
              `fetched only as levels need it`);
  check("the raw JPEXS intermediates are not in the build",
        !existsSync(join(ASSETS, "_raw")));
}

console.log("\nand the deployment says it is not for indexing");
{
  const robots = join(DIST, "robots.txt");
  check("robots.txt exists", existsSync(robots));
  if (existsSync(robots)) {
    check("and disallows everything",
          /Disallow:\s*\/\s*$/m.test(readFileSync(robots, "utf8")));
  }
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  check("the page asks not to be indexed", /noindex/.test(html));
}

console.log("\n" + (failures === 0 ? "BUILD CHECK PASSED"
                                   : `BUILD CHECK FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
