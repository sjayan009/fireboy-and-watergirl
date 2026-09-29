/*
 * What every page of the site does on load: mount the theme control, and point
 * Sign in at the app -- the local app while developing, the deployed one
 * everywhere else (the href in the markup is that fallback).
 */
import { mountThemeControl } from "./theme.js";

const theme = document.getElementById("theme");
if (theme) mountThemeControl(theme);

if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  for (const a of document.querySelectorAll("[data-signin]")) a.href = "http://localhost:5174/#/login";
}

export const still = new URLSearchParams(location.search).has("still");
export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/*
 * Load a stylesheet only after the page has painted. A stylesheet added before
 * the first paint -- even from script, even after `load` -- still blocks that
 * paint, and the Cinzel request held first paint back by ~1.5 s. So wait for
 * the first contentful paint, then add it.
 */
export function afterFirstPaint(href) {
  const add = () => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; document.head.append(l); };
  if (performance.getEntriesByName("first-contentful-paint").length) { add(); return; }
  try {
    const po = new PerformanceObserver((list) => {
      if (list.getEntries().some((e) => e.name === "first-contentful-paint")) { po.disconnect(); add(); }
    });
    po.observe({ type: "paint", buffered: true });
  } catch { addEventListener("load", () => setTimeout(add, 0), { once: true }); }
}
