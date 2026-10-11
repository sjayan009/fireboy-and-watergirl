/**
 * The emblem in the toolbar: under the pointer, fire and water come together.
 *
 * The game is two elements that must not touch and have to work together, and
 * the emblem is an ember and a pool either side of a shared door -- so the
 * hover is the moment they meet. On a first hover the halves spin round each
 * other while closing in and lock at the end of the turn (one motion, a touch
 * of overshoot, since they arrive with momentum); while they are still turning
 * a lavender ring and sparks are thrown off along the spin and a halo rises.
 * Once the full turn is done, steam -- what fire and water make -- rises from
 * the seam for as long as you stay. Hovering again soon after is the quiet
 * version: they meet, the halo comes up, and the steam follows.
 *
 * Every move starts from what is on screen, so leaving or returning mid-motion
 * never jumps; a turn in progress finishes rather than unwinding. Fine pointers
 * only, since a tap sends a hover too. Reduced motion keeps the halo and the
 * title's colours and moves nothing.
 */
import { moveTo, spring } from "./spring.js";

const FIRE = "M23 4C24 15 9 17 9 29a14 14 0 0 0 14 14V30c-6-1-6-7-3-10 1 4 3 5 3 5V4Z";
const WATER = "M29 6c0 9 12 14 12 23a14 14 0 0 1-14 14V29c7-2 8-7 2-13V6Z";
const EASE_OUT = "cubic-bezier(.23,1,.32,1)";
/** How far each half travels to meet the other, in CSS px of the 38px mark. */
const JOIN = 2.1;
const SPIN_MS = 760;
const SNAP = spring(.6, .36), BACK = spring(.9, .38);
/** The full spin and burst rest this long before they may play again. */
const FULL_REST_MS = 8000;
let lastFull = -Infinity;

function node(tag: string, className: string, html = ""): HTMLElement {
  const e = document.createElement(tag); e.className = className; if (html) e.innerHTML = html; return e;
}
const half = (cls: string, d: string, fill: string) =>
  node("span", `logo-half ${cls}`, `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="${d}" fill="${fill}"/></svg>`);

