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
 */
import { GameView, STAGE_W, STAGE_H } from "@engine/embed.js";
import { LocalSave } from "@engine/game/save.js";
import { el } from "../ui/dom.js";

export const GUEST_KEY = "FBCookie:guest";

export function guestScreen(host: HTMLElement): () => void {
  const canvas = el("canvas", {
    id: "stage", width: STAGE_W, height: STAGE_H, tabindex: "0",
    role: "application", "aria-label": "Fireboy and Watergirl, played on a canvas",
    "aria-describedby": "guest-keys",
  });
  host.append(el("div", { class: "guest" },
    el("header", { class: "guest-bar" },
      el("a", { href: "#/" }, "Fireboy & Watergirl"),
      el("a", { class: "secondary", href: "#/login" }, "Play Online")),
    el("div", { class: "guest-stage" }, canvas),
    el("p", { class: "note", id: "guest-keys" },
      "Fireboy: arrow keys · Watergirl: W A D · P pauses. Progress is saved in this browser only.")));
  const view = new GameView({ canvas, assets: __ASSETS__, save: new LocalSave(GUEST_KEY) });
  canvas.focus();
  return () => view.destroy();
}
