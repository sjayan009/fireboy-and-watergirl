/**
 * Boot: work out who is signed in, then hand over to the router.
 *
 * The auth state is resolved before the first screen is drawn, so nobody sees
 * a sign-in form flash past on their way to the game.
 */
import "./ui/styles.css";
import { startAuth } from "./auth.js";
import { startRouter, Route } from "./router.js";
import {
  linkScreen, loginScreen, passwordScreen, reportSignInTrouble, resetScreen,
  signUpScreen, troubleScreen, unlockScreen, usernameScreen, verifyScreen,
} from "./screens/accounts.js";
function lazy(load: () => Promise<Route["render"]>): Route["render"] {
  return (host) => {
    let gone = false;
    let cleanup: void | (() => void);
    const loading = document.createElement("p");
    loading.textContent = "Loading…";
    host.append(loading);
    void load().then(render => {
      if (gone) return;
      host.replaceChildren();
      cleanup = render(host);
    }).catch(() => {
      if (gone) return;
      loading.textContent = "Could not load this screen. Refresh to try again.";
    });
    return () => { gone = true; cleanup?.(); };
  };
}

const routes: Route[] = [
  { path: "/login", stages: ["out"], render: loginScreen },
  { path: "/signup", stages: ["out"], render: signUpScreen },
  { path: "/reset", stages: ["out"], render: resetScreen },
  { path: "/link", stages: ["out"], render: linkScreen },
  // Reached from the emailed link, which arrives with a session already.
  { path: "/password", stages: ["in", "nameless"], render: passwordScreen },
  { path: "/verify", stages: ["unverified"], render: verifyScreen },
  { path: "/unlock", stages: ["locked"], render: unlockScreen },
  { path: "/username", stages: ["nameless"], render: usernameScreen },
  { path: "/play", stages: ["in"], render: lazy(async () => (await import("./screens/play.js")).playScreen) },
  { path: "/friends", stages: ["in"], render: lazy(async () => (await import("./screens/friends.js")).friendsScreen) },
  { path: "/watch", stages: ["in"], render: lazy(async () => (await import("./screens/watch.js")).watchScreen) },
  { path: "/settings", stages: ["in"], render: lazy(async () => (await import("./screens/settings.js")).settingsScreen) },
  { path: "/trouble", stages: ["unavailable"], render: troubleScreen },
];

const host = document.getElementById("app")!;

/**
 * An emailed link comes back to the bare origin carrying `?code=` for the
 * session and `?intent=` for what it was for.
 *
 * The intent is only READ here. Clearing it has to wait until the Supabase
 * client has finished exchanging the code sitting beside it in the same query
 * string -- tidying the address bar first would throw the session away on the
 * way to tidying up after it.
 */
const arrived = new URLSearchParams(location.search);
const wanted = arrived.get("intent");

/**
 * Why the trip that just came back did not sign anybody in.
 *
 * Refusals use the same door as successes. `landing()` in `auth.ts` explains
 * why the round trip returns to the bare origin with its answer in the QUERY
 * string; what it does not say is that a FAILED trip returns the same way, with
 * `?error=` and `?error_description=` standing where `?code=` would have been.
 * So there is nothing to exchange, the stage stays `out`, the router shows the
 * sign-in form -- and without this that form is blank and silent, identical to
 * one nobody had touched. Somebody who just pressed a button and travelled to
 * Google and back is told nothing at all.
 *
 * Read here, beside `intent`, and for the same reason given above it: the
 * search string is thrown away a few lines down, and by the time a screen is
 * built there is nothing left to read.
 *
 * `access_denied` stays quiet. That is what comes back when somebody reaches
 * Google's consent screen and decides not to go on, and an error over the form
 * they deliberately returned to would be the app arguing with a choice it had
 * just asked them to make.
 *
 * Deliberately not worded as "Google". This query string is the whole front
 * door -- the emailed confirmation, the reset link and the invitation all come
 * back through it -- and a link that expired has nothing to do with Google.
 * Supabase's own description says which is which better than a guess here
 * would.
 */
function refusal(q: URLSearchParams): string {
  const code = q.get("error");
  if (!code || code === "access_denied") return "";
  return `Sign-in did not go through: ${q.get("error_description") ?? code}`;
}

const refused = refusal(arrived);

startAuth().then(() => {
  if (location.search) {
    history.replaceState(null, "", location.pathname + location.hash);
  }
  if (refused) reportSignInTrouble(refused);
  // A password reset lands signed in, so the stage alone cannot tell that the
  // point of arriving was to choose a new password.
  if (wanted === "password") location.hash = "/password";
  // An address change lands signed in too, and with nothing left to do -- the
  // link WAS the confirmation. Settings is where the new address is on screen.
  if (wanted === "email") location.hash = "/settings";
  startRouter(host, routes);
}).catch((e) => {
  host.replaceChildren();
  const p = document.createElement("p");
  p.className = "error";
  p.textContent = `Could not reach the server: ${(e as Error).message}`;
  host.append(p);
});
