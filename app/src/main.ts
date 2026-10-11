/**
 * Boot: work out who is signed in, then hand over to the router.
 *
 * The auth state is resolved before the first screen is drawn, so nobody sees
 * a sign-in form flash past on their way to the game.
 */
import "./ui/styles.css";
import { auth, onAuth, preloadAuth, startAuth } from "./auth.js";
import { rerender, startRouter, Route } from "./router.js";
import {
  loginScreen, passwordScreen, reportSignInTrouble, resetScreen, signUpScreen,
  troubleScreen, unlockScreen, usernameScreen, verifyScreen,
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

/**
 * The play screen, for whoever is in front of it: signed in, the full screen;
 * signed out, the same screen as a guest (see the guest note in play.ts).
 *
 * The router leaves a screen up while its route still admits the stage, and
 * /play admits both -- so the change between them is made here. Signing in
 * (in this tab or another) builds it again signed in, where the guest-import
 * card offers the progress just made. Signing out goes to the sign-in form, as
 * it always has: leaving an account is not a request to start playing as a
 * guest on a computer that may be shared.
 */
const play = lazy(async () => {
  // Signed in, the account-only half (online.ts) starts downloading NOW, beside
  // the screen and the engine rather than after them. A guest never asks for it.
  const online = auth().stage === "out" ? null : import("./online.js");
  const [{ playScreen }, loaded] = await Promise.all([import("./screens/play.js"), online]);
  return (host) => {
    const stage = auth().stage;
    // Signed in while the guest screen was downloading: build it again, which
    // fetches the online half this time.
    if (stage !== "out" && !loaded) { rerender(); return; }
    const off = onAuth(next => {
      if (next.stage === stage) return;
      if (next.stage === "in") rerender();
      else if (next.stage === "out") location.hash = "/login";
    });
    const end = playScreen(host, loaded && stage !== "out" ? { online: loaded } : { guest: true });
    return () => { off(); end(); };
  };
});

/**
 * A form whose next step is the Supabase client, which a signed-out visitor has
 * not downloaded (see `startAuth`): fetch it while they type, not after Submit.
 */
const warm = (render: Route["render"]): Route["render"] => (host) => { preloadAuth(); return render(host); };

const routes: Route[] = [
  // The bare site address, signed out: the landing page. Signed in, the router
  // sends the same address straight to /play, because this admits "out" only.
  { path: "/", stages: ["out"], render: lazy(async () => (await import("./screens/landing.js")).landingScreen) },
  { path: "/login", stages: ["out"], render: warm(loginScreen) },
  { path: "/signup", stages: ["out"], render: warm(signUpScreen) },
  // Signed-in stages too, because the reset code signs this tab in from the
  // reset screen itself; admitting them keeps the router from moving the tab
  // somewhere else before the screen sends it on to /password.
  { path: "/reset", stages: ["out", "in", "nameless"], render: warm(resetScreen) },
  // The old address of the guest page, kept for links already out there. It
  // is the same screen as /play signed out; signed in, the router sends it on
  // to /play, which this does not admit.
  { path: "/local", stages: ["out"], render: play },
  // Reached from the emailed link, which arrives with a session already.
  { path: "/password", stages: ["in", "nameless"], render: passwordScreen },
  // "out" as well as "unverified", and that is the whole fix for a sign-up that
  // used to vanish. Confirmation means no session until the link is followed,
  // so a person who has just signed up is "out" -- and this route admitting
  // only "unverified" is what bounced every one of them to /login in silence.
  { path: "/verify", stages: ["out", "unverified"], render: warm(verifyScreen) },
  { path: "/unlock", stages: ["locked"], render: unlockScreen },
  { path: "/username", stages: ["nameless"], render: usernameScreen },
  { path: "/play", stages: ["in", "out"], render: play },
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
  if (refused) {
    reportSignInTrouble(refused);
    // The answer comes back to the bare address, which is now the landing
    // page; the sign-in form is where the message is shown and acted on.
    if (!location.hash || location.hash === "#/") location.hash = "/login";
  }
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
