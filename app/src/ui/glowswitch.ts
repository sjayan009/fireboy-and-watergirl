/**
 * The stage glow's switch: a soft fire-and-water light at the sides of the
 * game, off unless somebody turns it on. The same control in the Menu (where a
 * guest finds it) and in Settings, both writing the one preference.
 */
import { el, on } from "./dom.js";
import { PRESENTATION_CHANGED, presentationPreferences, savePresentationPreferences, type PresentationPreferences } from "../presentation.js";

export function glowSwitch(): { root: HTMLElement; destroy(): void } {
  const button = el("button", { type: "button", class: "switch", role: "switch", "aria-labelledby": "glow-label" });
  const sync = (p: PresentationPreferences) => button.setAttribute("aria-checked", String(p.glow));
  sync(presentationPreferences());
  const offs = [
    on(button, "click", () => savePresentationPreferences({ glow: button.getAttribute("aria-checked") !== "true" })),
    on(window, PRESENTATION_CHANGED, e => sync((e as CustomEvent<PresentationPreferences>).detail)),
  ];
  const root = el("div", { class: "switch-row" },
    el("span", { class: "switch-text" }, el("span", { id: "glow-label" }, "Stage glow"),
      el("small", {}, "A soft fire-and-water light at the sides of the game")), button);
  return { root, destroy: () => offs.forEach(off => off()) };
}
