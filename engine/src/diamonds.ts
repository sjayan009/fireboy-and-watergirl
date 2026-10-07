/**
 * Diamond collection regression test.
 *
 * This is the test that would have caught the transliterator bug where
 * `userData.name = "pers1"` was emitted as `= "this.pers1"`, because the
 * `this.` qualifier ran inside string literals. ContactListener compares
 * against "pers1", so nothing ever matched and no diamond was ever collected.
 *
 * It also pins down a quirk of the original that is easy to mistake for a bug:
 * the collected diamond's *sensor shape survives*. ContactListener runs inside
 * world.Step(), where b2World.m_lock is true, and b2Body.DestroyShape returns
 * early when the world is locked. The original game behaves identically -- it
 * relies on removeChild for the visual and on renaming the body to "FUCK" to
 * stop it being collected twice. So the display list, not the shape list, is
 * what says whether a diamond is gone.
 */
import { readFileSync } from "node:fs";
import { level } from "./game/game.js";
import { hostLevel } from "./game/headless.js";
import { b2Vec2 } from "./box2d/box2d.js";
import { Event, advanceTree } from "./flash/flash.js";
import type { Ported } from "./ported.js";

const LEVELS = new URL("../../extracted/levels/", import.meta.url);

function boot(mode: string, num: number): Ported {
  const lv = new (level as Ported)(mode, num);
  hostLevel(lv);
  return lv;
}

function step(lv: Ported, n = 6): void {
  for (let i = 0; i < n; i++) {
    advanceTree(lv);
    lv.Update(new Event(Event.ENTER_FRAME));
  }
}

/** Every diamond tile in a level, as [kind, col, row]. */
function diamondTiles(key: string): [string, number, number][] {
  const grid = JSON.parse(
    readFileSync(new URL(key + ".json", LEVELS), "utf8")).grid;
  const out: [string, number, number][] = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (typeof grid[r][c] === "string") out.push([grid[r][c], c, r]);
    }
  }
  return out;
}

const tiles = diamondTiles("adventure-01");
const red = tiles.filter((t) => t[0] === "rd");
const blue = tiles.filter((t) => t[0] === "bd");
console.log(`adventure-01 has ${red.length} red and ${blue.length} blue ` +
            `diamonds`);

let failures = 0;
function check(label: string, got: number | string | boolean, want: number | string | boolean): void {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${got}` +
              (ok ? "" : ` (expected ${want})`));
}

// --- the right character collects ----------------------------------------
{
  const lv = boot("adventure", 1);
  const [, cx, cy] = red[0];
  const before = lv.DiamondsandRopes.children.length;
  lv.pers1.SetXForm(new b2Vec2(cx, cy), 0);
  step(lv);
  console.log("\nFireboy onto a red diamond:");
  check("RedCount", lv.myContactListener.RedCount, 1);
  check("clip removed from display list",
        lv.DiamondsandRopes.children.length, before - 1);
  check("body renamed so it cannot re-collect",
        lv.myContactListener.RedCount, 1);
}

// --- the wrong character does not ----------------------------------------
{
  const lv = boot("adventure", 1);
  const [, cx, cy] = red[0];
  const before = lv.DiamondsandRopes.children.length;
  lv.pers2.SetXForm(new b2Vec2(cx, cy), 0);
  step(lv);
  console.log("\nWatergirl onto a RED diamond (should not collect):");
  check("RedCount", lv.myContactListener.RedCount, 0);
  check("BlueCount", lv.myContactListener.BlueCount, 0);
  check("clip still present",
        lv.DiamondsandRopes.children.length, before);
}

// --- and the blue one, the other way round -------------------------------
{
  const lv = boot("adventure", 1);
  const [, cx, cy] = blue[0];
  const before = lv.DiamondsandRopes.children.length;
  lv.pers2.SetXForm(new b2Vec2(cx, cy), 0);
  step(lv);
  console.log("\nWatergirl onto a blue diamond:");
  check("BlueCount", lv.myContactListener.BlueCount, 1);
  check("clip removed from display list",
        lv.DiamondsandRopes.children.length, before - 1);
}

// --- collecting twice must not double-count ------------------------------
{
  const lv = boot("adventure", 1);
  const [, cx, cy] = red[0];
  lv.pers1.SetXForm(new b2Vec2(cx, cy), 0);
  step(lv, 40);
  console.log("\nsitting on a collected diamond for 40 frames:");
  check("RedCount stays 1", lv.myContactListener.RedCount, 1);
}

// --- no string literal was mangled by the qualifier -----------------------
{
  const lv = boot("adventure", 1);
  console.log("\nbody userData names are the originals:");
  check("pers1", lv.pers1.GetUserData().name, "pers1");
  check("pers2", lv.pers2.GetUserData().name, "pers2");
  check("layer name", lv.DiamondsandRopes.name, "DiamondsandRopes");
}

console.log("\n" + (failures === 0 ? "DIAMONDS PASSED" : "DIAMONDS FAILED"));
process.exit(failures === 0 ? 0 : 1);
