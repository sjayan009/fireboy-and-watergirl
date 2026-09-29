// Builds the Watch panel's finish: both players are placed on the exit ledge of
// Adventure 1, then walk to their own doors. Everything after the placement is
// the real game: the doors open under the players, and when both are fully
// open the engine hides them and plays the stairs clips (game.ts ~2090).
//
// Writes assets/watch-finish.json: { place, bits }. The page replays it through
// LevelHost, the production stepper, so the same inputs give the same frames.
import { LevelHost } from "../../../engine/dist/net/levelhost.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLACE = { fire: [16.6, 3.6], water: [20.3, 3.6] };   // Box2D units (x20 = level px); left of the red and blue diamonds
const DOORS = { fire: 32, water: 35 };                       // finish1.x / finish2.x, /20
const MAX = 200;

function place(sim) {
  for (const [who, [x, y]] of [["pers1", PLACE.fire], ["pers2", PLACE.water]]) {
    const body = sim.lv[who];
    const p = body.GetPosition();
    p.x = x; p.y = y;
    body.SetXForm(p, 0);
  }
}

const sim = new LevelHost();
sim.start("adventure", 1);
place(sim);
const bits = [];
let doneAt = -1;
for (let f = 0; f < MAX; f++) {
  const fx = sim.lv.pers1.GetPosition().x, wx = sim.lv.pers2.GetPosition().x;
  // Watergirl leads, so she crosses his door before he reaches it and the two
  // never overlap; each stops on their own door.
  let b = 0;
  if (f >= 18 && fx < DOORS.fire - 0.15) b |= 2;
  if (f >= 4 && wx < DOORS.water - 0.15) b |= 16;
  bits.push(b);
  sim.step(b, f, true);
  const cl = sim.lv.myContactListener;
  if (cl.deadFire || cl.deadWater) throw new Error(`a player died at frame ${f}`);
  if (sim.lv.ended && doneAt < 0) doneAt = f;
  if (f % 10 === 0 || (doneAt >= 0 && f === doneAt)) {
    const a = sim.lv.pers1.GetPosition(), w = sim.lv.pers2.GetPosition();
    console.log(f, "gems R/B", sim.lv.RDcount | 0, sim.lv.BDcount | 0, "fire", a.x.toFixed(2), a.y.toFixed(2), "water", w.x.toFixed(2), w.y.toFixed(2), "doors", sim.lv.SlidersAndRots.getChildByName("finish1").currentFrame, sim.lv.SlidersAndRots.getChildByName("finish2").currentFrame, sim.lv.ended ? "ENDED" : "");
  }
  if (doneAt >= 0 && f >= doneAt + 40) break;     // let the stairs clips play out
}
if (doneAt < 0) throw new Error("the level never ended");
writeFileSync(fileURLToPath(new URL("../assets/watch-finish.json", import.meta.url)), JSON.stringify({ level: ["adventure", 1], place: PLACE, endedAt: doneAt, bits }));
console.log("ended at frame", doneAt, "of", bits.length);