/** The live emblem. `lit` gets `.lit` while hovered, for the title's colours. */
export function liveEmblem(lit: HTMLElement): { root: HTMLElement; destroy(): void } {
  const root = node("span", "element-emblem logo");
  root.setAttribute("aria-hidden", "true");
  const halo = node("i", "logo-halo"), fire = half("fire", FIRE, "var(--fire)"), water = half("water", WATER, "var(--water)");
  const fx = node("span", "logo-fx");
  root.append(halo, fire, water, fx);

  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const fine = matchMedia("(hover: hover) and (pointer: fine)");
  let over = false, seq = 0, steam = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const later = (ms: number, fn: () => void) => { timers.push(setTimeout(fn, ms)); };

  const fade = (e: HTMLElement, opacity: number, duration: number) => {
    const from = getComputedStyle(e).opacity;
    e.animate([{ opacity: from }, { opacity: String(opacity) }], { duration, easing: EASE_OUT });
    e.style.opacity = String(opacity);
  };
  const bit = (cls: string, style: Partial<CSSStyleDeclaration>, frames: Keyframe[], timing: KeyframeAnimationOptions) => {
    const p = node("i", cls); Object.assign(p.style, style); fx.append(p);
    p.animate(frames, timing).finished.then(() => p.remove(), () => p.remove());
  };
  // Sparks leave along the direction of the spin, curving out, with a ring.
  const burst = () => {
    bit("logo-ring", {}, [{ transform: "scale(.4) rotate(0deg)", opacity: ".9" }, { transform: "scale(1.5) rotate(90deg)", opacity: "0" }], { duration: 700, easing: EASE_OUT });
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2, r = 13 + (i % 3) * 4, mid = a + .9, end = a + 1.5;
      const color = i % 2 ? "var(--water)" : "var(--fire)";
      bit("logo-spark", { background: color }, [
        { transform: `translate(${Math.cos(a) * 3}px,${Math.sin(a) * 3}px) scale(1)`, opacity: "1" },
        { transform: `translate(${Math.cos(mid) * r * .6}px,${Math.sin(mid) * r * .6}px) scale(.8)`, opacity: "1", offset: .4 },
        { transform: `translate(${Math.cos(end) * r}px,${Math.sin(end) * r}px) scale(.25)`, opacity: "0" }],
        { duration: 640 + (i % 3) * 60, easing: EASE_OUT });
    }
  };
  const puff = () => {
    for (let i = 0; i < 2; i++) {
      const dx = (Math.random() - .5) * 6;
      bit("logo-wisp", {}, [{ transform: "translate(0,0) scale(.5)", opacity: "0" }, { opacity: ".8", offset: .2 },
        { transform: `translate(${dx}px,-16px) scale(1.9)`, opacity: "0" }],
        { duration: 1300 + i * 200, delay: i * 160, easing: "cubic-bezier(.2,.6,.35,1)" });
    }
  };
  const startSteam = (mine: number) => {
    if (!over || seq !== mine) return;
    puff(); clearInterval(steam); steam = window.setInterval(() => { if (over) puff(); }, 900);
  };

  const enter = () => {
    if (!fine.matches) return;
    over = true; lit.classList.add("lit");
    const mine = ++seq;
    if (reduce.matches) { fade(halo, 1, 200); return; }
    const full = performance.now() - lastFull > FULL_REST_MS;
    fade(halo, 1, full ? 600 : 260);
    if (!full) {
      moveTo(fire, `translate(${JOIN}px,0)`, SNAP); moveTo(water, `translate(${-JOIN}px,0)`, SNAP);
      later(260, () => startSteam(mine));
      return;
    }
    lastFull = performance.now();
    // The spin IS the lock: round each other while closing in, a touch past
    // the meeting point, then settled together.
    for (const [h, dx] of [[fire, JOIN], [water, -JOIN]] as const) {
      const from = getComputedStyle(h).transform;
      h.getAnimations().forEach(a => a.cancel());
      h.animate([
        { transform: from === "none" ? "none" : from },
        { transform: `translate(${dx * .35}px,0) rotate(170deg) scale(.88)`, offset: .45 },
        { transform: `translate(${dx * 1.18}px,0) rotate(372deg) scale(1.02)`, offset: .8 },
        { transform: `translate(${dx}px,0) rotate(360deg) scale(1)` }],
        { duration: SPIN_MS, easing: "cubic-bezier(.45,.05,.3,1)" });
      h.style.transform = `translate(${dx}px,0) rotate(360deg)`;
    }
    later(160, () => { if (over && seq === mine) burst(); });   // while they are still turning
    later(SPIN_MS, () => startSteam(mine));                      // once the full turn is done
  };
  const leave = () => {
    if (!over) return;
    over = false; lit.classList.remove("lit"); seq++;
    clearInterval(steam);
    fade(halo, 0, 240);
    if (reduce.matches) return;
    // Apart again from wherever they are; a turn in progress finishes its turn.
    for (const h of [fire, water]) {
      const m = new DOMMatrix(getComputedStyle(h).transform);
      moveTo(h, Math.abs(Math.atan2(m.b, m.a)) > .02 ? "rotate(360deg)" : "none", BACK);
    }
    later(900, () => {
      if (over) return;
      for (const h of [fire, water]) { h.getAnimations().forEach(a => a.cancel()); h.style.transform = ""; }
    });
  };
  root.addEventListener("pointerenter", enter);
  root.addEventListener("pointerleave", leave);
  return { root, destroy() {
    clearInterval(steam); timers.forEach(clearTimeout);
    root.removeEventListener("pointerenter", enter); root.removeEventListener("pointerleave", leave);
  } };
}
