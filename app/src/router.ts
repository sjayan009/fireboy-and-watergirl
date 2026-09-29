/**
 * A hash router with one job beyond routing: never show a screen the current
 * account is not standing in front of.
 *
 * Each route declares which of the five sign-in stages may see it. Anything
 * else is redirected to the screen that stage actually needs -- so a half
 * signed-up account cannot linger on the lobby, and a signed-in one cannot sit
 * on the login form.
 *
 * The hash rather than the History API because the app is served as static
 * files from a CDN with no server in the request path. A deep link to
 * `/settings` would need a rewrite rule and a serverless hop to answer; a deep
 * link to `#/settings` needs neither.
 */
import { auth, onAuth, Stage } from "./auth.js";

export interface Route {
  path: string;
  /** Which sign-in stages may see this screen. */
  stages: Stage[];
  render(host: HTMLElement): void | (() => void);
}

/** Where a stage belongs when it asks for something it may not see. */
const HOME: Record<Stage, string> = {
  out: "/login",
  unverified: "/verify",
  locked: "/unlock",
  nameless: "/username",
  in: "/play",
  // Not a gate somebody passes through: it is where the app goes when it could
  // not find out which gate they are at. Failing to a screen that says so is
  // the whole point -- the alternative, and what used to happen, was failing to
  // whichever answer the error happened to look like.
  unavailable: "/trouble",
};

let routes: Route[] = [];
let host: HTMLElement;
let cleanup: (() => void) | null = null;
/**
 * The whole hash of the screen on show, query and all.
 *
 * The ROUTE is the path alone -- `#/watch?t=…` is the watch screen -- but what
 * is on show is the path plus its argument, and conflating the two meant a link
 * from one game to another was a hash change the router answered by doing
 * nothing, because it was already "showing /watch".
 */
/**
 * Null, not "", for "nothing on screen yet": the bare address (the landing
 * page) is the empty hash, and "" here would read as already showing it.
 */
let showing: string | null = null;

export function go(path: string): void {
  if (current() === path) render();
  else location.hash = path;
}

function current(): string {
  // The query is not part of the route. `#/watch?t=watch:a:b` is the watch
  // screen with an argument, and matching on the whole hash made it a path no
  // route claimed -- so it was redirected home, which looks from the outside
  // like a link that does nothing. Screens read their own arguments off the
  // hash; the router only decides which screen.
  const raw = location.hash.replace(/^#/, "").split("?")[0];
  return raw.startsWith("/") ? raw : "/";
}

function render(): void {
  const path = current();
  const stage = auth().stage;
  const route = routes.find((r) => r.path === path);

  if (!route) { go(HOME[stage]); return; }
  if (!route.stages.includes(stage)) { go(HOME[stage]); return; }

  // Re-rendering the screen already showing would tear down a running game to
  // put the same one back.
  const here = location.hash.replace(/^#/, "");
  if (showing === here) return;
  cleanup?.();
  cleanup = null;
  showing = here;
  host.replaceChildren();
  const off = route.render(host);
  if (typeof off === "function") cleanup = off;
}

export function startRouter(mount: HTMLElement, table: Route[]): void {
  host = mount;
  routes = table;
  addEventListener("hashchange", render);
  // A sign-in or sign-out can invalidate the screen being shown, so the guard
  // has to run again whenever the stage changes -- not only on navigation.
  onAuth(() => {
    const route = routes.find((r) => r.path === current());
    if (!route || !route.stages.includes(auth().stage)) {
      showing = null;
      go(HOME[auth().stage]);
    }
  });
  render();
}

/** Force the current screen to be built again, after something it reads changed. */
export function rerender(): void {
  showing = null;
  render();
}
