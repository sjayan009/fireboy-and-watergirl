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
};

let routes: Route[] = [];
let host: HTMLElement;
let cleanup: (() => void) | null = null;
let showing = "";

export function go(path: string): void {
  if (location.hash === "#" + path) render();
  else location.hash = path;
}

function current(): string {
  const raw = location.hash.replace(/^#/, "");
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
  if (showing === path) return;
  cleanup?.();
  cleanup = null;
  showing = path;
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
      showing = "";
      go(HOME[auth().stage]);
    }
  });
  render();
}

/** Force the current screen to be built again, after something it reads changed. */
export function rerender(): void {
  showing = "";
  render();
}
