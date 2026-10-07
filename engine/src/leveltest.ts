/**
 * Boot a real level from the ported game code and step it.
 *
 * The `level` constructor is the one transliterated straight out of the SWF,
 * so this exercises the whole chain at once: the hardcoded level tables, the
 * Create* factories, Box2D, the Flash shim scene graph and ContactListener.
 */
import { level } from "./game/game.js";
import { hostLevel } from "./game/headless.js";
import { Event, advanceTree } from "./flash/flash.js";
import type { Ported } from "./ported.js";

function boot(mode: string, num: number): Ported {
  const lv = new (level as Ported)(mode, num);
  hostLevel(lv);
  return lv;
}

function bodyCount(world: Ported): number {
  let n = 0;
  for (let b = world.GetBodyList(); b; b = b.GetNext()) n++;
  return n;
}

/**
 * CreateGround builds ONE static body carrying a shape per terrain tile, so
 * shape count -- not body count -- is what tells us the level geometry loaded.
 */
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

/** Positions of both characters after `steps` frames. */
function trace(mode: string, num: number, steps: number): number[][] {
  const lv = boot(mode, num);
  const out: number[][] = [];
  for (let i = 0; i < steps; i++) {
    step(lv);
    const p1 = lv.pers1.GetPosition();
    const p2 = lv.pers2.GetPosition();
    out.push([p1.x, p1.y, p2.x, p2.y]);
  }
  return out;
}

const lv = boot("adventure", 1);
console.log("level constructed:", lv.constructor.name);
console.log("  CurrentMode / CurrentLevel :", lv.CurrentMode, lv.CurrentLevel);
console.log("  LevelArray                 :",
            lv.LevelArray.length, "rows x", lv.LevelArray[0].length, "cols");
console.log("  bodies in world            :", bodyCount(lv.m_world));
console.log("  collision shapes           :", shapeCount(lv.m_world));
console.log("  fire spawn                 :",
            lv.StartPosFire.x, lv.StartPosFire.y);
console.log("  water spawn                :",
            lv.StartPosWater.x, lv.StartPosWater.y);
console.log("  levers / pushers / winds   :",
            lv.myLevers.length, lv.myPushers.length, lv.myWinds.length);
console.log("  scene graph children       :", lv.children.length);

const p1a = lv.pers1.GetPosition();
const p2a = lv.pers2.GetPosition();
console.log("  fireboy   starts at        :",
            p1a.x.toFixed(3), p1a.y.toFixed(3));
console.log("  watergirl starts at        :",
            p2a.x.toFixed(3), p2a.y.toFixed(3));

const STEPS = 120;
const a = trace("adventure", 1, STEPS);
const b = trace("adventure", 1, STEPS);

const f = (r: number[]) =>
  `fireboy(${r[0].toFixed(4)}, ${r[1].toFixed(4)}) ` +
  `watergirl(${r[2].toFixed(4)}, ${r[3].toFixed(4)})`;
console.log("\nafter   1 frame :", f(a[0]));
console.log("after  30 frames:", f(a[29]));
console.log("after 120 frames:", f(a[STEPS - 1]));

let firstDiff = -1;
for (let i = 0; i < STEPS && firstDiff < 0; i++) {
  for (let j = 0; j < a[i].length; j++) {
    if (a[i][j] !== b[i][j]) { firstDiff = i; break; }
  }
}

const end = a[STEPS - 1];
const finite = end.every(Number.isFinite);
// they spawn in mid-air on the left and should land, not fall out of the world
const settled = Math.abs(end[1] - a[STEPS - 20][1]) < 0.05 &&
                Math.abs(end[3] - a[STEPS - 20][3]) < 0.05;
const inBounds = end.every((v) => v > -50 && v < 50);

console.log("");
console.log("terrain shapes built    :", shapeCount(lv.m_world) > 100,
            `(${shapeCount(lv.m_world)} shapes across ` +
            `${bodyCount(lv.m_world)} bodies)`);
console.log("values finite           :", finite);
console.log("in world bounds         :", inBounds);
console.log("characters came to rest :", settled);
console.log("run-to-run identical    :", firstDiff === -1,
            firstDiff === -1 ? "" : `(diverged at step ${firstDiff})`);

const pass = shapeCount(lv.m_world) > 100 && finite && inBounds && settled &&
             firstDiff === -1;
console.log("\n" + (pass ? "LEVEL TEST PASSED" : "LEVEL TEST FAILED"));
process.exit(pass ? 0 : 1);
