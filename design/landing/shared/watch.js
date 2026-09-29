/*
 * The Watch panel: a finish, run by the game engine, not a picture of one.
 *
 * The panel used to show a still with a pulsing "Live" badge, which claimed
 * something that was not happening. The report is blunt about that kind of
 * gap: trust "survives through predictability", and a product that "does what
 * it said it would". So this panel says exactly what it is -- a scripted
 * finish, run by the engine -- and then actually runs it.
 *
 * The script (assets/watch-finish.json, from tools/watch-script.mjs) places
 * both players on the exit ledge of Adventure 1 and walks each to their own
 * door. Everything after that is the game: the doors open under them, and once
 * both are open the engine hides them and plays the stairs clips.
 *
 * Plays once when it is on screen, then offers Replay. Reduced motion shows
 * the finished frame.
 */
import { LevelHost } from "/engine/net/levelhost.js";
import { Snapshot } from "/engine/net/snapshot.js";
import { SpriteRenderer } from "/engine/render/sprites.js";
import { createBoot, trackArt } from "./boot.js";

const W = 960, H = 540;
const CAM = { x: 262, y: 0, w: 378, h: 212.6 };   // the exit ledge, top right of the stage
const Z = W / CAM.w;                               // 2.54
// Played at 0.7x: slower than the game, so the pickup and both doors can be followed.
const RATE = 0.7;
const F = 1000 / 26 / RATE;
const REPLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function createWatch(host) {
  host.classList.add("watch");
  host.innerHTML = `
    <canvas width="${W}" height="${H}" role="img" aria-label="Fireboy and Watergirl walk to their doors on the last ledge of the first level; the doors open and both climb out"></canvas>
    <div class="watch-hud" aria-hidden="true"><span>Watching ember &amp; tide</span><span class="t-data watch-f">Adventure 1</span></div>
    <p class="watch-done" aria-hidden="true">Level complete</p>
    <button type="button" class="watch-replay" hidden>${REPLAY}Replay</button>
`;
  const $ = (s) => host.querySelector(s);
  const ctx = $("canvas").getContext("2d");
  let run = null, raf = 0;
  const progress = createBoot(host);

  async function boot() {
    const script = await fetch(new URL("../assets/watch-finish.json", import.meta.url)).then((r) => r.json());
    const sim = new LevelHost();
    sim.start(...script.level);
    sim.lv.scaleX = sim.lv.scaleY = 0.8; sim.lv.x = sim.lv.y = 16;
    for (const [who, [x, y]] of [["pers1", script.place.fire], ["pers2", script.place.water]]) {
      const body = sim.lv[who], p = body.GetPosition();
      p.x = x; p.y = y;
      body.SetXForm(p, 0);
    }
    const sprites = await SpriteRenderer.load("/extracted/assets", W, H);
    progress.set(0.15);
    await trackArt(sprites, sprites.prepare(sim.shell), (p) => progress.set(0.15 + p * 0.85));
    const start = new Snapshot();
    sim.save(start);
    run = { sim, sprites, start, script, frame: 0 };
    progress.done();
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(Z, 0, 0, Z, -CAM.x * Z, -CAM.y * Z);
    run.sprites.draw(ctx, run.sim.shell);
    host.toggleAttribute("data-done", run.frame > run.script.endedAt + 14);
  }
  // The level places its doors and diamonds on its first update, so frame 0 is
  // an empty room: every showing starts from frame 1.
  function reset() {
    run.sim.load(run.start);
    run.frame = 0;
    stepTo(1);
  }
  function stepTo(n) {
    while (run.frame < n && run.frame < run.script.bits.length) {
      run.sim.step(run.script.bits[run.frame], run.frame, true);
      run.frame++;
    }
  }
  function play() {
    cancelAnimationFrame(raf);
    reset();
    $(".watch-replay").hidden = true;
    const t0 = performance.now();
    const tick = (t) => {
      stepTo(1 + Math.floor((t - t0) / F));
      draw();
      if (run.frame >= run.script.bits.length) { $(".watch-replay").hidden = false; return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  $(".watch-replay").addEventListener("click", play);

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const still = new URLSearchParams(location.search).has("still");
  boot().then(() => {
    if (reduce || still) { reset(); stepTo(run.script.bits.length); draw(); $(".watch-replay").hidden = false; return; }
    reset();
    draw();
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); play(); } }, { threshold: 0.6 });
    io.observe(host);
  }).catch((e) => { progress.fail("The engine could not start in this browser."); console.warn(e); });
  /** Frame-exact, for the renderer and for checking: the world after frame n. */
  const seek = (n) => { cancelAnimationFrame(raf); reset(); stepTo(Math.max(1, n)); draw(); };
  return { play, seek, get frames() { return run ? run.script.bits.length : 0; } };
}
