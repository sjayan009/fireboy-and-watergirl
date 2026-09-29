// Tunes the netcode demo's input script against the real level-1 physics,
// stepping with LevelHost exactly as the netplay session (and the page) does.
//
//   FR/FS  Fireboy runs from FR until FS, jumps at FJ
//   WR/WS  Watergirl runs from WR until WS, jumps at WJ and WJ+1
//   node design/landing/tools/tune.mjs            prints every 4th frame and 100..130
import { LevelHost } from "../../../engine/dist/net/levelhost.js";

const env = (k, d) => Number(process.env[k] ?? d);
const FR = env("FR", 12), FS = env("FS", 122), FJ = env("FJ", 104);
const WR = env("WR", 48), WS = env("WS", 132), WJ = env("WJ", 108);
const bits = (f) => (f >= FR && f < FS ? 2 : 0) | (f === FJ ? 4 : 0) | (f >= WR && f < WS ? 16 : 0) | (f === WJ || f === WJ + 1 ? 32 : 0);
const px = (p) => [Math.round(p.x * 16 + 16), Math.round(p.y * 16 + 16)];

const sim = new LevelHost();
sim.start("adventure", 1);
let fireDied = -1, waterDied = -1;
for (let f = 0; f <= 170; f++) {
  sim.step(bits(f), f, true);
  const cl = sim.lv.myContactListener;
  if (cl.deadFire && fireDied < 0) fireDied = f;
  if (cl.deadWater && waterDied < 0) waterDied = f;
  if (process.env.QUIET) continue;
  if (f % 8 === 0 || (f >= 96 && f <= 130)) console.log(f, "fire", px(sim.lv.pers1.GetPosition()), "water", px(sim.lv.pers2.GetPosition()));
}
console.log(JSON.stringify({ FR, FJ, FS, WR, WJ, WS, fireDied, waterDied, fire: px(sim.lv.pers1.GetPosition()), water: px(sim.lv.pers2.GetPosition()) }));
