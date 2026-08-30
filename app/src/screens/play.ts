/**
 * The game, and the people to play it with.
 *
 * Everything on this screen except the canvas is chrome: the canvas is a fixed
 * 640x480 stage scaled by CSS, exactly as the 2009 SWF was, and the engine
 * neither knows nor cares how big it is drawn.
 *
 * The level is chosen HERE rather than on the game's own map, and that is not
 * laziness. The netcode synchronises the simulation, not the menus -- a mouse
 * click on the map is not part of the six bits two peers exchange -- so the one
 * place the pair can agree on which level to start is before the session
 * exists.
 */
import { GameView, STAGE_W, STAGE_H } from "@engine/embed.js";
import { LocalSave, setSaveStore } from "@engine/game/save.js";
import { pairProgress } from "../pairsave.js";
import type { Invite } from "../net/pairchannel.js";
import { auth, signOut } from "../auth.js";
import { clear, el } from "../ui/dom.js";
import { FriendState, getLobby, Lobby, Ready } from "../lobby.js";

const MUTE_KEY = "fbwg.muted";

/** The 32 levels, as the map numbers them. */
const MODES: [string, string, number][] = [
  ["adventure", "Adventure", 17],
  ["puzzle", "Puzzle", 9],
  ["speed", "Speed", 6],
];

