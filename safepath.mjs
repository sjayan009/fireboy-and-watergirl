/**
 * Turning a URL path into a file path that is definitely inside a directory.
 *
 * Three servers in this repository map requests onto disk -- `serve.mjs`,
 * the Vite plugin that serves `extracted/` in development, and the little CDN
 * stand-in `app/test/production.mjs` -- and all three had the same hole, in the
 * same shape:
 *
 *     const rel = url.split("/").filter((s) => s && s !== "..").join("/");
 *     const file = join(root, rel);
 *
 * That is a rule about `/`. On Windows `\` is a separator too, and none of
 * `split`, `filter` or `join` knows it -- so `..\` survives the filter intact
 * and `join` then honours it. `GET /..%5C.env.local` returned 200 and exactly
 * the byte count of `.env.local`, which on a development machine holds the
 * Supabase secret key and the database password. The Vite middleware had a
 * containment check and it was `file.startsWith(ROOT)`, which is a string
 * prefix and not a path: it kept the request inside the repository and said
 * nothing about staying under `extracted/`.
 *
 * So the mapping happens once, here, and the containment is decided by the
 * resolved paths rather than by editing the text on the way through. A string
 * that survives every check is still not trusted to be inside the root: the
 * last word belongs to `path.relative`, which either says the candidate is
 * below the root or it does not.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The path a request is asking for, relative to nothing yet.
 *
 * Returns null for anything that is not a plain absolute URL path: a malformed
 * percent escape (which `decodeURIComponent` throws on, and which used to take
 * the whole server down with it), a NUL, a backslash, a drive letter, or a
 * `..` segment. Rejecting `..` outright rather than resolving it away is
 * deliberate -- a legitimate asset request never contains one, so there is
 * nothing to be gained by working out where it would have landed.
 */
export function requestPath(url) {
  if (typeof url !== "string") return null;
  const [withoutFragment] = url.split("#");
  const [path] = withoutFragment.split("?");
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;                       // a stray % or a bad escape
  }
  // Both separators, before anything is split on one of them. `%5c` decodes to
  // a backslash, which is what made the encoded traversal work on Windows.
  if (decoded.includes("\\") || decoded.includes("\0")) return null;
  if (!decoded.startsWith("/")) return null;
  // `//host/share` is a UNC path once Windows sees it, and `C:` is a drive.
  if (decoded.startsWith("//")) return null;
  if (/^\/[A-Za-z]:/.test(decoded)) return null;

  const parts = decoded.split("/").filter((s) => s.length > 0);
  if (parts.some((s) => s === "." || s === "..")) return null;
  return parts;
}

/**
 * Where `url` lands under `root`, or null if it does not land under it.
 *
 * `path.relative` rather than `startsWith`, because a prefix test says yes to
 * `/srv/app-secrets` for a root of `/srv/app`.
 */
export function resolveUnder(root, url) {
  const parts = requestPath(url);
  if (parts === null) return null;
  const base = resolve(root);
  const candidate = resolve(base, ...parts);
  if (candidate === base) return candidate;
  const rel = relative(base, candidate);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) {
    return null;
  }
  return candidate;
}

/**
 * The same, for a request that is served from one of several roots depending on
 * its prefix.
 *
 * `mounts` is a list of `[prefix, root]`, longest prefix first, and the part of
 * the path after the prefix is what is resolved under that root. A request that
 * matches no prefix falls to `fallback`, which is the ordinary document root.
 */
export function resolveMounted(url, mounts, fallback) {
  const parts = requestPath(url);
  if (parts === null) return null;
  const path = "/" + parts.join("/");
  for (const [prefix, root] of mounts) {
    if (path === prefix || path.startsWith(prefix)) {
      return resolveUnder(root, "/" + path.slice(prefix.length));
    }
  }
  return resolveUnder(fallback, path);
}
