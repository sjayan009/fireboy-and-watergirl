// The 13+ cut-off on the sign-up age screen (app/src/age.ts).
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../src/age.ts", import.meta.url))],
  bundle: true, format: "esm", write: false, platform: "neutral",
});
const { ageFrom, MIN_AGE } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const now = new Date(2026, 9, 6); // 6 October 2026
assert.equal(MIN_AGE, 13);
assert.equal(ageFrom(2013, 9, now), 13, "birthday last month: 13");
assert.equal(ageFrom(2013, 10, now), 12, "birthday this month counts as not yet had");
assert.equal(ageFrom(2013, 11, now), 12, "birthday next month: still 12");
assert.equal(ageFrom(2000, 1, now), 26);
console.log("age: ok");
