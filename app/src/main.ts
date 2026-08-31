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
  loginScreen, passwordScreen, resetScreen, signUpScreen, unlockScreen,
  usernameScreen, verifyScreen,
} from "./screens/accounts.js";
import { playScreen } from "./screens/play.js";
import { friendsScreen } from "./screens/friends.js";
import { settingsScreen } from "./screens/settings.js";

const routes: Route[] = [
  { path: "/login", stages: ["out"], render: loginScreen },
  { path: "/signup", stages: ["out"], render: signUpScreen },
  { path: "/reset", stages: ["out"], render: resetScreen },
  // Reached from the emailed link, which arrives with a session already.
  { path: "/password", stages: ["in", "nameless"], render: passwordScreen },
  { path: "/verify", stages: ["unverified"], render: verifyScreen },
  { path: "/unlock", stages: ["locked"], render: unlockScreen },
  { path: "/username", stages: ["nameless"], render: usernameScreen },
  { path: "/play", stages: ["in"], render: playScreen },
  { path: "/friends", stages: ["in"], render: friendsScreen },
  { path: "/settings", stages: ["in"], render: settingsScreen },
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
const wanted = new URLSearchParams(location.search).get("intent");

startAuth().then(() => {
  if (location.search) {
    history.replaceState(null, "", location.pathname + location.hash);
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
