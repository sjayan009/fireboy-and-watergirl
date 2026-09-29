/*
 * Theme: dark, light, or the device's own setting. Dark is the default.
 *
 * A two-state toggle cannot say "follow my OS", so it quietly overrides the
 * reader's own setting the first time they touch it and never gives it back.
 * The control is therefore three radios -- Dark, Light, Match system -- and the
 * page starts on Dark. Why dark, on the evidence (2026-09-28):
 *   - most people already run their devices dark: Android Authority's reader
 *     polls, and platform data of ~82% dark on iOS 17 and Pixel
 *   - games and their platforms are dark-first (Steam, Discord, Twitch), and
 *     this is a game whose art is lantern light on stone
 *   - the app a visitor signs into is dark, so the landing page hands over to
 *     it without the screen flashing from white to black
 *   - NN/g finds dark text on light reads better for long, small text; this
 *     page is short, large and mostly pictures, and Light is one click away
 * The key is versioned: choices saved while Light was the default would
 * otherwise keep hiding the new default from the people who tested it.
 *
 * The head of every page runs a pre-paint snippet (see PREPAINT below, copied
 * inline), so the first frame is already the right theme. A flash of the wrong
 * theme is a layout-stability problem in all but name: the page repaints
 * itself under the reader right after first render.
 *
 * The change itself is one of three reveals:
 *   fade     the default: a 220 ms cross-fade of the whole page. Light to dark
 *            is a brightness change, and Apple's guidance is to ease it rather
 *            than sweep a hard edge of it across the screen. Under reduced
 *            motion it is 150 ms -- opacity, never travel
 *   circle   the new theme grows out of the control that caused it. Kept for
 *            the theme-toggle study; not used by the site
 *   instant  no transition
 */
import { spring } from "./spring.js";

const KEY = "fbwg.theme.v2";
const root = document.documentElement;
const mq = matchMedia("(prefers-color-scheme: dark)");
const reduce = matchMedia("(prefers-reduced-motion: reduce)");

export const PREPAINT = `try{var q=new URLSearchParams(location.search).get('theme'),p=q||localStorage.getItem('${KEY}')||'dark',d=p==='dark'||(p==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';document.documentElement.dataset.themePref=p}catch(e){}`;

function read() {
  try {
    const q = new URLSearchParams(location.search).get("theme");
    return q || localStorage.getItem(KEY) || "dark";
  } catch { return "dark"; }
}
function write(pref) {
  try { localStorage.setItem(KEY, pref); } catch { /* private window: the choice lasts this page */ }
}
const resolve = (pref) => (pref === "system" ? (mq.matches ? "dark" : "light") : pref);

let pref = read();
const listeners = new Set();

function commit(p) {
  pref = p;
  root.dataset.theme = resolve(p);
  root.dataset.themePref = p;
  for (const fn of listeners) fn(p, root.dataset.theme);
}

/**
 * Set the theme. `origin` is the point the reveal grows from ({x, y} in
 * viewport pixels); `mode` overrides the reveal for the motion study.
 */
export function setTheme(p, { origin, mode } = {}) {
  const before = root.dataset.theme;
  write(p);
  const after = resolve(p);
  let m = mode || root.dataset.reveal || "fade";
  if (reduce.matches && m === "circle") m = "fade";
  if (after === before || m === "instant" || !document.startViewTransition) { commit(p); return; }

  root.dataset.revealing = m;
  const t = document.startViewTransition(() => commit(p));
  // A second change before this one finishes skips this transition. The theme
  // still commits (the callback runs); only the animation is abandoned, which
  // is not an error worth surfacing.
  t.ready.catch(() => {});
  if (m === "circle") {
    const x = origin?.x ?? innerWidth - 60, y = origin?.y ?? 32;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    t.ready.then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 420 * (Number(root.dataset.revealScale) || 1), easing: "cubic-bezier(.23,1,.32,1)", pseudoElement: "::view-transition-new(root)" },
      );
    });
  }
  t.finished.catch(() => {}).finally(() => { delete root.dataset.revealing; });
}

export const getTheme = () => ({ pref, resolved: root.dataset.theme });
export const onTheme = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

mq.addEventListener("change", () => { if (pref === "system") commit("system"); });

const ICONS = {
  system: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 17h6M10 13.5V17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  light: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.4" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/></g></svg>',
  dark: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.5 12.6A7 7 0 0 1 7.4 3.5a7 7 0 1 0 9.1 9.1Z" fill="currentColor"/></svg>',
};
const LABELS = { system: "Match system", light: "Light", dark: "Dark" };
const ORDER = ["dark", "light", "system"];

/**
 * The control: a radio group, so one arrow key moves AND selects, as radios do,
 * and Tab leaves the group in one step instead of three.
 */
export function mountThemeControl(host, { mode } = {}) {
  host.classList.add("theme");
  host.setAttribute("role", "radiogroup");
  host.setAttribute("aria-label", "Colour theme");
  host.innerHTML = '<span class="theme-thumb" aria-hidden="true"></span>' + ORDER.map((p) =>
    `<button type="button" role="radio" data-pref="${p}" aria-label="${LABELS[p]}" title="${LABELS[p]}">${ICONS[p]}</button>`).join("");
  const buttons = [...host.querySelectorAll("button")];
  // The thumb rides a critically damped spring (shared/spring.js), so a
  // second click mid-slide bends its path instead of restarting it.
  const thumb = host.querySelector(".theme-thumb");
  const slide = spring((i) => { thumb.style.transform = `translateX(${i * 100}%)`; }, { response: 0.35, value: ORDER.indexOf(pref) });

  const sync = () => {
    buttons.forEach((b) => {
      const on = b.dataset.pref === pref;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    slide.to(ORDER.indexOf(pref));
  };
  const choose = (b, fromKey) => {
    const r = b.getBoundingClientRect();
    setTheme(b.dataset.pref, { origin: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, mode: host.dataset.reveal || mode });
    if (fromKey) b.focus();
  };
  host.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) choose(b, false); });
  host.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    choose(buttons[(i + step + buttons.length) % buttons.length], true);
  });
  onTheme(sync);
  sync();
  return host;
}

// A page that includes this module with no control still gets the pre-paint
// state repaired if the inline snippet could not run.
if (!root.dataset.theme) commit(pref);
