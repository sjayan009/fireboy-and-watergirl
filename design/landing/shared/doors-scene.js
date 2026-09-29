/*
 * The hero scene: how every level of the game ends, told once.
 *
 * It follows the game's own code (level.Update in game.ts, around line 2090),
 * not a paraphrase of it:
 *   - a door opens, frame by frame, while its own player stands in it
 *   - only when BOTH doors are fully open are the characters hidden and the
 *     two stairs clips (FireBoystairs, WaterGirlStairs) played at the doors:
 *     they climb out of the level together, and the level has ended
 *
 * That maps exactly onto the report's distinction between acknowledgement and
 * completion. A door opening says "you've arrived"; the climb says "the level is
 * done", and it cannot happen for one player alone.
 *
 * It is one motion story:
 *   1. the scene is complete before anything moves
 *   2. Fireboy runs in; Watergirl follows, far enough behind that the two
 *      doors visibly open one after the other
 *   3. each door opens as its player arrives, and that player's chip fills
 *   4. once both doors are open, both climb, at the game's 26 fps
 *   5. it stops. It never loops; Replay is there for anyone who wants it again
 *
 * Every change is a Web Animation on one timeline, so it can be sought to any
 * millisecond: the motion study scrubs this code, and the renderer captures it.
 */
const F = 1000 / 26;             // one game frame
const T = {
  start: 300,                    // after first paint has settled
  run: 1100,                     // travel across the scene
  waterLag: 500,                 // long enough that the doors open in turn
  doorFrames: 22,                // FinishBoy / FinishGirl
  beat: 160,                     // both doors open -> the climb begins
  fireStairs: 25,                // FireBoystairs
  waterStairs: 35,               // WaterGirlStairs
};
T.fireArrive = T.start + T.run;
T.waterArrive = T.start + T.waterLag + T.run;
T.fireOpened = T.fireArrive + (T.doorFrames - 1) * F;
T.waterOpened = T.waterArrive + (T.doorFrames - 1) * F;
T.climb = Math.max(T.fireOpened, T.waterOpened) + T.beat;
T.fireClimbed = T.climb + (T.fireStairs - 1) * F;
T.waterClimbed = T.climb + (T.waterStairs - 1) * F;
T.end = Math.max(T.fireClimbed, T.waterClimbed) + 300;

export const TIMELINE = T;

