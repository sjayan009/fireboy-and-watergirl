/**
 * Joining an asset base to a path, when the base may carry a release marker.
 *
 * The extracted art and audio live at stable names -- `sprites.json`,
 * `sprites/42/1.webp` -- and the deployment serves them with a one-year
 * `immutable` cache policy. Those two facts were incompatible: `immutable`
 * tells a browser never to ask again, and the bytes behind a stable name change
 * whenever the extraction or the conversion does. A returning visitor could get
 * a new bundle against last year's manifest, for up to a year, with no way to
 * clear it but clearing their cache.
 *
 * The fix is to make the URL change when the assets do rather than to make the
 * caching weaker. The base the app hands in is
 * `/extracted/assets?v=<digest of the asset tree>`; a cache entry is keyed by
 * the whole URL, so a release with different assets asks a different question
 * and `immutable` becomes honest.
 *
 * That means the base is no longer something a template literal can simply
 * append to, which is what this is for. The engine's own harness still passes a
 * plain `/extracted/assets`, and that keeps working unchanged.
 */
export function assetUrl(base: string, path: string): string {
  const cut = base.indexOf("?");
  const root = (cut === -1 ? base : base.slice(0, cut)).replace(/\/+$/, "");
  const query = cut === -1 ? "" : base.slice(cut);
  return `${root}/${path.replace(/^\/+/, "")}${query}`;
}
