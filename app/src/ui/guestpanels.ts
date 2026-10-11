/**
 * What the Friends and Leaderboard tabs hold for somebody with no account.
 *
 * Both tabs stay where a signed-in player finds them, wearing a lock, because
 * hiding them hid the reason to make an account at all: the one screen a guest
 * sees is the place to say what an account adds. Neither panel asks the server
 * anything -- the blurred rows on the board are drawn here, not fetched.
 *
 * Both actions are links, not handlers: `#/signup` passes through the age
 * screen (age.ts) and `#/login` is the sign-in form, and after either the
 * router brings the player back to `#/play` signed in, where the guest-import
 * card offers the progress made here.
 */
import { el } from "./dom.js";
import { TROPHY } from "./brand.js";

const icon = (tone: string, path: string) => el("span", { class: `pitch-icon ${tone}`, "aria-hidden": "true",
  html: `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">${path}</svg>` });
const BOLT = '<path d="M13.5 2 5 13.5h6L10 22l9-12h-6.2L13.5 2Z"/>';
const HEART = '<path d="M12 20.5s-8-4.9-8-11A4.5 4.5 0 0 1 12 6.4a4.5 4.5 0 0 1 8 3.1c0 6.1-8 11-8 11Z"/>';
const STAR = '<path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8L12 3Z"/>';

const actions = () => [
  el("a", { class: "qm-go pitch-go", href: "#/signup" }, "Create a free account"),
  el("a", { class: "ghost pitch-signin", href: "#/login" }, "Sign in"),
];

/** The Friends tab: what an account adds, then the keys for playing here. */
export function guestFriends(): HTMLElement {
  return el("div", { class: "guest-panel" },
    el("section", { class: "online-card", "aria-labelledby": "online-title" },
      el("h3", { id: "online-title" }, "Play online"),
      el("p", {}, "Your progress here stays on this device. A free account takes it everywhere."),
      el("ul", { class: "pitch-list" },
        el("li", {}, icon("water", BOLT), "Quick Match with someone new"),
        el("li", {}, icon("fire", HEART), "Invite friends and keep a shared save"),
        el("li", {}, icon("gold", STAR), "Post your times on the leaderboard")),
      ...actions(),
      el("p", { class: "pitch-fine" }, "Accounts are for ages 13 and up. You keep this device's progress when you sign up.")),
    el("section", { class: "local-keys", "aria-labelledby": "local-keys-title" },
      el("h3", { id: "local-keys-title" }, "Playing here together"),
      el("p", { class: "keyrow fire-control" }, "Fireboy", el("kbd", {}, "← ↑ →")),
      el("p", { class: "keyrow water-control" }, "Watergirl", el("kbd", {}, "W A D"))));
}

/** The Leaderboard tab: what is behind the lock, and no request to find out. */
export function guestBoard(): HTMLElement {
  return el("section", { class: "online-card board-lock", "aria-labelledby": "board-lock-title" },
    el("p", { class: "board-title" }, el("span", { class: "trophy-mark", "aria-hidden": "true", html: TROPHY }),
      "Two players. One great time."),
    el("h3", { id: "board-lock-title" }, "See the fastest pairs"),
    el("p", {}, "The leaderboard is for players with an account, so names are only shown to other players."),
    el("div", { class: "ghost-rows", "aria-hidden": "true" }, el("i"), el("i"), el("i"), el("i")),
    ...actions());
}
