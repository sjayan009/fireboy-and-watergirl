/** Whitelist-only Actions artifact: assertion names, never raw browser logs. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const assertions = [];
const suites = [];
for (const path of process.argv.slice(2)) {
  let log;
  try { log = await readFile(path, "utf8"); } catch { continue; }
  for (const line of log.split(/\r?\n/)) {
    const failed = line.match(/^\s*FAIL ([A-Za-z0-9 ,.'()/-]{1,120})(?::|$)/);
    if (failed) assertions.push(failed[1]);
    const suite = line.match(/^([A-Z][A-Z ]{2,50}) FAILED(?: \([0-9]+\))?$/);
    if (suite) suites.push(suite[1]);
  }
}
const out = { commit: process.env.GITHUB_SHA ?? null,
  failingSuites: [...new Set(suites)], failingAssertions: [...new Set(assertions)] };
await mkdir(resolve("artifacts"), { recursive: true });
await writeFile(resolve("artifacts/full-browser-summary.json"), JSON.stringify(out, null, 2) + "\n");
