/**
 * Does the world Box2D actually built cover every solid tile in the grid?
 *
 * This is the cross-check that matters most for the port: the level tables
 * were decoded by one program (tools/extract_levels.py) and turned into a
 * physics world by a completely different one (the transliterated
 * CreateGround). If they agree on all 32 levels, both are right.
 */
import { readFileSync, readdirSync } from "node:fs";
import { level } from "./game/game.js";
import { hostLevel } from "./game/headless.js";

const LEVELS = new URL("../../extracted/levels/", import.meta.url);
const SOLID = new Set([1, -1, -2, -3, -4]);

let checkedLevels = 0;
let totalMissing = 0;
const keys = readdirSync(LEVELS)
  .filter((f) => f.endsWith(".json") && !f.startsWith("test-"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

for (const key of keys) {
  const [mode, num] = [key.slice(0, key.lastIndexOf("-")),
                       Number(key.slice(key.lastIndexOf("-") + 1))];
  const grid = JSON.parse(readFileSync(new URL(key + ".json", LEVELS), "utf8")).grid;

  let lv: any, threw = "";
  try { lv = new (level as any)(mode, num); hostLevel(lv); }
  catch (e) { threw = (e as Error).message; }
  if (threw) { console.log(`${key}: constructor THREW: ${threw}`); continue; }

  // centroid of every static shape, snapped to the tile grid
  const covered = new Set<string>();
  for (let b = lv.m_world.GetBodyList(); b; b = b.GetNext()) {
    for (let s = b.GetShapeList(); s; s = s.GetNext()) {
      const poly: any = s;
      if (!poly.m_vertices || !poly.m_vertexCount) continue;
      let cx = 0, cy = 0;
      for (let i = 0; i < poly.m_vertexCount; i++) {
        cx += poly.m_vertices[i].x; cy += poly.m_vertices[i].y;
      }
      cx /= poly.m_vertexCount; cy /= poly.m_vertexCount;
      const p = b.GetPosition();
      covered.add(`${Math.round(cx + p.x)},${Math.round(cy + p.y)}`);
    }
  }

  let want = 0, missing = 0;
  let firstMissing = "";
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (!SOLID.has(grid[r][c])) continue;
      want++;
      if (!covered.has(`${c},${r}`)) {
        missing++;
        if (!firstMissing) firstMissing = `row ${r} col ${c}`;
      }
    }
  }
  checkedLevels++;
  totalMissing += missing;
  if (missing) {
    console.log(`  FAIL ${key}: ${missing} of ${want} solid tiles have no ` +
                `collision shape, first gap at ${firstMissing}`);
  }
}

console.log(`levels checked            : ${checkedLevels} of 32`);
console.log(`solid tiles without shape : ${totalMissing}`);
const pass = checkedLevels === 32 && totalMissing === 0;
console.log("\n" + (pass ? "COVERAGE PASSED" : "COVERAGE FAILED"));
process.exit(pass ? 0 : 1);
