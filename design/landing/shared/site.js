/*
 * What every For Developers page does on load: mount the theme control.
 * Sign In is a relative link (../#/login), so it reaches the app on whatever
 * host serves the site.
 */
import { mountThemeControl } from "./theme.js";

const theme = document.getElementById("theme");
if (theme) mountThemeControl(theme);


export const still = new URLSearchParams(location.search).has("still");
export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

