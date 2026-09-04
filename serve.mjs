// Tiny static server: serves web/ at the root and engine/dist/ under /dist.
//
// It is a development and test helper and now says so in the only way that
// matters. Three things changed after an audit found it handing out the
// repository:
//
//   * `GET /..%5C.env.local` returned 200 and the whole file. The path was
//     filtered for `..` as a `/`-separated segment and then handed to
//     `path.join`, which on Windows honours `\` as a separator too -- so the
//     encoded backslash walked straight out of `web/` and into a file holding
//     the Supabase secret key and the database password. `safepath.mjs` now
//     owns that mapping for every server in the repository.
//   * `listen()` had no host, so Node bound the unspecified address and a
//     "local" helper was reachable from the network. It is loopback now.
//   * `GET /%` threw a URIError out of the request handler -- outside the
//     `try` around the file read -- and took the process with it. One
//     malformed request stopped the server.
//
// The snapshot upload is off unless it is asked for. It wrote whatever anybody
// posted, of any size, with no authentication at all.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requestPath, resolveMounted } from "./safepath.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));

// The cross-engine test runs its own instance on another port so it
// cannot collide with a dev server you already have open.
//
// FBWG_ASSETS points /extracted/assets at somewhere other than the repo, so the
// same tests can be run against the BUILT assets -- which is the only way to
// find out whether converting them to WebP changed what is drawn.
const PORT = Number(process.env.PORT) || 5173;
// Loopback unless somebody deliberately asks otherwise, which is the opposite
// of what an absent argument used to mean.
const HOST = process.env.FBWG_HOST || "127.0.0.1";
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".map": "application/json",
  ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".ttf": "font/ttf", ".woff2": "font/woff2",
};

/**
 * Where a request may read from, longest prefix first.
 *
 * Each root is a directory the request is resolved UNDER rather than a string
 * the result is compared against, so `/extracted/../web` cannot be talked into
 * being an extracted asset.
 */
const MOUNTS = [
  ["/dist/", join(ROOT, "engine/dist")],
  ...(process.env.FBWG_ASSETS
    ? [["/extracted/assets/", resolve(process.env.FBWG_ASSETS)]]
    : []),
  ["/extracted/", join(ROOT, "extracted")],
];
const DOCROOT = join(ROOT, "web");

/**
 * The screenshot sink, off by default.
 *
 * It let the page hand a rendered canvas back to disk, so a frame could be
 * inspected even when the browser pane would not composite one for a normal
 * screenshot. Useful, and an unauthenticated unbounded write to the working
 * directory: `FBWG_SNAP=1` turns it on, and the run prints a token the request
 * has to carry, so it is the process that started the server which can write
 * rather than anything that can reach the port.
 */
const SNAP = process.env.FBWG_SNAP === "1";
const SNAP_TOKEN = SNAP ? randomBytes(16).toString("hex") : null;
const SNAP_LIMIT = 8 * 1024 * 1024;

function fail(res, code, why) {
  res.writeHead(code, { "content-type": "text/plain" });
  res.end(why);
}

/**
 * Read at most `limit` bytes, and hang up rather than buffer more.
 *
 * The old version pushed every chunk onto an array until the client stopped
 * sending, which for a chunked body with no end is a memory limit and then a
 * disk one.
 */
async function bodyWithin(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) {
      req.destroy();
      return null;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  // POST /snap/<name>.png?t=<token>
  if (req.method === "POST" && (req.url || "").startsWith("/snap/")) {
    if (!SNAP) return fail(res, 404, "snapshots are off; set FBWG_SNAP=1");
    const query = new URLSearchParams((req.url.split("?")[1] ?? ""));
    if (query.get("t") !== SNAP_TOKEN) return fail(res, 403, "wrong token");
    const parts = (req.url.split("?")[0] || "").split("/");
    const name = (parts.pop() || "snap.png").replace(/[^\w.-]/g, "");
    if (!name.endsWith(".png")) return fail(res, 400, "png only");
    const body = await bodyWithin(req, SNAP_LIMIT);
    if (body === null) return fail(res, 413, "too big");
    const { writeFile, mkdir } = await import("node:fs/promises");
    const dir = join(ROOT, "snaps");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), body);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok " + name);
    return;
  }

  // Decoded and contained in one place, and before anything can throw out of
  // this handler: a bad escape is a 400 rather than the end of the process.
  //
  // The index substitution is decided on the PATH, not on the raw request line.
  // `/?room=direct` is the harness's own way of naming a netplay room, and
  // comparing the whole URL against "/" sent it looking for a file called
  // `?room=direct`.
  const parts = requestPath(req.url) ?? null;
  if (parts === null) return fail(res, 400, "not a path this server will map");
  const asked = "/" + (parts.length === 0 ? ["index.html"] : parts).join("/");
  const file = resolveMounted(asked, MOUNTS, DOCROOT);
  if (file === null) return fail(res, 400, "not a path this server will map");

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    fail(res, 404, "not found");
  }
});

// A slow or stalled request must not be able to hold a socket open forever.
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;

server.listen(PORT, HOST, () => {
  console.log(`serving on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (SNAP) console.log(`snapshots on, token ${SNAP_TOKEN}`);
});
