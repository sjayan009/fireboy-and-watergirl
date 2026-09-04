import { detSin, detCos, detAtan2, detAcos, detPow } from
  "./box2d/dettrig.js";

function ulpErr(a: number, b: number): number {
  if (a === b) return 0;
  const scale = Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
  return Math.abs(a - b) / (scale * Number.EPSILON);
}

let worstSin = 0, worstCos = 0, worstAtan2 = 0;
let wsAt = 0, wcAt = 0;
for (let i = 0; i < 400000; i++) {
  // angles in the range a rotating body actually reaches, plus extremes
  const x = (i % 2 === 0)
    ? (i / 400000) * 40 - 20
    : (i / 400000) * 2000 - 1000;
  const es = ulpErr(detSin(x), Math.sin(x));
  const ec = ulpErr(detCos(x), Math.cos(x));
  if (es > worstSin) { worstSin = es; wsAt = x; }
  if (ec > worstCos) { worstCos = ec; wcAt = x; }
}
for (let i = 0; i < 200000; i++) {
  const y = Math.sin(i * 0.7) * (1 + (i % 97));
  const x = Math.cos(i * 1.3) * (1 + (i % 89));
  worstAtan2 = Math.max(worstAtan2, ulpErr(detAtan2(y, x), Math.atan2(y, x)));
}

console.log("max ulp error vs Math.sin  :", worstSin.toFixed(3), "at x =", wsAt.toFixed(4));
console.log("max ulp error vs Math.cos  :", worstCos.toFixed(3), "at x =", wcAt.toFixed(4));
console.log("max ulp error vs Math.atan2:", worstAtan2.toFixed(3));

// sign / edge conventions must match Math.atan2 exactly
const edges: [number, number][] = [
  [0, 1], [0, -1], [-0, 1], [-0, -1], [1, 0], [-1, 0], [0, 0], [-0, -0],
  [Infinity, Infinity], [-Infinity, 1], [1, -Infinity], [3, 4], [-3, -4],
];
let edgeOk = true;
for (const [y, x] of edges) {
  const got = detAtan2(y, x), want = Math.atan2(y, x);
  if (!Object.is(got, want) && !(Math.abs(got - want) < 1e-15)) {
    console.log("  edge mismatch atan2(", y, ",", x, ") got", got, "want", want);
    edgeOk = false;
  }
}
console.log("atan2 edge cases match     :", edgeOk);

// acos feeds SetXForm in CreatRoman, so its result is a physics body angle and
// lands in the state digest. Sweep the whole domain, and lean on the endpoints
// where sqrt(1 - x^2) would have cancelled.
let worstAcos = 0, waAt = 0;
for (let i = 0; i <= 400000; i++) {
  const x = i / 200000 - 1;                 // -1 .. 1 inclusive
  const e = ulpErr(detAcos(x), Math.acos(x));
  if (e > worstAcos) { worstAcos = e; waAt = x; }
}
for (const x of [-1, -0.9999999999, -0, 0, 0.9999999999, 1]) {
  worstAcos = Math.max(worstAcos, ulpErr(detAcos(x), Math.acos(x)));
}
const acosDomain = Number.isNaN(detAcos(1.5)) && Number.isNaN(detAcos(-1.5)) &&
                   Number.isNaN(detAcos(NaN));
console.log("max ulp error vs Math.acos :", worstAcos.toFixed(3),
            "at x =", waAt.toFixed(6));
console.log("acos domain matches        :", acosDomain);

// detPow must be EXACT for the integer exponents the game uses -- it is plain
// repeated multiplication, so anything but a zero error means a bug.
let powExact = true;
for (let i = 0; i < 100000; i++) {
  const a = (i / 1000) - 50;
  for (let b = 0; b <= 4; b++) {
    let want = 1;
    for (let k = 0; k < b; k++) want *= a;
    if (!Object.is(detPow(a, b), want)) { powExact = false; }
  }
}
console.log("pow exact for int exponents:", powExact);
const pass = worstSin < 4 && worstCos < 4 && worstAtan2 < 4 && edgeOk &&
             worstAcos < 4 && acosDomain && powExact;
console.log("\n" + (pass ? "TRIG CHECK PASSED" : "TRIG CHECK FAILED"));
process.exit(pass ? 0 : 1);
