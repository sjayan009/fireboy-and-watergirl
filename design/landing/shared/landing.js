/*
 * The landing page's behaviour, in one call.
 *
 * Two places show the landing page: this directory's own index.html (the
 * design preview) and the app itself, which renders it for signed-out visitors
 * at the site root (app/src/screens/landing.ts). Both call mountLanding() on
 * the landing markup, so the behaviour lives here once.
 *
 * In-page links (#multiplayer, #between) scroll instead of changing the hash:
 * inside the app the hash is the router's, and "#multiplayer" would read as a
 * route change and rebuild the page.
 */
import { mountThemeControl, setTheme, getTheme } from "./theme.js";
import { createDoorsScene } from "./doors-scene.js";
import { createJourney } from "./journey.js";
import { createWatchClip } from "./watch-clip.js";

export function mountLanding(root, { autoplay = true } = {}) {
  // The saved theme, before anything is drawn (there is no pre-paint script:
  // the site's CSP allows no inline script).
  setTheme(getTheme().pref, { mode: "instant" });
  const theme = root.querySelector("#theme");
  if (theme) mountThemeControl(theme);

  const scene = createDoorsScene(root.querySelector("#scene"), { autoplay });
  const journey = createJourney(root.querySelector("#journey"));
  const watch = createWatchClip(root.querySelector("#watch"));

  const onClick = (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    const id = a.getAttribute("href").slice(1);
    if (!id || id.startsWith("/")) return;                // "#/login" is the router's
    const target = root.querySelector(`#${CSS.escape(id)}`);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  root.addEventListener("click", onClick);

  return {
    scene, journey, watch,
    destroy() { root.removeEventListener("click", onClick); journey.stop?.(); },
  };
}
