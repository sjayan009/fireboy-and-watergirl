/**
 * The game, and the people to play it with.
 *
 * Everything on this screen except the canvas is chrome: the canvas is a fixed
 * 640x480 stage scaled by CSS, exactly as the 2009 SWF was, and the engine
 * neither knows nor cares how big it is drawn.
 *
 * The FIRST level is chosen here rather than on the game's own map, because
 * before a session exists there is nowhere else the pair could agree. Every
 * level after it is chosen on the map, by the person who sent the invitation:
 * between levels both maps are live and local, and without a single decider two
 * people clicking different nodes at the same moment would each start their own
 * and there would be no way back.
 *
 * ## Which buttons are whose
 *
 * Two categories, and confusing them is the bug this screen used to be full of.
 *
 * Anything that changes what the engine simulates -- retry, pause, quit to the
 * map, picking a level -- goes out as a command and is applied on a frame both
 * peers agree on. `GameView` does that through the shell's intent hook; nothing
 * here has to think about it.
 *
 * Anything else is this person's own -- mute, which screen of the app they are
 * looking at, this banner -- and never travels.
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

/**
 * How long the other peer may be silent before it is worth saying so.
 *
 * Two seconds at 26 frames a second. Shorter and every jittery moment would
 * flash a warning at somebody whose game is about to carry on perfectly well.
 */
