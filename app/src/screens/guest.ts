/**
 * Two players on one keyboard, no account.
 *
 * Everybody can play this way, children included: nothing leaves the browser,
 * so there is nothing to consent to. Accounts (online play, friends, the
 * leaderboard) are 13 and up -- see `age.ts`.
 *
 * Progress lives under its own key, not the engine's default `FBCookie`:
 * `solosave.ts` adopts that legacy key into the next account that signs in on
 * this browser, and a guest's medals are not that account's.
 *
 * Dressed in the landing page's own stylesheets (adopted on arrival, removed
 * on departure, exactly as `landing.ts` does) so the game is the same place
 * the page that sent people here promised.
 */
import { GameView, STAGE_W, STAGE_H } from "@engine/embed.js";
import { LocalSave } from "@engine/game/save.js";
import tokens from "@landing/shared/tokens.css?inline";
import base from "@landing/shared/base.css?inline";
import local from "../ui/guest.css?inline";
import { el, on } from "../ui/dom.js";
import type { Ported } from "@engine/ported.js";

export const GUEST_KEY = "FBCookie:guest";

// The landing header's own mark, so `.brand` sizes and spaces it exactly as
// there. The app's `emblem()` carries the sign-in card's size and spacing.
const EMBLEM = '<svg class="emblem" viewBox="0 0 48 48" aria-hidden="true"><path d="M23 4C24 15 9 17 9 29a14 14 0 0 0 14 14V30c-6-1-6-7-3-10 1 4 3 5 3 5V4Z"/><path d="M29 6c0 9 12 14 12 23a14 14 0 0 1-14 14V29c7-2 8-7 2-13V6Z"/></svg>';
const ARROW = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12m0 0-5-5m5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Corners pointing out to enter, in to leave.
const EXPAND = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SHRINK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 3.5v4h-4M12.5 3.5v4h4M7.5 16.5v-4h-4M12.5 16.5v-4h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const key = (code: string, label: string, name: string) =>
  el("kbd", { "data-code": code, title: name }, label);

export function guestScreen(host: HTMLElement): () => void {
  const style = new CSSStyleSheet();
  style.replaceSync([tokens, base, local].join("\n"));
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, style];
  host.classList.add("guest-host");

  const canvas = el("canvas", {
    width: STAGE_W, height: STAGE_H, tabindex: "0",
    role: "application", "aria-label": "Fireboy and Watergirl, played on a canvas",
    "aria-describedby": "guest-keys",
  });
  const brand = el("a", { class: "brand", href: "#/", "aria-label": "Fireboy and Watergirl, home" },
    el("span", { class: "brand-text" }, "Fireboy & Watergirl"));
  brand.insertAdjacentHTML("afterbegin", EMBLEM);
  const online = el("a", { class: "btn btn-water btn-s btn-online btn-pulse", href: "#/login" }, "Play Online ");
  online.insertAdjacentHTML("beforeend", ARROW);
  // A level's art arrives before it starts. Without this the stage sits on the
  // map with a lit node and nothing else, and keys pressed meanwhile seem lost.
  const bar = el("span", { class: "local-loading-bar" });
  const said = el("span", {}, "Loading the level");
  const loading = el("div", { class: "local-loading", role: "status", "aria-live": "polite" }, said, el("span", { class: "local-loading-track" }, bar));
  loading.hidden = true;
  const progress = (stage: string, c: { total: number; ready: number; failed: number }) => {
    if (stage === "background") return;
    const done = c.ready + c.failed;
    loading.hidden = stage === "critical" && done === c.total;
    loading.classList.remove("is-error");
    said.textContent = "Loading the level";
    bar.style.transform = `scaleX(${stage === "metadata" ? 0.04 : Math.max(0.04, done / Math.max(1, c.total))})`;
  };
  const refused = () => {
    loading.hidden = false;
    loading.classList.add("is-error");
    said.textContent = "This level could not load. Check your connection and pick it again.";
  };
  // A laptop window is short, so the stage is limited by height: full screen
  // gives it the whole display, key cards and all.
  const full = el("button", { class: "btn btn-ghost btn-s", type: "button" });
  const drawFull = () => {
    const on = !!document.fullscreenElement;
    full.innerHTML = (on ? SHRINK : EXPAND) + (on ? "Exit Full Screen" : "Full Screen");
  };
  drawFull();

  host.append(el("div", { class: "local" },
    el("header", { class: "nav" },
      el("div", { class: "wrap nav-row" },
        brand,
        el("div", { class: "nav-end" }, full, online))),
    el("main", { class: "local-main" },
      el("div", { class: "local-stage" }, canvas, loading),
      el("div", { class: "local-controls", id: "guest-keys" },
        el("div", { class: "player player-fire" },
          el("span", { class: "player-name" }, "Fireboy"),
          el("span", { class: "keys" },
            key("ArrowLeft", "←", "Left arrow"), key("ArrowUp", "↑", "Up arrow"), key("ArrowRight", "→", "Right arrow"))),
        el("p", { class: "local-hint" },
          el("span", {}, key("KeyP", "P", "P"), "pauses"), el("span", {}, "Saved in this browser only · An account keeps it")),
        el("div", { class: "player player-water" },
          el("span", { class: "player-name" }, "Watergirl"),
          el("span", { class: "keys" },
            key("KeyA", "A", "A"), key("KeyW", "W", "W"), key("KeyD", "D", "D")))))));

  // The keycaps follow the real keyboard. Listening is all this does: the game
  // reads its own input, and nothing here prevents or changes a key.
  const caps = new Map([...host.querySelectorAll<HTMLElement>("kbd[data-code]")].map(k => [k.dataset.code!, k]));
  const press = (down: boolean) => (e: Event) => caps.get((e as KeyboardEvent).code)?.classList.toggle("is-down", down);
  const release = () => caps.forEach(k => k.classList.remove("is-down"));
  const page = host.querySelector<HTMLElement>(".local")!;
  const off = [on(window, "keydown", press(true)), on(window, "keyup", press(false)), on(window, "blur", release),
    on(document, "fullscreenchange", drawFull),
    on(full, "click", () => document.fullscreenElement ? document.exitFullscreen() : page.requestFullscreen())];
  if (!document.fullscreenEnabled) full.hidden = true;

  // A cleared level puts the results board (`Recuento`) on the stage; the glow
  // behind it breathes out once as it arrives.
  const stage = host.querySelector<HTMLElement>(".local-stage")!;
  let cleared = false;
  off.push(on(stage, "animationend", () => stage.classList.remove("is-cleared")));
  // Ask the browser not to evict this save, but only once there is one worth
  // keeping: Firefox shows a permission prompt for persist(), which would be
  // an odd greeting on page load. Asked once per browser.
  const keepStorage = () => {
    try {
      if (localStorage.getItem("fbwg.persistAsked")) return;
      localStorage.setItem("fbwg.persistAsked", "1");
      void navigator.storage?.persist?.().catch(() => {});
    } catch { /* storage unavailable: nothing to protect either */ }
  };
  const onFrame = (v: GameView) => {
    const now = v.game.children.some((c: Ported) => c.symbol === "Recuento");
    if (now && !cleared) { stage.classList.add("is-cleared"); keepStorage(); }
    cleared = now;
  };

  const view = new GameView({ canvas, assets: __ASSETS__, save: new LocalSave(GUEST_KEY),
    onPreparationProgress: progress, onRefused: refused, onFrame });
  canvas.focus();
  return () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    view.destroy();
    off.forEach(f => f());
    host.classList.remove("guest-host");
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== style);
  };
}
