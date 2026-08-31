import { defineConfig, Plugin } from "vite";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
  return {
    __SUPABASE_URL__: JSON.stringify(pick("SUPABASE_URL")),
    __SUPABASE_KEY__: JSON.stringify(pick("SUPABASE_PUBLISHABLE_KEY")),
    // Empty unless somebody sets it. Public by nature -- a TURN credential is
    // handed to the browser to be used by the browser -- so it belongs with the
    // other two rather than anywhere near the secret key.
    __ICE_SERVERS__: JSON.stringify(pick("ICE_SERVERS")),
  };
}

/**
 * Serve the extracted art and audio from the repo root during development.
 *
 * They are 36 MB and they are not the app's, so they are neither copied into
 * `public/` nor imported: the dev server reads them where they live, and the
 * build copies them once into the output.
 */
function extractedAssets(): Plugin {
  return {
    name: "fbwg-extracted-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (!url.startsWith("/extracted/")) return next();
        // Keep the request inside the repo: drop any ".." segments.
        const rel = url.split("/").filter((s) => s && s !== "..").join("/");
        const file = resolve(ROOT, rel);
        if (!file.startsWith(ROOT) || !existsSync(file)) return next();
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

export default defineConfig({
  plugins: [extractedAssets()],
  define: publicEnv(),
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
    sourcemap: true,
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
});