const STALL_FRAMES = 52;

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
  const leave = el("button", { class: "ghost" }, "Leave game");
  leave.hidden = true;
  const banner = el("div", { class: "banner" });
  banner.hidden = true;
  const panel = el("div", { class: "panel" });
  const name = auth().profile?.username ?? "";

  let linkKind = "";
  let lobby: Lobby | null = null;
  /** Who we are paired with, for as long as the session lasts. */
  let partner: FriendState | null = null;
  /**
   * An invitation in flight, in either direction.
   *
   * `session` is set only for one we RECEIVED, because that is the only case
   * this screen has to match a cancel against: a cancel of our own outbound
   * invitation comes back as a rejection from `Lobby.invite` instead.
   */
  let pending: { session: string | null; abort: AbortController } | null = null;
  /** A transient line in the banner: a stall, a refusal, somebody leaving. */
  let noticeText = "";
  /** What the status line last said, so it is not rewritten 26 times a second. */
  let lastStatus = "";

  const view = new GameView({
    canvas,
    onFrame: () => {
      const next = describe();
      if (next !== lastStatus) { status.textContent = next; lastStatus = next; }
      // The game has a mute button of its own, inside the canvas, and in a
      // session it now drives this same local mute -- so neither button can own
      // the label and it is read back from the one thing both of them set.
      if (view.isMuted !== muted) syncMute();
      watchStall();
    },
    onRefused: (why) => {
      if (why === "not-your-pick") {
        notice(`Waiting for ${partner?.username ?? "them"} to pick the ` +
               "next level.");
      }
    },
  });
  view.setMuted(muted);

  /** The one line in the header that says what is going on. */
  function describe(): string {
    const s = view.session;
    if (!s) return "solo";
    const who = partner?.username ?? "your friend";
    if (!s.running) return `with ${who} · ${linkKind} · choosing a level`;
    return `${view.slot === 0 ? "Fireboy" : "Watergirl"} · ${linkKind} · ` +
      (s.stalled ? "waiting for the other player" : "in step") +
      (s.desyncs ? ` · ${s.desyncs} desync(s)` : "");
  }

  mute.addEventListener("click", () => {
    view.setMuted(!view.isMuted);
    syncMute();
  });

  /**
   * Keep the button honest.
   *
   * The game has its own mute button inside the canvas, and in a session that
   * one now drives the same local mute this one does -- so the label cannot be
   * owned by whichever of the two was pressed last.
   */
  function syncMute(): void {
    muted = view.isMuted;
    mute.textContent = muted ? "Unmute" : "Mute";
    try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch { /* private */ }
  }

  leave.addEventListener("click", () => endSession("You left the game."));

  host.append(el("div", { class: "play" },
    el("header", { class: "bar" },
      el("span", { class: "who" }, name),
      status,
      el("span", { class: "spacer" }),
      mute,
      leave,
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

  // ---- the banner --------------------------------------------------------

  /** A one-line message, replacing whatever the banner was showing. */
  function notice(text: string, ...extra: (Node | string)[]): void {
    noticeText = text;
    banner.hidden = false;
    clear(banner);
    banner.append(el("span", {}, text), ...extra,
      el("button", {
        class: "ghost",
        onclick: () => { noticeText = ""; banner.hidden = true; },
      }, "Dismiss"));
  }

  function clearNotice(): void {
    if (!noticeText) return;
    noticeText = "";
    banner.hidden = true;
  }

  /**
   * Say something when the other peer has gone quiet.
   *
   * The session already stalls rather than guessing further than a correction
   * could reach back, so this reports a state it is in, not one it has to be
   * put into. It matters because the alternative -- a character that simply
   * stops -- is indistinguishable from the game having crashed.
   */
  let stalling = false;
  function watchStall(): void {
    const s = view.session;
    const bad = !!s && s.running && s.stalled && s.stalledFrames > STALL_FRAMES;
    if (bad === stalling) return;
    stalling = bad;
    if (bad) notice(`Waiting for ${partner?.username ?? "your friend"}…`);
    else if (noticeText.startsWith("Waiting for")) clearNotice();
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
    // Their invitation is gone: take the banner down whether or not this side
    // had got as far as pressing anything.
    unsubscribe.push(l.onCancel((session, from) => {
      if (!pending || pending.session !== session) return;
      pending = null;
      progress.release();
      notice(`${from.username} called that off.`);
    }));
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
          // Paired with somebody is paired with somebody, level or no level:
          // between levels the session is still up and still theirs. Leaving is
          // what makes this button live again, and there is a button for that.
          class: "ghost",
          disabled: !online || view.session !== null || pending !== null,
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

    // Cancel has to survive the click on "Send invite", because the whole point
    // is to be able to change your mind while it is out. It used to hide the
    // banner and nothing else, so the invitation carried on being accepted
    // behind it and the game started anyway.
    const stop = el("button", { class: "ghost" }, "Cancel");
    stop.addEventListener("click", () => {
      if (pending) { pending.abort.abort(); pending = null; }
      progress.release();
      banner.hidden = true;
      drawPanel(lobby?.list ?? []);
    });

    banner.hidden = false;
    noticeText = "";
    clear(banner);
    banner.append(
      el("span", {}, `Invite ${friend.username}:`), mode, num, roles, go, say,
      stop);

    go.addEventListener("click", async () => {
      go.disabled = true;
      const abort = new AbortController();
      // The session id belongs to the lobby, which mints it. Nothing here needs
      // it: a cancel of this invitation arrives as a rejection below.
      pending = { session: null, abort };
      try {
        say.textContent = "loading your progress…";
        await progress.adopt(friend.id);
        const ready = await lobby!.invite(friend.id, {
          mode: mode.value,
          num: Number(num.value),
          iAmFireboy: roles.value === "me",
          signal: abort.signal,
          onProgress: (what) => { say.textContent = what; },
        });
        pending = null;
        begin(ready);
      } catch (e) {
        pending = null;
        progress.release();
        say.textContent = (e as Error).message;
        go.disabled = false;
        drawPanel(lobby?.list ?? []);
      }
    });
  }

  function showInvite(invite: Invite, from: FriendState): void {
    if (view.session) return;          // already playing
    // One at a time. Two people inviting each other in the same breath used to
    // replace one banner with the other and start two games.
    if (pending) return;

    const mine = invite.fireboy === auth().user?.id;
    const say = el("span", { class: "dim" });
    const yes = el("button", { class: "primary small" }, "Play");
    const no = el("button", { class: "ghost" }, "Not now");

    const abort = new AbortController();
    pending = { session: invite.session, abort };

    // "Not now" is an answer, and it now gets sent. Silence used to be the only
    // way to decline, and silence is what somebody who has walked away from
    // their desk also does -- so the other side waited out two full minutes
    // either way. After "Play" the same button is the way back out of a
    // handshake, so it stays and only changes its name.
    no.addEventListener("click", () => {
      // Said out loud, always. Aborting is what stops a handshake we may have
      // started; the decline is what stops THEM waiting, and in the usual case
      // -- the banner is up and the answer is no -- there is no handshake and
      // this is the only thing that travels at all.
      lobby?.decline(invite);
      abort.abort();
      pending = null;
      progress.release();
      banner.hidden = true;
      drawPanel(lobby?.list ?? []);
    });

    banner.hidden = false;
    noticeText = "";
    clear(banner);
    banner.append(
      el("span", {},
        `${from.username} wants to play ${invite.mode} ${invite.num}. ` +
        `You would be ${mine ? "Fireboy" : "Watergirl"}.`),
      yes, say, no);

    yes.addEventListener("click", async () => {
      yes.disabled = true;
      no.textContent = "Cancel";
      try {
        // Adopted before answering, not after. Saying "ready" is what tells the
        // other side to send Start, and the level must not begin against this
        // browser's solo progress -- `Recuent` compares the run it has just
        // finished against what is stored to decide whether it was an
        // improvement, and it has to be the PAIR's best it compares against.
        say.textContent = "loading your progress…";
        await progress.adopt(from.id);
        const ready = await lobby!.join(invite, {
          signal: abort.signal,
          onProgress: (what) => { say.textContent = what; },
        });
        pending = null;
        begin(ready);
      } catch (e) {
        pending = null;
        progress.release();
        say.textContent = (e as Error).message;
        yes.disabled = false;
        no.textContent = "Not now";
        drawPanel(lobby?.list ?? []);
      }
    });
  }

  /** Hand the clock to the session, and start the level if we are the host. */
  function begin(ready: Ready): void {
    linkKind = ready.kind === "webrtc" ? "direct" : "relay";
    partner = ready.friend;
    banner.hidden = true;
    noticeText = "";
    leave.hidden = false;
    void lobby?.setActivity("in_game");

    const session = view.join(ready.transport, ready.slot, {
      // The inviter picked this level and picks the rest of them.
      canChooseLevel: ready.host,
      onDesync: (f, mine, theirs) =>
        console.warn(`desync at frame ${f}: ${mine} != ${theirs}`),
      onQuit: (bySlot, forGood) => quit(bySlot, forGood),
    });
    if (ready.host) session.requestStart(ready.mode, ready.num);
    canvas.focus();
    drawPanel(lobby?.list ?? []);
  }

  /**
   * A level ended because somebody asked it to.
   *
   * Back to the map is the ordinary case and the pair stays together, still
   * connected, still sharing a save -- so the only thing to do is stop claiming
   * to be in a game. Somebody closing their tab is the other case, and it ends
   * the session for both because there is nobody left to play with.
   */
  function quit(bySlot: number, forGood: boolean): void {
    void lobby?.setActivity("in_lobby");
    if (!forGood) {
      if (bySlot !== view.slot) {
        notice(`${partner?.username ?? "They"} went back to the map.`);
      }
      return;
    }
    endSession(bySlot === view.slot
      ? "You left the game."
      : `${partner?.username ?? "Your friend"} left the game.`);
  }

  /** Drop the session, put the solo progress back, and say why. */
  function endSession(why: string): void {
    if (!view.session) return;
    view.leave();
    progress.release();
    partner = null;
    linkKind = "";
    leave.hidden = true;
    stalling = false;
    void lobby?.setActivity("in_lobby");
    notice(why);
    drawPanel(lobby?.list ?? []);
  }

  // A tab that goes away without saying so leaves the other person waiting on
  // input that is never coming. This is the last chance to tell them, and it is
  // one small packet on a channel that is still open.
  const onHide = () => { if (view.session) view.leave(); };
  addEventListener("pagehide", onHide);

  // Tearing the view down matters: it owns a requestAnimationFrame loop, window
  // key listeners and an audio context. The LOBBY is deliberately left alone --
  // it belongs to the session, and closing it here would take the pair offline
  // to each other every time somebody opened their friends list.
  return () => {
    removeEventListener("pagehide", onHide);
    // Told FIRST. Opening the friends list mid-level used to destroy this view
    // and say nothing, which to the other person is identical to the game
    // having died: their partner stops moving and never starts again.
    view.leave();
    if (pending) { pending.abort.abort(); pending = null; }
    // Release before destroy: it sends whatever the pair earned and puts the
    // solo progress back, and `view.destroy()` flushes what it finds.
    progress.release();
    view.destroy();
    for (const off of unsubscribe) off();
    unsubscribe = [];
    void lobby?.setActivity("online");
  };
}
