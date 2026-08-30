/**
 * Headless replay: `node dist/replay.js <mode> <level> <inputlog>`
 *
 * <inputlog> is a comma-separated list of the 6 input bits per frame, exactly
 * what the browser harness records. Prints the final state hash.
 *
 * This is the cross-machine determinism check: run the same log here and in a
 * browser (or on another machine) and compare the digests. Same digest means
 * the two would have stayed in lockstep.
 */
import { level } from "./game/game.js";
import { hostLevel } from "./game/headless.js";
import { Event, advanceTree } from "./flash/flash.js";
import { hashLevel, applyInput } from "./net/hash.js";

const [mode = "adventure", num = "1", log = ""] = process.argv.slice(2);
const bits = log ? log.split(",").map(Number) : [];

const lv: any = new (level as any)(mode, Number(num));
hostLevel(lv);
const marks: string[] = [];
for (let i = 0; i < bits.length; i++) {
  applyInput(lv, bits[i]);
  advanceTree(lv);
  lv.Update(new Event(Event.ENTER_FRAME));
  if ((i + 1) % 100 === 0) marks.push(`${i + 1}:${hashLevel(lv)}`);
}
const p1 = lv.pers1.GetPosition();
const p2 = lv.pers2.GetPosition();
console.log(`level     ${mode}-${num}`);
console.log(`frames    ${bits.length}`);
console.log(`fire      ${p1.x.toFixed(6)}, ${p1.y.toFixed(6)}`);
console.log(`water     ${p2.x.toFixed(6)}, ${p2.y.toFixed(6)}`);
if (marks.length) console.log(`checkpoints ${marks.join("  ")}`);
console.log(`hash      ${hashLevel(lv)}`);