export function playScreen(host: HTMLElement): () => void {
  const canvas = el("canvas", {
    id: "stage", width: STAGE_W, height: STAGE_H, tabindex: "0",
  });

  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === "1"; } catch { muted = false; }

  // Installed BEFORE the Game is built: its constructor calls `openSave` once
  // and holds the result forever, so a store handed over afterwards would never
  // be seen. Alone it is this browser's localStorage; in a pair session it
  // becomes the pair's shared map and then hands the solo one back.
  const progress = pairProgress(new LocalSave("FBCookie"));
  setSaveStore(() => progress.store);

  const status = el("span", { class: "status" }, "solo");
  const mute = el("button", { class: "ghost" }, muted ? "Unmute" : "Mute");
  const banner = el("div", { class: "banner" });
  banner.hidden = true;
  const panel = el("div", { class: "panel" });
  const name = auth().profile?.username ?? "";

  const view = new GameView({
    canvas,
    onFrame: (v) => {
      const s = v.session;
      status.textContent = !s
        ? "solo"
        : `${v.slot === 0 ? "Fireboy" : "Watergirl"} · ${linkKind} · ` +
          (s.stalled ? "waiting for the other player" : "in step") +
          (s.desyncs ? ` · ${s.desyncs} desync(s)` : "");
    },
  });
  view.setMuted(muted);

  let linkKind = "";
  let lobby: Lobby | null = null;

  mute.addEventListener("click", () => {
    muted = !muted;
    view.setMuted(muted);
    mute.textContent = muted ? "Unmute" : "Mute";
    try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch { /* private */ }
  });

  host.append(el("div", { class: "play" },
    el("header", { class: "bar" },
      el("span", { class: "who" }, name),
      status,
      el("span", { class: "spacer" }),
      mute,
      el("a", { class: "ghost", href: "#/friends" }, "Friends"),
      el("a", { class: "ghost", href: "#/settings" }, "Settings"),
      el("button", {
        class: "ghost",
        onclick: async () => { await signOut(); },
      }, "Sign out")),
    banner,
    el("div", { class: "screen" }, canvas),
    el("p", { class: "keys" },
      "Fireboy: arrow keys. Watergirl: W, A, D. P pauses, R retries."),
    panel));

  canvas.focus();

  // A deliberate hook, and only in development. Asking whether two people are
  // simulating the same game is not something the DOM can answer, so the
  // end-to-end test needs a way in; shipping that way in to production would be
  // handing every page a handle on the running game for no reason.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__fbwg = {
      view, progress, get lobby() { return lobby; },
    };
  }

  // ---- the lobby ---------------------------------------------------------

  panel.append(el("p", { class: "note" }, "Connecting to your friends…"));

  // Handlers registered here are unregistered on the way out; the lobby itself
  // outlives this screen, so an invitation still arrives while you are looking
  // at your friends list.
  let unsubscribe: (() => void)[] = [];

  getLobby().then(async (l) => {
    lobby = l;
    // The list may be stale if a friendship was accepted on another screen.
    await l.refresh();
    void l.setActivity("in_lobby");
    unsubscribe.push(l.onChange((friends) => drawPanel(friends)));
    unsubscribe.push(l.onInvite((invite, from) => showInvite(invite, from)));
  }).catch((e) => {
    panel.replaceChildren(el("p", { class: "note" },
      `Could not reach your friends list: ${(e as Error).message}`));
  });

  function drawPanel(friends: FriendState[]): void {
    const accepted = friends.filter((f) => f.status === "accepted");
    clear(panel);
    panel.append(el("h2", {}, "Play together"));

    if (accepted.length === 0) {
      panel.append(el("p", { class: "note" },
        "You have no friends here yet. ",
        el("a", { href: "#/friends" }, "Add one"),
        " — the game needs two people."));
      return;
    }

    for (const f of accepted) {
      const online = f.activity !== null;
      panel.append(el("div", { class: "row" },
        el("span", { class: `dot ${f.activity ?? "off"}` }),
        el("span", { class: "name" }, f.username),
        el("span", { class: "dim" },
          f.activity === "in_game" ? "in a game"
          : f.activity ? "online" : "offline"),
        el("button", {
          class: "ghost", disabled: !online || view.session !== null,
          onclick: () => showInviteForm(f),
        }, "Invite")));
    }
  }

  /** Choose the level and the roles, then send the invitation. */
  function showInviteForm(friend: FriendState): void {
    const mode = el("select", { class: "pick" },
      ...MODES.map(([value, label]) => el("option", { value }, label)));
    const num = el("select", { class: "pick" });
    const roles = el("select", { class: "pick" },
      el("option", { value: "me" }, `${auth().profile?.username} is Fireboy`),
      el("option", { value: "them" }, `${friend.username} is Fireboy`));

    const fillNumbers = () => {
      const count = MODES.find(([v]) => v === mode.value)?.[2] ?? 1;
      num.replaceChildren(...Array.from({ length: count }, (_, i) =>
        el("option", { value: String(i + 1) }, `Level ${i + 1}`)));
    };
    fillNumbers();
    mode.addEventListener("change", fillNumbers);

    const say = el("span", { class: "dim" });
    const go = el("button", { class: "primary small" }, "Send invite");

    banner.hidden = false;
    clear(banner);
    banner.append(
      el("span", {}, `Invite ${friend.username}:`), mode, num, roles, go, say,
      el("button", {
        class: "ghost", onclick: () => { banner.hidden = true; },
      }, "Cancel"));

    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        say.textContent = "loading your progress…";
        await progress.adopt(friend.id);
        const ready = await lobby!.invite(friend.id, {
          mode: mode.value,
          num: Number(num.value),
          iAmFireboy: roles.value === "me",
          onProgress: (what) => { say.textContent = what; },
        });
        begin(ready);
      } catch (e) {
        progress.release();
        say.textContent = (e as Error).message;
        go.disabled = false;
      }
    });
  }

  function showInvite(invite: Invite, from: FriendState): void {
    if (view.session) return;          // already playing
    const mine = invite.fireboy === auth().user?.id;
    const say = el("span", { class: "dim" });
    const yes = el("button", { class: "primary small" }, "Play");

    banner.hidden = false;
    clear(banner);
    banner.append(
      el("span", {},
        `${from.username} wants to play ${invite.mode} ${invite.num}. ` +
        `You would be ${mine ? "Fireboy" : "Watergirl"}.`),
      yes, say,
      el("button", {
        class: "ghost", onclick: () => { banner.hidden = true; },
      }, "Not now"));

    yes.addEventListener("click", async () => {
      yes.disabled = true;
      try {
        // Adopted before answering, not after. Saying "ready" is what tells the
        // other side to send Start, and the level must not begin against this
        // browser's solo progress -- `Recuent` compares the run it has just
        // finished against what is stored to decide whether it was an
        // improvement, and it has to be the PAIR's best it compares against.
        say.textContent = "loading your progress…";
        await progress.adopt(from.id);
        begin(await lobby!.join(invite, (what) => { say.textContent = what; }));
      } catch (e) {
        progress.release();
        say.textContent = (e as Error).message;
        yes.disabled = false;
      }
    });
  }

  /** Hand the clock to the session, and start the level if we are the host. */
  function begin(ready: Ready): void {
    linkKind = ready.kind === "webrtc" ? "direct" : "relay";
    banner.hidden = true;
    void lobby?.setActivity("in_game");

    const session = view.join(ready.transport, ready.slot, (f, mine, theirs) =>
      console.warn(`desync at frame ${f}: ${mine} != ${theirs}`));
    if (ready.host) session.requestStart(ready.mode, ready.num);
    canvas.focus();
    drawPanel(lobby?.list ?? []);
  }

  // Tearing the view down matters: it owns a requestAnimationFrame loop, window
  // key listeners and an audio context. The LOBBY is deliberately left alone --
  // it belongs to the session, and closing it here would take the pair offline
  // to each other every time somebody opened their friends list.
  return () => {
    // Release before destroy: it sends whatever the pair earned and puts the
    // solo progress back, and `view.destroy()` flushes what it finds.
    progress.release();
    view.destroy();
    for (const off of unsubscribe) off();
    unsubscribe = [];
    void lobby?.setActivity("online");
  };
}
