/** Static Cloudflare packaging for Workers Assets and Pages. No runtime or paid storage. */
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { assertStaticHosting } from "./static-hosting.mjs";
const root = resolve(import.meta.dirname, "../..");
const dist = resolve(root, "dist");
assertStaticHosting(JSON.parse(await readFile(resolve(root, "wrangler.json"), "utf8")));
// Pages detects /functions at the PROJECT root, outside the static output.
for (const project of [root, resolve(root, "app")]) {
  if (existsSync(join(project, "functions"))) throw new Error("Pages Functions are prohibited in this static-only deployment");
}
const config = JSON.parse(await readFile(resolve(root, "headers.json"), "utf8"));
// The audited headers live in one source, headers.json, and ship as `_headers`.
const headers = config.headers.map(rule => rule.source.replace("(.*)", "*") + "\n" + rule.headers.map(h => `  ${h.key}: ${h.value}`).join("\n")).join("\n\n") + "\n";
await writeFile(join(dist, "_headers"), headers);
// Hash routing needs no redirect or server function. Root index.html is sufficient.
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Symlinks are not permitted in a static deployment");
    if (entry.isDirectory()) await walk(path);
    else files.push({ path: relative(dist,path).replaceAll("\\", "/"), bytes: (await stat(path)).size });
  }
}
await walk(dist);
if (files.length > 20000) throw new Error(`Pages Free file cap exceeded (${files.length}/20000): combine assets; do not upgrade or add paid storage`);
const oversized = files.filter(f => f.bytes > 25 * 1024 * 1024);
if (oversized.length) throw new Error("Pages 25 MiB asset cap exceeded: " + oversized.map(f => f.path).join(", "));
if (files.some(f => /^(_worker\.js(?:\/|$)|functions\/)/.test(f.path))) throw new Error("This deployment must contain static files only");
const total = files.reduce((n,f) => n + f.bytes,0);
console.log(`Cloudflare Free: ${files.length}/20000 files; ${total} bytes; largest ${Math.max(...files.map(f=>f.bytes))}/26214400 bytes; static only`);
