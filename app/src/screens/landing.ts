/**
 * The landing page, as the app's front door for signed-out visitors.
 *
 * The page itself lives in `design/landing/` -- its markup, its styles and its
 * behaviour -- and is shown here, not copied: the markup is read from its
 * index.html at build time, the styles are inlined, and `mountLanding` is the
 * same call its own preview makes. One page, two ways to see it.
 *
 * It is reached only at the bare site address, and only while signed out: the
 * route admits the "out" stage alone, so a signed-in visitor is sent straight
 * to /play by the router, and every other signed-out destination (a game link,
 * a sign-out) still goes to /login as it always did.
 *
 * Its styles are added on arrival and removed on departure. They share token
 * names with the app's own (`--bg`, `--ink`, ...) and set `html`'s font size,
 * so leaving them behind would restyle the sign-in card the moment somebody
 * pressed Sign In.
 *
 * Loaded lazily, so none of it is in the bundle a signed-in player downloads.
 */
import markup from "@landing/index.html?raw";
import tokens from "@landing/shared/tokens.css?inline";
import base from "@landing/shared/base.css?inline";
import study from "@landing/shared/study.css?inline";
import journey from "@landing/shared/journey.css?inline";
import doors from "@landing/shared/doors-scene.css?inline";
import { mountLanding } from "@landing/shared/landing.js";

/** Every image the markup names, by its path relative to design/landing. */
const ASSETS = Object.fromEntries(
  Object.entries(import.meta.glob("../../../design/landing/assets/**/*.{webp,png,svg}", {
    eager: true, query: "?url", import: "default",
  }) as Record<string, string>).map(([k, v]) => [k.replace("../../../design/landing/", ""), v]));

/**
 * Where the landing page's own layout and the app's shell disagree. The app
 * centres a single card in #app; the landing page is a scrolling document.
 * And the app's global button press is a 1px drop, where the landing page's
 * is a 3% shrink.
 */
const SHELL = `
#app.landing-host { display: block; padding: 0; min-height: 0; align-items: initial; justify-content: initial; }
body:has(#app.landing-host) { background-image: none; }
#app.landing-host :is(.btn, .vg-btn, .icon-btn, .seg button, .theme button, .scene-replay, .watch-replay):active:not(:disabled) { transform: scale(.97); }
`;

const doc = new DOMParser().parseFromString(markup, "text/html");
const pageCss = [...doc.querySelectorAll("head style")].map((s) => s.textContent ?? "").join("\n");
const title = doc.title;
const description = doc.querySelector('meta[name="description"]')?.getAttribute("content") ?? "";

function body(): DocumentFragment {
  const b = doc.body.cloneNode(true) as HTMLElement;
  b.querySelectorAll("script, noscript").forEach((s) => s.remove());
  for (const el of b.querySelectorAll<HTMLElement>("[src], [href]")) {
    for (const attr of ["src", "href"]) {
      const v = el.getAttribute(attr);
      if (v && ASSETS[v]) el.setAttribute(attr, ASSETS[v]);
    }
  }
  const frag = document.createDocumentFragment();
  frag.append(...b.childNodes);
  return frag;
}

export function landingScreen(host: HTMLElement): () => void {
  const style = document.createElement("style");
  style.dataset.landing = "";
  style.textContent = [tokens, base, study, journey, doors, pageCss, SHELL].join("\n");
  document.head.append(style);
  const was = { title: document.title, meta: document.querySelector('meta[name="description"]')?.getAttribute("content") };
  document.title = title;
  document.querySelector('meta[name="description"]')?.setAttribute("content", description);

  host.classList.add("landing-host");
  host.append(body());
  const page = mountLanding(host);
  // Arriving from a For Developers page at "#between" or "#multiplayer": the
  // router reads any hash that is not a path as the bare address, so this is
  // the landing page, and the section is the part of it that was asked for.
  const section = location.hash.slice(1);
  if (section && !section.startsWith("/")) {
    host.querySelector(`#${CSS.escape(section)}`)?.scrollIntoView();
  }

  return () => {
    page.destroy();
    host.classList.remove("landing-host");
    style.remove();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-pref");
    document.title = was.title;
    if (was.meta != null) document.querySelector('meta[name="description"]')?.setAttribute("content", was.meta);
    window.scrollTo(0, 0);
  };
}
