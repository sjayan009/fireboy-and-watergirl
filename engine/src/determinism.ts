/**
 * Determinism regression test.
 *
 * Replays a fixed 600-frame input log and asserts the exact state digest. Any
 * change to the physics, the Flash shim, or the generated game code that
 * alters behaviour will move this hash -- which is the point. Update the
 * constant only when you have decided the new behaviour is correct.
 *
 * The same log and the same expected hash are used by the browser harness's
 * "Cross-engine check" button, so a browser that disagrees with this number
 * would desync from a peer running Node.
 */
import { readFileSync } from "node:fs";
import { level } from "./game/game.js";
import { hostLevel } from "./game/headless.js";
import { Event, advanceTree } from "./flash/flash.js";
import { hashLevel, applyInput } from "./net/hash.js";

const EXPECTED = "aba863c1";
const CHECKPOINTS: Record<number, string> = {
  100: "9d9213e4",
  200: "2578a018",
  300: "aba863c1",
};

const log = readFileSync(new URL("../scriptlog.txt", import.meta.url), "utf8");
const bits = log.trim().split(",").map(Number);

const lv: any = new (level as any)("adventure", 1);
// deadFire's frame script calls up into Game; give it something to reach.
const host = hostLevel(lv);
let bad = 0;
for (let i = 0; i < bits.length; i++) {
  applyInput(lv, bits[i]);
  advanceTree(lv);
  lv.Update(new Event(Event.ENTER_FRAME));
  const want = CHECKPOINTS[i + 1];
  if (want) {
    const got = hashLevel(lv);
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  frame ${String(i + 1).padStart(3)}: ${got} ` +
                (ok ? "ok" : `EXPECTED ${want}`));
  }
}

const final = hashLevel(lv);
const p1 = lv.pers1.GetPosition();
const p2 = lv.pers2.GetPosition();
console.log(`  final    : ${final} ` +
            (final === EXPECTED ? "ok" : `EXPECTED ${EXPECTED}`));
console.log(`  fire  ${p1.x.toFixed(6)}, ${p1.y.toFixed(6)}`);
console.log(`  water ${p2.x.toFixed(6)}, ${p2.y.toFixed(6)}`);

// Fireboy walks into water in this log, so deadFire's frame script must have
// run. It reaches up for a Game and calls GameOver(); until frame scripts were
// generalised beyond stop(), it silently never fired, which meant the death and
// results screens were unreachable no matter how well the shell was built.
const triggered = host.gameOvers > 0;
console.log(`death triggered GameOver  : ${triggered} ` +
            `(${host.gameOvers}x)`);

const pass = bad === 0 && final === EXPECTED && triggered;
console.log("\n" + (pass ? "DETERMINISM PASSED" : "DETERMINISM FAILED"));
process.exit(pass ? 0 : 1);
