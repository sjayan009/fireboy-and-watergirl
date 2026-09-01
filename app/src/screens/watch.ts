/**
 * Somebody else's game, on your screen.
 *
 * The same engine, the same canvas, the same everything -- the difference is
 * entirely in who is holding the controls, which is nobody here. Determinism is
 * what makes that cheap: the simulation is a pure function of the level and the
 * input log, so a watcher fed the two players' three bits each per frame
 * arrives at the same world without either of them computing anything for it.
 *
 * A watcher who arrives mid-level waits for the next one. That is not a
 * limitation being tolerated so much as one being chosen: catching up means the
 * pair sending their whole input history to anybody who asks, and the alternative
 * -- starting from wherever they are now -- would simulate a world that never
 * existed and call it their game.
 *
 * Nothing here touches the watcher's own save. `pairProgress` is deliberately
 * not involved: the medals on screen are the pair's, and adopting them would
 * write somebody else's progress into this browser.
 */
import { GameView, STAGE_W, STAGE_H } from "@engine/embed.js";
import { WatchChannel } from "../net/watchchannel.js";
import { RealtimeTransport } from "../net/realtime.js";
import { auth, signOut } from "../auth.js";
import { el } from "../ui/dom.js";

const MUTE_KEY = "fbwg.muted";

export function watchScreen(host: HTMLElement): () => void {
  const canvas = el("canvas", {
    id: "stage", width: STAGE_W, height: STAGE_H, tabindex: "0",
  });

  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === "1"; } catch { muted = false; }

  const status = el("span", { class: "status" }, "joining…");
  const mute = el("button", { class: "ghost" }, muted ? "Unmute" : "Mute");
  const banner = el("div", { class: "banner" });
  banner.hidden = true;
  const name = auth().profile?.username ?? "";

  let lastStatus = "";
  const view = new GameView({
    canvas,
    onFrame: () => {
      const next = describe();
      if (next !== lastStatus) { status.textContent = next; lastStatus = next; }
    },
  });
  view.setMuted(muted);

  function describe(): string {
    const s = view.session;
    if (!s) return "joining…";
    if (!s.running) return "watching · waiting for them to start a level";
    return `watching · frame ${s.frame}`;
  }

  mute.addEventListener("click", () => {
    view.setMuted(!view.isMuted);
    muted = view.isMuted;
    mute.textContent = muted ? "Unmute" : "Mute";
    try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch { /* private */ }
  });

  host.append(el("div", { class: "play" },
    el("header", { class: "bar" },
      el("span", { class: "who" }, name),
      status,
      el("span", { class: "spacer" }),
      mute,
      el("a", { class: "ghost", href: "#/play" }, "Stop watching"),
      el("a", { class: "ghost", href: "#/friends" }, "Friends"),
      el("button", {
        class: "ghost",
        onclick: async () => { await signOut(); },
      }, "Sign out")),
    banner,
    el("div", { class: "screen" }, canvas),
    el("p", { class: "keys" },
      "You are watching. The controls belong to the two people playing.")));

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__fbwgWatch = { view };
  }

  function say(text: string): void {
    banner.hidden = false;
    banner.replaceChildren(el("span", {}, text));
  }

  // The topic rides in the hash, because that is where this screen was linked
  // from and there is nothing else to identify a game by.
  const topic = new URLSearchParams(location.hash.split("?")[1] ?? "").get("t");

  let room: WatchChannel | null = null;

  if (!topic) {
    say("No game to watch. Pick one from your friends list.");
  } else {
    WatchChannel.open(topic).then((w) => {
      room = w;
      // The same transport the relayed pairs use, over a different topic. It
      // only ever needed a channel it could read bytes from, write bytes to and
      // hear the status of -- and a watcher uses two of the three.
      const transport = new RealtimeTransport(w);
      view.observe(transport, {
        onQuit: () => say("They finished that level."),
        onLinkDown: () => say("Lost the connection to that game."),
      });
      say("Connected. Waiting for them to start a level.");
      canvas.focus();
    }).catch((e) => {
      say(`Could not watch that game: ${(e as Error).message}`);
    });
  }

  return () => {
    view.leave();
    view.destroy();
    void room?.close();
  };
}
