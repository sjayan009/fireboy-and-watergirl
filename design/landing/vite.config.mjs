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

const DEVELOPERS = {
  developers: resolve(HERE, "developers/index.html"),
  netcode: resolve(HERE, "developers/netcode.html"),
  recovery: resolve(HERE, "developers/recovery.html"),
  architecture: resolve(HERE, "developers/architecture.html"),
  privacy: resolve(HERE, "legal/privacy.html"),
  terms: resolve(HERE, "legal/terms.html"),
  about: resolve(HERE, "about.html"),
  contact: resolve(HERE, "contact.html"),
};

export default defineConfig(({ mode }) => ({
  root: HERE,
  // Module imports go through Vite's resolver, which never sees middleware, so
  // "/engine/..." is an alias for the import graph as well.
  resolve: { alias: [{ find: /^\/engine\//, replacement: resolve(ROOT, "engine/dist").replaceAll("\\", "/") + "/" }] },
  server: { fs: { allow: [ROOT] } },
  // `npx vite build design/landing`: the landing page and the For Developers
  // subsite only, into design/landing/dist, to preview on their own. The
  // exploration pages are not inputs, so they never ship.
  //
  // `--mode ship` (run by the app's build): the For Developers pages only,
  // into the app's own dist/developers. The landing page itself is not built
  // here in that mode: the app renders it at the site root. Their scripts and
  // styles go to dist/developers/assets, apart from the app's dist/assets and
  // its budget, and the Netcode page takes the game's art from the app's
  // dist/extracted, which the app build has already written.
  build: mode === "ship" ? {
    outDir: resolve(ROOT, "dist"),
    emptyOutDir: false,
    assetsDir: "developers/assets",
    rollupOptions: { input: DEVELOPERS },
  } : {
    outDir: resolve(HERE, "dist"),
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve(HERE, "index.html"), ...DEVELOPERS } },
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
}));
