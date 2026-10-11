/**
 * The emblem in the toolbar, alive under the pointer.
 *
 * The two halves part and lean on a spring, the flame flickers while you stay,
 * light follows the pointer (fire to the left half, water to the right) and the
 * title picks up both colours. The first hover in a while also lets a few
 * embers rise and a drop fall from the water's tip; hovering again soon after
 * is the calm version, because something seen tens of times a day should not
 * perform every time. Everything moves from where it is on screen, so leaving
 * or returning mid-motion never jumps.
 *
 * Fine pointers only -- a tap on a touchscreen sends a hover too, and that is
 * not a request for anything. Reduced motion keeps the light and the colour and
 * drops every movement.
 */
import { moveTo, spring } from "./spring.js";

const FIRE = "M23 4C24 15 9 17 9 29a14 14 0 0 0 14 14V30c-6-1-6-7-3-10 1 4 3 5 3 5V4Z";
const WATER = "M29 6c0 9 12 14 12 23a14 14 0 0 1-14 14V29c7-2 8-7 2-13V6Z";
const EASE_OUT = "cubic-bezier(.23,1,.32,1)";
/** Parting has a little life in it; returning settles without fuss. */
const PART = spring(.62, .42), BACK = spring(.9, .38);
/** How long the embers and the drop rest before they may play again. */
const FLOURISH_REST_MS = 8000;
let lastFlourish = -Infinity;

function node(tag: string, className: string, html = ""): HTMLElement {
  const e = document.createElement(tag); e.className = className; if (html) e.innerHTML = html; return e;
}
const svg = (d: string, fill: string, cls = "") => `<svg viewBox="0 0 48 48"${cls ? ` class="${cls}"` : ""} aria-hidden="true"><path d="${d}" fill="${fill}"/></svg>`;

/** The live emblem. `lit` gets `.lit` while hovered, for the title's colours. */
export function liveEmblem(lit: HTMLElement): { root: HTMLElement; destroy(): void } {
  const root = node("span", "element-emblem logo");
  root.setAttribute("aria-hidden", "true");
  const lightF = node("i", "logo-light fire"), lightW = node("i", "logo-light water");
  const fire = node("span", "logo-half fire", svg(FIRE, "var(--fire)", "logo-flame"));
  const water = node("span", "logo-half water", svg(WATER, "var(--water)"));
  const fx = node("span", "logo-fx");
  root.append(lightF, lightW, fire, water, fx);
  const flame = fire.firstElementChild as SVGElement;

  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const fine = matchMedia("(hover: hover) and (pointer: fine)");
  let over = false, target = .5, mix = .5, raf = 0;
  let flicker: Animation | null = null;

  const fade = (e: HTMLElement, opacity: number, duration: number) => {
    const from = getComputedStyle(e).opacity;
    e.animate([{ opacity: from }, { opacity: String(opacity) }], { duration, easing: EASE_OUT });
    e.style.opacity = String(opacity);
  };
  // The light glides toward the pointer rather than snapping to it.
  const tick = () => {
    mix += (target - mix) * .18;
    lightF.style.opacity = (.35 + .65 * (1 - mix)).toFixed(3);
    lightW.style.opacity = (.35 + .65 * mix).toFixed(3);
    raf = over && Math.abs(target - mix) > .002 ? requestAnimationFrame(tick) : 0;
  };
  const flourish = () => {
    for (let i = 0; i < 5; i++) {
      const e = node("i", "logo-ember"); fx.append(e);
      const dx = (i - 2) * 3.2 + (Math.random() - .5) * 2, dy = -14 - Math.random() * 8;
      e.animate([{ transform: "translate(0,0) scale(1)", opacity: 0 }, { opacity: 1, offset: .15 },
        { transform: `translate(${dx}px,${dy}px) scale(.35)`, opacity: 0 }],
        { duration: 700 + i * 70, delay: 40 + i * 45, easing: EASE_OUT }).finished.then(() => e.remove(), () => e.remove());
    }
    const d = node("i", "logo-drop"); fx.append(d);
    d.animate([{ transform: "translateY(-3px) scale(.2,.2)", opacity: 0 }, { transform: "translateY(0) scale(1,1)", opacity: 1, offset: .35 },
      { transform: "translateY(1px) scale(.85,1.25)", opacity: 1, offset: .55 }, { transform: "translateY(13px) scale(.7,1.1)", opacity: 0 }],
      { duration: 900, delay: 120, easing: "cubic-bezier(.5,0,.75,0)" }).finished.then(() => d.remove(), () => d.remove());
  };

  const enter = () => {
    if (!fine.matches) return;
    over = true; lit.classList.add("lit");
    if (reduce.matches) { fade(lightF, .7, 200); fade(lightW, .7, 200); return; }
    moveTo(fire, "translate(-1.6px,-.4px) rotate(-7deg)", PART);
    moveTo(water, "translate(1.6px,-.4px) rotate(6deg)", PART);
    fade(lightF, .65, 160); fade(lightW, .65, 160);
    flicker?.cancel();
    flicker = flame.animate([
      { transform: "scale(1,1) skewX(0)" }, { transform: "scale(.97,1.07) skewX(-2deg)", offset: .28 },
      { transform: "scale(1.02,.97) skewX(1.5deg)", offset: .55 }, { transform: "scale(.99,1.04) skewX(-1deg)", offset: .8 },
      { transform: "scale(1,1) skewX(0)" }], { duration: 1150, iterations: Infinity, easing: "ease-in-out", delay: 180 });
    if (performance.now() - lastFlourish > FLOURISH_REST_MS) { lastFlourish = performance.now(); flourish(); }
  };
  const move = (event: Event) => {
    if (!over || reduce.matches) return;
    const r = root.getBoundingClientRect();
    target = Math.min(1, Math.max(0, ((event as PointerEvent).clientX - r.left) / r.width));
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const leave = () => {
    if (!over) return;
    over = false; lit.classList.remove("lit");
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    fade(lightF, 0, 220); fade(lightW, 0, 220);
    if (reduce.matches) return;
    moveTo(fire, "none", BACK); moveTo(water, "none", BACK);
    if (flicker) {
      const now = getComputedStyle(flame).transform; flicker.cancel(); flicker = null;
      flame.animate([{ transform: now === "none" ? "none" : now }, { transform: "none" }], { duration: 220, easing: EASE_OUT });
    }
  };
  root.addEventListener("pointerenter", enter);
  root.addEventListener("pointermove", move);
  root.addEventListener("pointerleave", leave);
  return { root, destroy() {
    if (raf) cancelAnimationFrame(raf);
    flicker?.cancel();
    root.removeEventListener("pointerenter", enter); root.removeEventListener("pointermove", move); root.removeEventListener("pointerleave", leave);
  } };
}
