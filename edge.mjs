/**
 * The only code that runs in front of the static site, and only for a path
 * that matches no file. Every file that exists, the bare address included, is
 * served by the asset layer without invoking this, so it costs nothing and has
 * no daily limit (docs/HIGH_LEVEL/DEPLOYMENT.md).
 *
 * That is deliberate. Workers Free answers 429 once 100,000 invocations are
 * used in a day, so anything routed through here can be switched off for the
 * rest of the day by somebody with a loop. The front door is not: if this is
 * exhausted, only answers about pages that do not exist go with it.
 *
 * Its one job is the 404. A client that asks for `Accept: text/markdown` gets
 * one it can read; everybody else gets the 404 page, with its status, exactly
 * as before. Both carry `Vary: Accept`.
 *
 * The 404 page is served from here rather than by `not_found_handling:
 * "404-page"`: with that set, Cloudflare answers an unmatched path itself and
 * never invokes the Worker (measured under `wrangler dev`), so nobody could be
 * given the Markdown one.
 */

const NOT_FOUND = `# Not found

There is no page at this address on Fireboy & Watergirl: The Forest Temple, online co-op.

- [Home](/) (the game's landing page, also available as [Markdown](/index.md))
- [llms.txt](/llms.txt): every page on this site, with what it is for
- [Sitemap](/sitemap.xml)
`;

/** Whether `accept` ranks text/markdown at least as high as text/html. */
export function wantsMarkdown(accept) {
  let md = 0, html = 0;
  for (const part of (accept ?? "").toLowerCase().split(",")) {
    const [type, ...params] = part.split(";").map((s) => s.trim());
    const q = params.find((p) => p.startsWith("q="));
    const weight = q ? Number(q.slice(2)) : 1;
    if (!(weight > 0)) continue;
    if (type === "text/markdown") md = Math.max(md, weight);
    if (type === "text/html") html = Math.max(html, weight);
  }
  return md > 0 && md >= html;
}

export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) return res;
    // The same headers the 404 page would have had (CSP, HSTS, ...), from the
    // 404 page itself: the empty miss carries none of `_headers`' rules.
    const page = await env.ASSETS.fetch(new URL("/404", request.url));
    const headers = new Headers(page.headers);
    headers.append("Vary", "Accept");
    if (!wantsMarkdown(request.headers.get("Accept"))) {
      return new Response(page.body, { status: 404, headers });
    }
    headers.set("Content-Type", "text/markdown; charset=utf-8");
    for (const h of ["Content-Length", "ETag", "Last-Modified"]) headers.delete(h);
    return new Response(request.method === "HEAD" ? null : NOT_FOUND, { status: 404, headers });
  },
};
