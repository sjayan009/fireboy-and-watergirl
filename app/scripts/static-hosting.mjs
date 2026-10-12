/**
 * Fail closed when a release adds a runtime, resource binding or alternate
 * environment beyond the one admitted: edge.mjs, which the asset layer invokes
 * only for paths that match no file, to answer them with a real 404 (in
 * Markdown for agents that ask). It has the ASSETS binding and nothing else,
 * and never runs first: a Worker in front of a page is a page somebody can
 * switch off by using up the free plan's daily requests.
 */
import assert from "node:assert/strict";

export function assertStaticHosting(config) {
  const keys = ["name", "account_id", "main", "compatibility_date", "workers_dev", "preview_urls", "assets"];
  assert.deepEqual(Object.keys(config).sort(), keys.sort(), "Static hosting permits no other runtime, bindings, environments or build hooks");
  assert.equal(config.name, "fireboy-and-watergirl");
  assert.equal(config.account_id, "592b20815b40026da0a5162992185d85");
  assert.equal(config.main, "edge.mjs", "The only Worker is the 404 responder");
  assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.assets, {
    directory: "./dist",
    binding: "ASSETS",
    html_handling: "auto-trailing-slash",
    not_found_handling: "none",
  }, "Only static dist assets; the Worker never runs first, and answers unmatched paths with real 404s");
}
