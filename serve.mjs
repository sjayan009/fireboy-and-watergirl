// Tiny static server: serves web/ at the root and engine/dist/ under /dist.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

// The cross-engine test runs its own instance on another port so it
// cannot collide with a dev server you already have open.
//
// FBWG_ASSETS points /extracted/assets at somewhere other than the repo, so the
// same tests can be run against the BUILT assets -- which is the only way to
// find out whether converting them to WebP changed what is drawn.
const PORT = Number(process.env.PORT) || 5173;
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".map": "application/json",
  ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".ttf": "font/ttf", ".woff2": "font/woff2",
};

createServer(async (req, res) => {
  // POST /snap/<name>.png -- lets the page hand a rendered canvas back to disk,
  // so a screenshot can be inspected even when the browser pane will not
  // composite frames for a normal screenshot.
  if (req.method === "POST" && (req.url || "").startsWith("/snap/")) {
    const name = (req.url.split("/").pop() || "snap.png").replace(/[^\w.-]/g, "");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir("snaps", { recursive: true });
    await writeFile(join("snaps", name), Buffer.concat(chunks));
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok " + name);
    return;
  }

  let url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (url === "/") url = "/index.html";
  // keep the request inside the project: drop any ".." segments
  const rel = "/" + url.split("/").filter((s) => s && s !== "..").join("/");
  const file = rel.startsWith("/dist/")
    ? join("engine", rel)
    : rel.startsWith("/extracted/assets/") && process.env.FBWG_ASSETS
      ? join(process.env.FBWG_ASSETS, rel.slice("/extracted/assets/".length))
    : rel.startsWith("/extracted/") ? join(".", rel) : join("web", rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found: " + file);
  }
}).listen(PORT, () => console.log("serving on http://localhost:" + PORT));
