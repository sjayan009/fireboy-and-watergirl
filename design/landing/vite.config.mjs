// Design server config: lets the landing concepts run the real engine.
//
//   /engine/*     -> engine/dist (the compiled engine, as the app uses it)
//   /extracted/*  -> extracted/  (the SWF's art, as the engine expects it)
//
// Development only. A shipped landing page would take these from the app's
// own build (app/scripts/assets.mjs), not from the repository tree.
import { defineConfig } from "vite";
import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../..");
const TYPES = { ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ttf": "font/ttf", ".map": "application/json" };

/** Serve `dir` at `prefix`, refusing anything that resolves outside it. */
function mount(prefix, dir) {
  const base = resolve(ROOT, dir);
  return (req, res, next) => {
    if (!req.url.startsWith(prefix + "/")) return next();
    let rel;
    try { rel = decodeURIComponent(req.url.slice(prefix.length + 1).split("?")[0]); } catch { res.statusCode = 400; return res.end(); }
    const file = resolve(base, rel);
    if (file !== base && !file.startsWith(base + sep)) { res.statusCode = 403; return res.end(); }
    let st;
    try { st = statSync(file); } catch { return next(); }
    if (!st.isFile()) return next();
    res.setHeader("Content-Type", TYPES[extname(file)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    createReadStream(file).pipe(res);
  };
}

export default defineConfig({
  root: HERE,
  // Module imports go through Vite's resolver, which never sees middleware, so
  // "/engine/..." is an alias for the import graph as well.
  resolve: { alias: [{ find: /^\/engine\//, replacement: resolve(ROOT, "engine/dist").replaceAll("\\", "/") + "/" }] },
  server: { fs: { allow: [ROOT] } },
  // `npx vite build design/landing`: the landing page and the For Developers
  // subsite only. The exploration pages are not inputs, so they never ship.
  // The Netcode page still fetches /extracted/assets at run time; wherever this
  // is hosted must serve those, as the app's own build does.
  build: {
    outDir: resolve(HERE, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(HERE, "index.html"),
        developers: resolve(HERE, "developers/index.html"),
        netcode: resolve(HERE, "developers/netcode.html"),
        recovery: resolve(HERE, "developers/recovery.html"),
        architecture: resolve(HERE, "developers/architecture.html"),
      },
    },
  },
  plugins: [{
    name: "engine-and-art",
    configureServer(server) {
      server.middlewares.use(mount("/engine", "engine/dist"));
      server.middlewares.use(mount("/extracted", "extracted"));
    },
    // `vite preview` of the build: the Netcode page's engine still fetches the
    // game's art from /extracted at run time.
    configurePreviewServer(server) {
      server.middlewares.use(mount("/extracted", "extracted"));
    },
  }],
});
