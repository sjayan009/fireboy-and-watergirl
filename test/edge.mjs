/**
 * edge.mjs, the Worker in front of the static site, against a stand-in for
 * the asset layer: a Markdown 404 for agents that ask for it, the same 404
 * page for everybody else, and `Vary: Accept` on both.
 * The real routing (which requests reach it at all) is checked against the
 * deployment by app/test/deployed.mjs.
 */
import assert from "node:assert/strict";
import edge, { wantsMarkdown } from "../edge.mjs";

assert.equal(wantsMarkdown("text/markdown"), true);
assert.equal(wantsMarkdown("text/markdown, text/html;q=0.9"), true);
assert.equal(wantsMarkdown("text/html,application/xhtml+xml,*/*;q=0.8"), false);
assert.equal(wantsMarkdown("text/html, text/markdown;q=0.5"), false);
assert.equal(wantsMarkdown("text/markdown;q=0"), false);
assert.equal(wantsMarkdown(null), false);
assert.equal(wantsMarkdown("*/*"), false);

const SECURITY = { "Content-Security-Policy": "default-src 'self'", "Cache-Control": "public, max-age=0, must-revalidate" };
const files = {
  "/": ["<!doctype html><h1>page</h1>", "text/html"],
  "/index.md": ["# Page\n", "text/markdown"],
  "/404": ["<h1>404</h1>", "text/html"],
};
const env = {
  ASSETS: {
    async fetch(input) {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      // An unmatched path, with not_found_handling "none": empty, no `_headers`.
      if (!files[path]) return new Response(null, { status: 404 });
      const [body, type] = files[path];
      return new Response(body, { headers: { ...SECURITY, "Content-Type": type, ETag: '"x"' } });
    },
  },
};
const get = (path, accept, method = "GET") =>
  edge.fetch(new Request(`https://site.test${path}`, { method, headers: accept ? { Accept: accept } : {} }), env);

let r = await get("/no/such/room", "text/markdown");
assert.equal(r.status, 404);
assert.equal(r.headers.get("content-type"), "text/markdown; charset=utf-8");
assert.equal(r.headers.get("vary"), "Accept");
const body = await r.text();
assert.ok(body.length >= 20 && body.includes("(/llms.txt)") && body.includes("(/sitemap.xml)"));
assert.equal(r.headers.get("content-security-policy"), SECURITY["Content-Security-Policy"]);

r = await get("/no/such/room", "text/html");
assert.equal(r.status, 404);
assert.equal(r.headers.get("content-type"), "text/html");
assert.equal(r.headers.get("vary"), "Accept");
assert.equal(r.headers.get("content-security-policy"), SECURITY["Content-Security-Policy"]);
assert.equal(await r.text(), "<h1>404</h1>", "the same 404 page as before, with its status");

r = await get("/no/such/room", "text/markdown", "HEAD");
assert.equal(r.status, 404);
assert.equal(await r.text(), "");

// A file that exists never reaches it in production; if one did, it would be
// passed through untouched, whatever was asked for.
for (const accept of ["text/markdown", "text/html"]) {
  r = await get("/", accept);
  assert.equal(r.headers.get("content-type"), "text/html");
  assert.equal(r.headers.get("vary"), null);
}

console.log("edge: a Markdown 404 for agents, the 404 page for everybody else, Vary: Accept; files untouched");
