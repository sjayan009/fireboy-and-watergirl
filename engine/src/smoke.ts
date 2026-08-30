/**
 * Smoke test for the ported Box2D: does the transliterated engine actually
 * simulate, and does it do so identically on repeated runs?
 *
 * World settings are the ones the game itself uses, read out of
 * level.<constructor>: AABB +/-100, gravity (0, 26) -- positive Y because
 * Flash's screen space is Y-down -- doSleep true, 1/26 s step, 50 iterations.
 */
import {
  b2AABB, b2Vec2, b2World, b2BodyDef, b2PolygonDef, b2CircleDef, b2Body,
} from "./box2d/box2d.js";

const TIME_STEP = 1 / 26;
const ITERATIONS = 50;

function makeWorld(): b2World {
  const aabb = new b2AABB();
  aabb.lowerBound.Set(-100, -100);
  aabb.upperBound.Set(100, 100);
  return new b2World(aabb, new b2Vec2(0, 26), true);
}

function addGround(world: b2World, x: number, y: number,
                   hw: number, hh: number): b2Body {
  const bd = new b2BodyDef();
  bd.position.Set(x, y);
  const body = world.CreateBody(bd);
  const sd = new b2PolygonDef();
  sd.SetAsBox(hw, hh);
  sd.friction = 0.4;
  body.CreateShape(sd);
  // no SetMassFromShapes -> static
  return body;
}

function addBox(world: b2World, x: number, y: number, hw: number,
                hh: number): b2Body {
  const bd = new b2BodyDef();
  bd.position.Set(x, y);
  const body = world.CreateBody(bd);
  const sd = new b2PolygonDef();
  sd.SetAsBox(hw, hh);
  sd.density = 1;
  sd.friction = 0.4;
  sd.restitution = 0.1;
  body.CreateShape(sd);
  body.SetMassFromShapes();
  return body;
}

function addBall(world: b2World, x: number, y: number, r: number): b2Body {
  const bd = new b2BodyDef();
  bd.position.Set(x, y);
  const body = world.CreateBody(bd);
  const sd = new b2CircleDef();
  sd.radius = r;
  sd.density = 1;
  sd.friction = 0.3;
  sd.restitution = 0.5;
  body.CreateShape(sd);
  body.SetMassFromShapes();
  return body;
}

/** Run the scene and return a trace of every body position, per step. */
function run(steps: number): number[][] {
  const world = makeWorld();
  addGround(world, 20, 28, 19, 1);
  addGround(world, 1, 14, 1, 15);
  const box = addBox(world, 10, 4, 0.95, 0.95);
  const stacked = addBox(world, 10.4, 1, 0.95, 0.95);
  const ball = addBall(world, 25, 3, 0.8);

  const trace: number[][] = [];
  for (let i = 0; i < steps; i++) {
    world.Step(TIME_STEP, ITERATIONS);
    const row: number[] = [];
    for (const b of [box, stacked, ball]) {
      const p = b.GetPosition();
      row.push(p.x, p.y, b.GetAngle());
    }
    trace.push(row);
  }
  return trace;
}

const STEPS = 260; // ten seconds at 1/26
const a = run(STEPS);
const b = run(STEPS);

const fmt = (r: number[]) =>
  `box(${r[0].toFixed(4)}, ${r[1].toFixed(4)}) ` +
  `stack(${r[3].toFixed(4)}, ${r[4].toFixed(4)}) ` +
  `ball(${r[6].toFixed(4)}, ${r[7].toFixed(4)})`;

console.log("step   0:", fmt(a[0]));
console.log("step  25:", fmt(a[25]));
console.log("step  75:", fmt(a[75]));
console.log("step 259:", fmt(a[STEPS - 1]));

// Did anything actually move, and did it settle on the ground?
const start = a[0];
const end = a[STEPS - 1];
const fell = end[1] > start[1] + 1;
// 0.01 world units is ~0.16 px; below that a body is at rest, not moving.
// Box2D always leaves a little resting slop, so an exact zero never happens.
const drift = Math.max(
  ...end.map((v, i) => Math.abs(v - a[STEPS - 40][i])));
const settled = drift < 0.01;
const onGround = end[1] > 24 && end[1] < 28;
const finite = end.every(Number.isFinite);

// Determinism: identical inputs must produce bit-identical output.
let firstDiff = -1;
for (let i = 0; i < STEPS && firstDiff < 0; i++) {
  for (let j = 0; j < a[i].length; j++) {
    if (a[i][j] !== b[i][j]) { firstDiff = i; break; }
  }
}

console.log("");
console.log("bodies fell under gravity :", fell);
console.log("came to rest              :", settled,
            `(max drift over last 40 steps ${drift.toFixed(6)})`);
console.log("resting on the ground     :", onGround);
console.log("all values finite         :", finite);
console.log("run-to-run identical      :", firstDiff === -1,
            firstDiff === -1 ? "" : `(first difference at step ${firstDiff})`);

const pass = fell && settled && onGround && finite && firstDiff === -1;
console.log("\n" + (pass ? "SMOKE TEST PASSED" : "SMOKE TEST FAILED"));
process.exit(pass ? 0 : 1);
