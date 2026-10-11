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
 * Nothing here touches the watcher's own save, and now there is a mechanism
 * behind that sentence rather than only an intention. The view is handed a
 * `MemorySave`: the medals and times on screen are the pair's, `Recuent` writes
 * them the moment a watched level ends, and the store it writes them into goes
 * when this screen does. Before, the view inherited whatever the module-global
 * save factory was last set to -- this browser's own progress on a fresh load,
 * and the PAIR's after a visit to play -- so watching a friend finish a level
 * unlocked it for the watcher.
 */
import { GameView, STAGE_W, STAGE_H } from "@engine/embed.js";
import { MemorySave } from "@engine/game/save.js";
import { WatchChannel } from "../net/watchchannel.js";
import { RealtimeTransport } from "../net/realtime.js";
import { auth, signOut } from "../auth.js";
import { supabase } from "../supabase.js";
import { el } from "../ui/dom.js";
import { PlayShell } from "../ui/playshell.js";
import { Leaderboard } from "../ui/leaderboard.js";
import { FriendsPanel } from "./friends.js";
import { settingsScreen } from "./settings.js";
import { presentationPreferences, PRESENTATION_CHANGED } from "../presentation.js";

const MUTE_KEY = "fbwg.muted";

export function watchScreen(host: HTMLElement): () => void {
  const canvas = el("canvas", {
    id: "stage", width: STAGE_W, height: STAGE_H, tabindex: "0",
    // The game is pixels: none of its menus, results or characters exist in the
    // accessibility tree, and an unnamed focusable canvas is a dead end for
    // anybody arriving by keyboard or screen reader. A name and a description
    // do not make it playable -- that needs a real alternative interface -- but
    // they do say what this thing is and that it wants no input.
    role: "img",
    "aria-label": "The game being watched",
    "aria-describedby": "play-keys",
  });

  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === "1"; } catch { muted = false; }

  // A live region, so a watcher who cannot see the canvas still hears the game
  // start, stall and end. `polite` rather than `assertive`: it changes on its
  // own schedule and never needs to interrupt.
  const status = el("span", {
    class: "status", role: "status", "aria-live": "polite",
  }, "joining…");
  const mute = el("button", { class: "ghost" }, muted ? "Unmute" : "Mute");
  const banner = el("div", {
    class: "banner", role: "status", "aria-live": "polite",
  });
  banner.hidden = true;
  const name = auth().profile?.username ?? "";

  let lastStatus = "";
  let feedMessage = "Connecting to the game…";
  const presentation = presentationPreferences();
  const view = new GameView({
    canvas,
    assets: __ASSETS__,
    presentationFps: presentation.fps, outputScale: presentation.scale,
    // Watching writes nowhere. See the note at the top of this file.
    save: new MemorySave(),
    onFrame: () => {
      const next = describe();
      if (next !== lastStatus) { status.textContent = next; lastStatus = next; }
    },
  });
  view.setMuted(muted);
  view.setInputEnabled(false);
  const changePresentation = (event: Event) => {
    const p = (event as CustomEvent<{ fps: number; scale: number }>).detail;
    view.configurePresentation(p.fps, p.scale);
  };
  addEventListener(PRESENTATION_CHANGED, changePresentation);

  function describe(): string {
    const s = view.session;
    if (!s) return feedMessage;
    if (!s.running) return "Waiting for the next level";
    return "Watching together";
  }

  mute.addEventListener("click", () => {
    view.setMuted(!view.isMuted);
    muted = view.isMuted;
    mute.textContent = muted ? "Unmute" : "Mute";
    mute.setAttribute("aria-pressed", String(muted));
    try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch { /* private */ }
  });

  const friends = el("div");
  const board = el("div");
  const leaderboard = new Leaderboard(board, () => view.game.Translation as string[] | undefined);
  const shell = new PlayShell(host, {
    canvas, name, status, mute, banner, friends, board,
    times: el("p", {class:"note"}, "Watching does not change your own progress. Return to your game to see your best times."),
    watching: true, settings: settingsScreen, input: () => { view.setInputEnabled(false); },
    primaryAction: el("a", {class:"ghost stop-watching",href:"#/play"},"Stop watching"),
    onPanel: (panel, changed) => { if (panel === "leaderboard") leaderboard.open(view.session?.selection, changed); },
    actions: [el("button", {class:"ghost",onclick:async()=>{await signOut();}},"Sign out")],
  });
  shell.saveStatus.textContent = "Spectator";
  shell.saveStatus.disabled = true;
  const friendsUI = new FriendsPanel(friends, {
    onChange: list => shell.friends(list.filter(f => f.status === "accepted" && f.activity !== null).length),
  });

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__fbwgWatch = { view };
  }

  function say(text: string): void {
    feedMessage = text;
    banner.hidden = false;
    banner.replaceChildren(el("span", {}, text));
  }

  // The topic rides in the hash, because that is where this screen was linked
  // from and there is nothing else to identify a game by.
  const topic = new URLSearchParams(location.hash.split("?")[1] ?? "").get("t");

  let room: WatchChannel | null = null;
  /**
   * Cancels the join, and everything that would have followed it.
   *
   * Joining a Realtime topic is a round trip, and leaving during one used to
   * mean the cleanup below ran while `room` was still null -- so it closed
   * nothing -- and then the completion handler attached a live channel and a
   * live session to a view that had already been destroyed. The signal now
   * reaches `WatchChannel.open`, which gives its channel back rather than
   * leaving it subscribed with nobody holding it.
   */
  const leaving = new AbortController();
  let replaying: AbortController | null = null;
  let authorization: ReturnType<typeof setTimeout> | null = null;
  async function authorize(): Promise<void> {
    if (leaving.signal.aborted || !topic) return;
    const { data,error } = await supabase.rpc("can_watch_pair_topic", { topic });
    if (leaving.signal.aborted) return;
    if (error || data !== true) {
      replaying?.abort(); view.leave(); void room?.close();
      say("This game is no longer available to watch."); return;
    }
    authorization = setTimeout(() => { void authorize(); },5000);
  }

  if (!topic) {
    say("No game to watch. Pick one from your friends list.");
  } else {
    WatchChannel.open(topic, leaving.signal, true).then((w) => {
      if (leaving.signal.aborted) { void w.close(); return; }
      room = w;
      // The same transport the relayed pairs use, over a different topic. It
      // only ever needed a channel it could read bytes from, write bytes to and
      // hear the status of -- and a watcher uses two of the three.
      const transport = new RealtimeTransport(w);
      view.observe(transport, {
        // A level ending and a player leaving are the same command and nothing
        // alike to somebody watching: one is followed by the next level, the
        // other is not followed by anything.
        onQuit: (_bySlot, forGood) => say(forGood
          ? "One of them left. There is nothing more to watch."
          : "That level ended. Waiting for the next one."),
        onLinkDown: () => say("Lost the connection to that game."),
      });
      w.onSnapshot((text,epoch) => {
        if (replaying) return;
        replaying = new AbortController();
        say("Catching up to the current game…");
        void view.session!.loadConfirmedReplay(text,epoch,replaying.signal).then(() => {
          if (!leaving.signal.aborted) banner.hidden = true;
        }).catch(() => {
          if (!leaving.signal.aborted) say("Could not catch up. Reopen this game to retry.");
        }).finally(() => { replaying = null; });
      });
      void authorize();
      say("Connected. Preparing the current game…");
      canvas.focus();
    }).catch((e) => {
      if (leaving.signal.aborted) return;
      say(`Could not watch that game: ${(e as Error).message}`);
    });
  }

  return () => {
    removeEventListener(PRESENTATION_CHANGED, changePresentation);
    shell.destroy(); friendsUI.destroy(); leaderboard.destroy();
    leaving.abort();
    replaying?.abort();
    if (authorization !== null) clearTimeout(authorization);
    view.leave();
    view.destroy();
    void room?.close();
  };
}
