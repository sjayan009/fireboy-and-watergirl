/*
 * The netcode section, running the real engine.
 *
 * The canvas is YOUR screen, as Fireboy. It is drawn by the game's own
 * renderer from the game's own simulation (LevelHost, the class the netplay
 * session drives), and it does what the production session does:
 *
 *   - snapshots of the world are kept at settled frames, where both players'
 *     real input is known
 *   - to show frame n, the nearest settled snapshot is restored and the few
 *     frames since are replayed with your real input and sam_k's PREDICTED
 *     input (whatever sam_k last did)
 *   - when sam_k's real input for a frame arrives and differs, the next frame
 *     is simply drawn from the corrected inputs: that is the rollback
 *
 * So the misprediction is visible for exactly as long as it really would be:
 * on your screen Watergirl runs on toward the lava for four frames, then the
 * packet saying she jumped lands and she is in the air, where she has been all
 * along. A dashed ring marks where sam_k really is while the two differ.
 *
 * Rendering is at up to 3x the game's resolution through a fixed camera. The
 * characters and text are vector art and stay sharp; the renderer's glow tile
 * is 192 px, so the zoom is capped where it still fits.
 */
import { LevelHost } from "/engine/net/levelhost.js";
import { Snapshot } from "/engine/net/snapshot.js";
import { SpriteRenderer } from "/engine/render/sprites.js";
import { createRollback, you, friend, knownFriend, RANGE } from "./rollback.js";
import { createBoot, trackArt } from "./boot.js";

/*
 * The view's size is not fixed. Its width is the content column, its height is
 * whatever makes the whole Netcode section exactly fill the window under the
 * nav (see fit()), and the camera follows the shape: the band of level 1 where
 * the action happens, 225 game px tall, as wide as the view's proportions ask
 * (up to the level's full 640), anchored to the floor and centred on the run.
 */
const ACTION = { cx: 380, bottom: 480, band: 225 };   // game px (640 x 480 stage)
const MAX_ZOOM = 3;                                   // device px per game px: the glow tile's limit
const LAYER = { w: 2048, h: 1152 };                   // renderer layers, sized for the largest view
const EVERY = 4;                                   // settled-snapshot spacing
const toStage = (p) => ({ x: p.x * 16 + 16, y: p.y * 16 + 16 });   // Box2D -> stage px