const REPLAY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function createDoorsScene(host, { autoplay = true } = {}) {
  host.classList.add("scene");
  // The wall may already be in the page's HTML, so it paints with the first
  // frame instead of waiting for this script (it is the page's largest paint).
  const wall = host.querySelector(".scene-wall");
  host.innerHTML = `
    <img class="scene-wall" src="${new URL("../assets/wall.webp", import.meta.url)}" alt="" width="1920" height="1440" decoding="async">
    <div class="scene-shade"></div>
    <div class="glow glow-fire"></div><div class="glow glow-water"></div>
    <div class="sprite door door-fire"><div class="strip"></div></div>
    <div class="sprite door door-water"><div class="strip"></div></div>
    <div class="sprite pose stairs stairs-fire"><div class="strip"></div></div>
    <div class="sprite pose stairs stairs-water"><div class="strip"></div></div>
    <div class="actor" data-a="fire"><div class="sprite pose run-fire"><div class="strip"></div></div></div>
    <div class="actor" data-a="water"><div class="sprite pose run-water"><div class="strip"></div></div></div>
    <p class="scene-done" aria-hidden="true">Level complete</p>
    <div class="scene-bar">
      <p class="scene-rule"><strong>A level ends only when both players reach their doors.</strong></p>
      <div class="scene-chips" aria-hidden="true">
        <span class="pchip pchip-fire"><i></i>Fireboy<b><i></i>Fireboy</b></span>
        <span class="pchip pchip-water"><i></i>Watergirl<b><i></i>Watergirl</b></span>
      </div>
    </div>
    <button class="scene-replay" type="button">${REPLAY_ICON}Replay</button>`;
  if (wall) host.querySelector(".scene-wall").replaceWith(wall);

  const $ = (s) => host.querySelector(s);
  const anims = [];
  const add = (el, frames, opts) => { const a = el.animate(frames, { fill: "both", ...opts }); a.pause(); anims.push(a); return a; };
  /** Shown between t0 and t1 and hidden either side, as ONE animation, so no
   *  two effects fight over the same property. */
  const visible = (el, t0, t1 = T.end) => {
    const a = t0 / T.end, b = Math.min(1, t1 / T.end), after = b < 1 ? 0 : 1;
    add(el, [{ opacity: 0 }, { opacity: 0, offset: a }, { opacity: 1, offset: a }, { opacity: 1, offset: b }, { opacity: after, offset: b }, { opacity: after }],
      { duration: T.end, easing: "linear" });
  };
  /** Step a sprite strip through `n` drawn frames, holding the last one. */
  const frames = (el, n, t0) => add(el, [{ transform: "translateX(0)" }, { transform: `translateX(${-((n - 1) / n) * 100}%)` }],
    { delay: t0, duration: (n - 1) * F, easing: `steps(${n}, jump-none)` });

  // Travel, in container units so it scales with the scene.
  const cq = (px) => `${(px / 640) * 100}cqw`;
  add($('[data-a="fire"]'), [{ transform: `translateX(${cq(-160)})` }, { transform: `translateX(${cq(124.5)})` }],
    { delay: T.start, duration: T.run, easing: "cubic-bezier(.22,.61,.36,1)" });
  add($('[data-a="water"]'), [{ transform: `translateX(${cq(660)})` }, { transform: `translateX(${cq(350)})` }],
    { delay: T.start + T.waterLag, duration: T.run, easing: "cubic-bezier(.22,.61,.36,1)" });

  // Run cycles: 8 drawn frames at 26 fps, looping for exactly the time on screen.
  const cycle = 8 * F;
  for (const [sel, t0, t1] of [[".run-fire", T.start, T.fireArrive], [".run-water", T.start + T.waterLag, T.waterArrive]]) {
    add($(`${sel} .strip`), [{ transform: "translateX(0)" }, { transform: "translateX(-100%)" }],
      { delay: t0, duration: cycle, iterations: (t1 - t0) / cycle, easing: "steps(8, jump-end)", fill: "none" });
    visible($(sel), t0, t1);
  }
  // Standing at the door: the stairs clip's own first frame, a clean
  // front-facing pose, held from arrival until the climb, so the stand and the
  // climb are one drawing. (The sprite sheet's "idle" frame stacks several
  // poses on top of each other, which is what made the doorway look cluttered.)
  // One millisecond early, so the run's last frame and the stand's first
  // overlap instead of leaving a frame with neither.

  // Acknowledgement: each door opens as its own player arrives, and the chip fills.
  frames($(".door-fire .strip"), T.doorFrames, T.fireArrive);
  frames($(".door-water .strip"), T.doorFrames, T.waterArrive);
  add($(".glow-fire"), [{ opacity: 0 }, { opacity: 1 }], { delay: T.fireArrive, duration: 180, easing: "cubic-bezier(.23,1,.32,1)" });
  add($(".glow-water"), [{ opacity: 0 }, { opacity: 1 }], { delay: T.waterArrive, duration: 180, easing: "cubic-bezier(.23,1,.32,1)" });
  add($(".pchip-fire b"), [{ opacity: 0 }, { opacity: 1 }], { delay: T.fireArrive, duration: 120, easing: "ease" });
  add($(".pchip-water b"), [{ opacity: 0 }, { opacity: 1 }], { delay: T.waterArrive, duration: 120, easing: "ease" });

  // Completion: both climb the stairs together, with the game's own clips.
  visible($(".stairs-fire"), T.fireArrive - 1);
  visible($(".stairs-water"), T.waterArrive - 1);
  frames($(".stairs-fire .strip"), T.fireStairs, T.climb);
  frames($(".stairs-water .strip"), T.waterStairs, T.climb);
  add($(".scene-done"), [{ opacity: 0, transform: "translate(-50%, 6px)" }, { opacity: 1, transform: "translate(-50%, 0)" }],
    { delay: T.waterClimbed - 200, duration: 300, easing: "cubic-bezier(.23,1,.32,1)" });

  let raf = 0;
  const api = {
    duration: T.end,
    animations: anims,
    seek(ms) {
      for (const a of anims) a.currentTime = ms;
      host.toggleAttribute("data-done", ms >= T.end);
    },
    play() {
      cancelAnimationFrame(raf);
      api.seek(0);
      const t0 = performance.now();
      host.removeAttribute("data-done");
      for (const a of anims) a.play();
      const tick = () => {
        if (performance.now() - t0 >= T.end) { host.setAttribute("data-done", ""); return; }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    },
    pause() { for (const a of anims) a.pause(); cancelAnimationFrame(raf); },
    finish() { api.pause(); api.seek(T.end); },
  };

  $(".scene-replay").addEventListener("click", () => api.play());
  api.seek(0);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Reduced motion gets the story's last frame, which carries all of its
  // information: both doors open, both players gone up, the rule underneath.
  if (reduce) api.finish();
  else if (autoplay) {
    const img = $(".scene-wall");
    // Play when the scene is at least half on screen: on a phone it sits below
    // the headline, and a one-shot story that finishes out of sight is wasted.
    const go = () => {
      const io = new IntersectionObserver((es) => {
        if (es.some((e) => e.isIntersecting)) { io.disconnect(); requestAnimationFrame(() => api.play()); }
      }, { threshold: 0.5 });
      io.observe(host);
    };
    if (img.complete) go(); else img.addEventListener("load", go, { once: true });
  }
  return api;
}
