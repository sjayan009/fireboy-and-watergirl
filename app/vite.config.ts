import { defineConfig, Plugin } from "vite";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUnder } from "../safepath.mjs";
import { assetRelease } from "./scripts/release.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/**
 * The two values the browser is allowed to know, and nothing else.
 *
 * `.env.local` at the repo root also holds the secret key and the database
 * password. Vite's own `VITE_` convention would be enough to keep them out, but
 * a convention is a thing somebody can rename around: naming the two public
 * values explicitly means a secret cannot reach the bundle even if it is
 * mis-prefixed one day. Real environment variables win, which is how Vercel
 * supplies them.
 */
function publicEnv(): Record<string, string> {
  const file: Record<string, string> = {};
  const path = resolve(ROOT, ".env.local");
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) file[m[1]] = m[2].trim();
    }
  }
  const pick = (name: string) => process.env[name] ?? file[name] ?? "";
  /**
   * A build that has no project to talk to, and is honest about it.
   *
   * Pull requests from forks and Dependabot get no repository secrets, so the
   * build substituted empty strings and `check.mjs` then failed for the absence
   * it had just created. Placeholders make that run buildable and checkable
   * without pretending it is configured -- and they only appear when something
   * asks for them, so a real deploy that has genuinely lost its configuration
   * still fails rather than shipping a bundle pointed at nowhere.
   */
  const placeholder = process.env.FBWG_PLACEHOLDER_ENV === "1";
  const url = pick("SUPABASE_URL") ||
    (placeholder ? "https://placeholder.supabase.co" : "");
  const key = pick("SUPABASE_PUBLISHABLE_KEY") ||
    (placeholder ? "sb_publishable_placeholder_not_a_real_project" : "");
  return {
    __SUPABASE_URL__: JSON.stringify(url),
    __SUPABASE_KEY__: JSON.stringify(key),
    // Empty unless somebody sets it. Public by nature -- a TURN credential is
    // handed to the browser to be used by the browser -- so it belongs with the
    // other two rather than anywhere near the secret key.
    __ICE_SERVERS__: JSON.stringify(pick("ICE_SERVERS")),
  };
}

/**
 * Where the browser asks for the extracted art and audio.
 *
 * Stable paths with a release marker on the query, rather than stable paths on
 * their own: the deployment caches this subtree for a year as `immutable`, and
 * a cache entry is keyed by the whole URL. See `app/scripts/release.mjs` for
 * what the marker is derived from and why. Development gets the bare path --
 * there is no CDN in front of it and nothing to invalidate.
 */
function assetBase(dev: boolean): string {
  if (dev) return "/extracted/assets";
  return `/extracted/assets?v=${assetRelease(resolve(ROOT, "extracted/assets"))}`;
}

/**
 * Serve the extracted art and audio from the repo root during development.
 *
 * They are 36 MB and they are not the app's, so they are neither copied into
 * `public/` nor imported: the dev server reads them where they live, and the
 * build copies them once into the output.
 *
 * The containment used to be `file.startsWith(ROOT)`, which is two mistakes in
 * one expression. It is a string prefix rather than a path comparison, and the
 * root it compares against is the REPOSITORY rather than `extracted/` -- so
 * `/extracted/..\.env.local` was inside the root, was therefore allowed, and
 * returned the file holding the secret key. `safepath.mjs` resolves the request
 * under `extracted/` itself and decides containment with `path.relative`, so
 * neither separator nor prefix confusion has anywhere to go.
 */
function extractedAssets(): Plugin {
  const EXTRACTED = resolve(ROOT, "extracted");
  return {
    name: "fbwg-extracted-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.split("?")[0].startsWith("/extracted/")) return next();
        const file = resolveUnder(
          EXTRACTED, url.replace(/^\/extracted/, "") || "/");
        if (file === null) { res.statusCode = 400; res.end("no"); return; }
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        const type = {
          ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json",
          ".mp3": "audio/mpeg", ".wav": "audio/wav", ".webp": "image/webp",
          ".ttf": "font/ttf", ".woff2": "font/woff2",
        }[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";
        res.setHeader("content-type", type);
        res.end(readFileSync(file));
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [extractedAssets()],
  define: {
    ...publicEnv(),
    __ASSETS__: JSON.stringify(assetBase(command === "serve")),
  },
  resolve: {
    // The compiled engine, so the app gets its types as well as its code.
    // `npm run build` at the repo root builds the engine first.
    alias: { "@engine": resolve(ROOT, "engine/dist") },
  },
  build: {
    /**
     * The repository root's `dist/`, not `app/dist`.
     *
     * The deploy looks for an output directory named `dist` relative to the
     * project root, and the project root is the repository. Pointing
     * `outputDirectory` at `app/dist` in vercel.json did not survive that --
     * the build produced 27 MB in the right place and the deploy looked in
     * another one. Building where the DEFAULT already looks removes a setting
     * that has to be right rather than making it right.
     */
    outDir: resolve(ROOT, "dist"),
    emptyOutDir: true,
    target: "es2022",
    /**
     * No source maps in the deployed build.
     *
     * They were shipped, and a shipped source map is the source: the whole app,
     * unminified, with its comments, served from a static origin that anybody
     * who has the URL can read. This deployment ships art extracted from a 2009
     * commercial game and is meant not to be public, so handing out the source
     * alongside it is the same decision made twice by accident.
     *
     * A local `npm run dev` is unaffected -- Vite always maps in development --
     * and `FBWG_SOURCEMAPS=1` puts them back for a build somebody actually
     * wants to debug.
     */
    sourcemap: process.env.FBWG_SOURCEMAPS === "1",
    rollupOptions: {
      output: {
        // The engine is most of the bundle and changes far less often than the
        // app around it, so it gets its own long-lived chunk.
        manualChunks(id) {
          if (id.includes("engine/dist")) return "engine";
          if (id.includes("@supabase")) return "supabase";
        },
      },
    },
  },
  server: { port: 5174 },
}));
