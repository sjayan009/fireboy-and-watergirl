/** Fail closed when a release adds a runtime, resource binding or alternate environment. */
import assert from "node:assert/strict";

export function assertStaticHosting(config) {
  const keys = ["name", "account_id", "compatibility_date", "workers_dev", "preview_urls", "assets"];
  assert.deepEqual(Object.keys(config).sort(), keys.sort(), "Static hosting permits no runtime, bindings, environments or build hooks");
  assert.equal(config.name, "fireboy-and-watergirl");
  assert.equal(config.account_id, "592b20815b40026da0a5162992185d85");
  assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.assets, {
    directory: "./dist",
    html_handling: "auto-trailing-slash",
    not_found_handling: "404-page",
  }, "Only static dist assets and real 404s are allowed; no run_worker_first or binding");
}