export function createNetDemo(host, { autoplay = true } = {}) {
  host.classList.add("net");
  host.innerHTML = `
    <div class="net-instrument">
    <div class="net-stage">
      <canvas role="img" aria-label="Your screen, as Fireboy: the first level of the Forest Temple, drawn by the game engine"></canvas>
      <div class="net-ring" aria-hidden="true" hidden><span>sam_k is really here</span></div>
      <div class="net-hud" aria-hidden="true">
        <span class="hud-you">Your screen · Fireboy</span>
        <span class="hud-f t-data">f096</span>
        <span class="hud-p t-data">sam_k: received</span>
        <span class="hud-r t-data" hidden></span>
      </div>
    </div>
    <div class="net-timeline"></div>
    </div>`;
  const $ = (s) => host.querySelector(s);
  const canvas = $("canvas"), ctx = canvas.getContext("2d");
  const ring = $(".net-ring");
  let engine = null, last = null;
  const progress = createBoot($(".net-stage"));
  const stage = $(".net-stage");
  let view = { W: 1152, H: 648, cam: { x: 182, y: 255, w: 400, h: 225 }, Z: 2.88 };

  /** Size the canvas to the stage's box and aim the camera to match. */
  function layout() {
    const cssW = stage.clientWidth, cssH = stage.clientHeight;
    if (!cssW || !cssH) return;
    const aspect = cssW / cssH;
    let camH = ACTION.band, camW = camH * aspect;
    if (camW > 640) { camW = 640; camH = camW / aspect; }
    const cam = { w: camW, h: camH, x: Math.min(640 - camW, Math.max(0, ACTION.cx - camW / 2)), y: ACTION.bottom - camH };
    const scale = Math.min(devicePixelRatio || 1, MAX_ZOOM / (cssW / camW));
    const W = Math.min(LAYER.w, Math.round(cssW * scale)), H = Math.min(LAYER.h, Math.round(cssH * scale));
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    view = { W, H, cam, Z: W / camW };
    if (last) render(last);
  }

  /*
   * Height: whatever lets the whole instrument fit on one screen under the
   * sticky bars (the site nav, plus the developer tabs where they exist), all
   * measured. Between 260 and 640 px. On a phone, 16:9 of the width instead.
   */
  function fit() {
    const bars = [...document.querySelectorAll(".nav, .devnav")].reduce((sum, el) => sum + el.offsetHeight, 0);
    const inst = host.querySelector(".net-instrument");
    const rest = inst ? inst.offsetHeight - stage.offsetHeight : 290;
    const h = innerWidth < 760
      ? Math.round(stage.clientWidth * 9 / 16)
      : Math.round(Math.min(640, Math.max(260, innerHeight - bars - rest - 16)));
    stage.style.height = `${h}px`;
    layout();
  }
  new ResizeObserver(() => fit()).observe(host);
  addEventListener("resize", fit);

  // Progress, by the work actually done: renderer 10%, art 50%, snapshots 40%.
  async function boot() {
    const sim = new LevelHost();
    sim.start("adventure", 1);
    // Display transform, as StartGame applies it (scale .8, 16 px border).
    sim.lv.scaleX = sim.lv.scaleY = 0.8; sim.lv.x = sim.lv.y = 16;
    const sprites = await SpriteRenderer.load("/extracted/assets", LAYER.w, LAYER.h);
    progress.set(0.1);
    await trackArt(sprites, sprites.prepare(sim.shell), (p) => progress.set(0.1 + p * 0.5));
    // Settled snapshots: state BEFORE frame k, for every k that is a multiple
    // of EVERY. Frames before k are settled whenever k - 1 <= frontier.
    const snaps = new Map();
    for (let f = 0; f <= RANGE.LAST; f++) {
      if (f % EVERY === 0) { const s = new Snapshot(); sim.save(s); snaps.set(f, s); }
      sim.step(you(f) | friend(f), f, true);
      if (f % 8 === 7) { progress.set(0.6 + (f / RANGE.LAST) * 0.4); await new Promise((r) => setTimeout(r)); }   // keep the page responsive
    }
    engine = { sim, sprites, snaps };
    progress.done();
  }

  /** Run the world to the end of frame n with sam_k's input as `friendAt`, from the best settled snapshot. */
  function worldAt(n, friendAt, settledTo) {
    const { sim, snaps } = engine;
    let k = Math.floor(Math.min(n + 1, settledTo + 1) / EVERY) * EVERY;
    while (!snaps.has(k)) k -= EVERY;
    sim.load(snaps.get(k));
    for (let f = k; f <= n; f++) sim.step(you(f) | friendAt(f), f, true);
    return toStage(sim.lv.pers2.GetPosition());
  }

  function render(s) {
    last = s;
    if (!engine) return;
    const { W, H, cam: CAM, Z } = view;
    const n = s.now;
    const truth = worldAt(n, friend, n);                    // where sam_k really is
    const shown = worldAt(n, knownFriend(n), s.frontier);   // what your screen shows
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(Z, 0, 0, Z, -CAM.x * Z, -CAM.y * Z);
    engine.sprites.draw(ctx, engine.sim.shell);

    const off = Math.hypot(truth.x - shown.x, truth.y - shown.y) > 2;
    ring.hidden = !off;
    if (off) {
      ring.style.left = `${((truth.x - CAM.x) / CAM.w) * 100}%`;
      ring.style.top = `${((truth.y - 10 - CAM.y) / CAM.h) * 100}%`;
    }
    $(".hud-f").textContent = "f" + String(n).padStart(3, "0");
    const guessing = n > s.frontier;
    const k = n - s.frontier;
    $(".hud-p").textContent = guessing ? `sam_k: predicted for ${k} frame${k === 1 ? "" : "s"}` : "sam_k: received";
    $(".hud-p").classList.toggle("guess", guessing);
    const r = s.rollbacks.at(-1), live = r && n - r.at < 6;
    $(".hud-r").hidden = !live;
    if (live) $(".hud-r").textContent = `rolled back ${r.frames} frames · ${(r.frames * RANGE.RESIM_MS).toFixed(2)} ms`;
  }

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const timeline = createRollback($(".net-timeline"), { autoplay: false, world: false, instrument: true, onDraw: render });
  fit();
  fit();
  boot().then(() => {
    if (reduce || !autoplay) { timeline.seek(reduce ? 112 : RANGE.FIRST); return; }
    timeline.redraw();
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); timeline.play(); } }, { threshold: 0.5 });
    io.observe($(".net-stage"));
  }).catch((e) => { progress.fail("The engine could not start in this browser."); console.warn(e); });
  return timeline;
}
