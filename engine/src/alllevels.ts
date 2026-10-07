/**
 * Boot every level in the ported engine, and drive one with input.
 *
 * Two things this proves that the single-level test does not:
 *  - all 32 levels construct and simulate without blowing up
 *  - the shape count agrees with the extracted tile grid, i.e. CreateGround
 *    read the same terrain we decoded independently
 *  - pressing a key actually moves a character
 */
import { readFileSync, readdirSync } from "node:fs";
import { level } from "./game/game.js";
import { hostLevel } from "./game/headless.js";
import { Event, advanceTree } from "./flash/flash.js";
import type { Ported } from "./ported.js";

const LEVELS = new URL("../../extracted/levels/", import.meta.url);

function boot(mode: string, num: number): Ported {
  const lv = new (level as Ported)(mode, num);
  hostLevel(lv);          // deadFire reaches for a Game above the level
  return lv;
}

function shapeCount(world: Ported): number {
  let n = 0;
  for (let b = world.GetBodyList(); b; b = b.GetNext()) {
    for (let s = b.GetShapeList(); s; s = s.GetNext()) n++;
  }
  return n;
}

function step(lv: Ported): void {
  advanceTree(lv);
  lv.Update(new Event(Event.ENTER_FRAME));
}

/** Tiles in the extracted grid that CreateGround turns into collision shapes. */
function solidTiles(grid: Ported[][]): number {
  let n = 0;
  for (const row of grid) {
    for (const v of row) {
      if (v === 1 || v === -1 || v === -2 || v === -3 || v === -4) n++;
    }
  }
  return n;
}

let failures = 0;
let booted = 0;
console.log("  level          rows  shapes  solid  fire spawn   water spawn");
console.log("  " + "-".repeat(64));

for (const file of readdirSync(LEVELS).sort()) {
  if (!file.endsWith(".json")) continue;
  const key = file.replace(/\.json$/, "");
  const [mode, numStr] = [key.slice(0, key.lastIndexOf("-")),
                          key.slice(key.lastIndexOf("-") + 1)];
  if (mode === "test") continue;
  const data = JSON.parse(readFileSync(new URL(file, LEVELS), "utf8"));

  try {
    const lv = boot(mode, Number(numStr));
    for (let i = 0; i < 40; i++) step(lv);
    const shapes = shapeCount(lv.m_world);
    const p1 = lv.pers1.GetPosition();
    const p2 = lv.pers2.GetPosition();
    const ok = Number.isFinite(p1.x) && Number.isFinite(p1.y) &&
               Number.isFinite(p2.x) && Number.isFinite(p2.y) &&
               shapes > 50 && lv.LevelArray.length === data.rows;
    if (!ok) failures++;
    booted++;
    console.log("  %s %s %s %s   %s %s  %s",
      (ok ? "ok  " : "FAIL") + " " + key.padEnd(13),
      String(lv.LevelArray.length).padStart(4),
      String(shapes).padStart(7),
      String(solidTiles(data.grid)).padStart(6),
      `(${lv.StartPosFire.x}, ${lv.StartPosFire.y})`.padEnd(11),
      `(${lv.StartPosWater.x}, ${lv.StartPosWater.y})`.padEnd(11),
      `${p1.x.toFixed(1)},${p1.y.toFixed(1)}`);
  } catch (e) {
    failures++;
    console.log("  FAIL %s  threw: %s", key, (e as Error).message);
  }
}

// --- does input actually move a character? -------------------------------
const lv = boot("adventure", 1);
for (let i = 0; i < 20; i++) step(lv);
const before = lv.pers1.GetPosition().x;
lv.r_pressed = true;                       // Fireboy: hold right
for (let i = 0; i < 40; i++) step(lv);
lv.r_pressed = false;
const afterRight = lv.pers1.GetPosition().x;
const watergirlStayed =
  Math.abs(lv.pers2.GetPosition().x - lv.StartPosWater.x) < 0.2;

console.log("");
console.log("levels booted            :", booted, "of 32");
console.log("failures                 :", failures);
console.log("fireboy moved right      :", afterRight > before + 0.5,
            `(${before.toFixed(3)} -> ${afterRight.toFixed(3)})`);
console.log("watergirl stayed put     :", watergirlStayed,
            "(independent inputs)");

const pass = failures === 0 && booted === 32 &&
             afterRight > before + 0.5 && watergirlStayed;
console.log("\n" + (pass ? "ALL LEVELS PASSED" : "ALL LEVELS FAILED"));
process.exit(pass ? 0 : 1);
