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
import type { Invite, Showing } from "../net/pairchannel.js";
import { WatchChannel, watchTopicFor } from "../net/watchchannel.js";
import { WatchMirror } from "../net/watch.js";
import { auth, signOut } from "../auth.js";
import { supabase } from "../supabase.js";
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
 * What the game's own `stats` mean, in the order `CreateMainMenu` draws them.
 *
 * -1 is a node you have not reached, 0 is one you have reached and not
 * finished, and 1 to 3 are the grades `Recuent` awards against `TimeTable`.
 */
const GRADES: Record<number, string> = { 3: "A", 2: "B", 1: "C", 0: "—" };

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
  const hand = el("button", { class: "ghost" }, "Let them pick");
  hand.hidden = true;
  const share = el("button", { class: "ghost" }, "Let friends watch");
  share.hidden = true;
  const banner = el("div", { class: "banner" });
  banner.hidden = true;
  const panel = el("div", { class: "panel" });
  const times = el("div", { class: "panel" });
  const board = el("div", { class: "panel" });
  const name = auth().profile?.username ?? "";

  let linkKind = "";
  let lobby: Lobby | null = null;
  /** Who we are paired with, for as long as the session lasts. */
  let partner: FriendState | null = null;
  /**
   * The match, which outlives the link.
   *
   * A peer connection can die and be built again without the two of you having
   * stopped playing together, so what identifies a match cannot be the session
   * object -- it is this: who, which level, which roles, and who did the
   * inviting. Reconnecting needs every one of them, and so does knowing whether
   * there is anything to reconnect TO.
   */
  let match: {
    friend: FriendState;
    invite: Invite;
    slot: 0 | 1;
    iInvited: boolean;
  } | null = null;
  /** Set while the link is being rebuilt, so nothing tries twice at once. */
  let rebuilding: AbortController | null = null;
  /**
   * The feed, when there is one.
   *
   * Only the peer who sent the invitation has a mirror: one copy of the traffic
   * carries both players, and a second would double the message count for
   * packets a watcher already has.
   */
  let mirror: WatchMirror | null = null;
  let watchRoom: WatchChannel | null = null;
  let sharing = false;
  /** Games our friends have opened to watchers, by topic. */
  const showing = new Map<string, Showing>();
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
      showHand();
      showShare();
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
    const who = partner?.username ?? "your friend";
    if (!s) return match ? `with ${who} · reconnecting` : "solo";
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

  /**
   * Hand the level pick to the other player.
   *
   * Over the pair's channel rather than through the netcode, because it is not
   * simulation state: the two of you are between levels, nothing is being
   * stepped, and each of you is looking at your own copy of the map. It needs
   * both of you to agree, which a broadcast does; it does not need to happen on
   * an agreed frame, which is the only thing a command would buy.
   */
  hand.addEventListener("click", () => {
    if (!match || !lobby) return;
    const chooser = match.friend.id;
    lobby.handover(match.friend.id, { session: match.invite.session, chooser });
    setChooser(chooser);
  });

  /**
   * Open the game to friends, or close it again.
   *
   * Off by default and per match, so nothing is published unless somebody asks
   * for it. Either player may flip it and both are told, because being watched
   * is not a thing one of two people should be able to decide.
   */
  share.addEventListener("click", () => {
    if (!match || !lobby) return;
    setSharing(!sharing);
    lobby.sharing(match.friend.id,
                  { session: match.invite.session, on: sharing });
  });

  function setSharing(on: boolean): void {
    if (!match) return;
    sharing = on;
    mirror?.setSharing(on);
    showShare();
    notice(on
      ? "Your friends can watch this game."
      : "This game is private again.");

    // Told to everyone who could watch, on the channels we are allowed to speak
    // on. Both players announce, so a friend of either of them hears about it.
    const me = auth().profile?.username ?? "";
    lobby?.announceShowing({
      topic: watchTopicFor(auth().user!.id, match.friend.id),
      players: [me, match.friend.username],
      on,
    });
  }

  function showShare(): void {
    share.hidden = match === null || mirror === null;
    share.textContent = sharing ? "Stop letting friends watch"
                                : "Let friends watch";
  }

  /** Put the pick where the pair has just agreed it goes. */
  function setChooser(chooser: string): void {
    const mine = chooser === auth().user?.id;
    view.canChooseLevel = mine;
    showHand();
    // Both of them, because both need to know. Telling only the person who
    // lost it leaves the other wondering why the map suddenly answers.
    notice(mine
      ? "You pick the next level."
      : `${partner?.username ?? "They"} picks the next level.`);
  }

  /**
   * The button exists only where it can be used: in a match, on the map, and
   * only for whoever currently holds the pick. Offering it mid-level would be
   * offering to give away something nobody is using.
   */
  function showHand(): void {
    const between = match !== null && !(view.session?.running ?? true);
    hand.hidden = !between || !view.canChooseLevel;
    hand.textContent = `Let ${partner?.username ?? "them"} pick`;
  }

  host.append(el("div", { class: "play" },
    el("header", { class: "bar" },
      el("span", { class: "who" }, name),
      status,
      el("span", { class: "spacer" }),
      mute,
      hand,
      share,
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
    panel, times, board));

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
    // Never while the link is being rebuilt. "Waiting for them" and "the
    // connection is gone" are the two things this whole change exists to tell
    // apart, and the weaker of the two must not overwrite the stronger.
    const bad = !rebuilding && !!s && s.running && !s.linkDown &&
                s.stalled && s.stalledFrames > STALL_FRAMES;
    if (bad === stalling) return;
    stalling = bad;
    if (bad) notice(`Waiting for ${partner?.username ?? "your friend"}…`);
    else if (noticeText.startsWith("Waiting for")) clearNotice();
  }

  // ---- what you have finished --------------------------------------------

  /**
   * The 32 results, from the same three arrays the game itself reads.
   *
   * No query and no schema: `pairsave` swaps `The_cookie.data` for the pair's
   * map when a match starts and hands the solo one back afterwards, so this
   * shows the pair's best times during a game and this browser's when you are
   * alone, without knowing which it is looking at. That is the whole reason
   * the store was built with a swappable bag of arrays.
   *
   * It replaces the hiscore screen the original had, whose server stopped
   * answering some time around 2010.
   */
  let showTimes = false;

  function drawTimes(): void {
    clear(times);
    const toggle = el("button", {
      class: "ghost small",
      onclick: () => { showTimes = !showTimes; drawTimes(); },
    }, showTimes ? "Hide" : "Show");
    times.append(el("h2", {}, "Best times", toggle));
    if (!showTimes) return;

    const data = view.game.The_cookie?.data;
    const table = view.game.Translation as string[] | undefined;
    if (!data || !table) {
      times.append(el("p", { class: "note" }, "Nothing recorded yet."));
      return;
    }

    const rows: HTMLElement[] = [];
    let done = 0;
    for (let i = 0; i < 32; i++) {
      const medal = data.stats?.[i] ?? -1;
      if (medal < 0) continue;                       // never reached
      const [type, num] = String(table[i] ?? "").split("_");
      const label = MODES[Number(type) - 1]?.[1] ?? "?";
      const time = data.timesString?.[i] || "";
      if (medal > 0) done++;
      rows.push(el("div", { class: "row" },
        el("span", { class: "name" }, `${label} ${num}`),
        el("span", { class: "dim" }, time || "not finished"),
        el("span", { class: "grade" }, GRADES[medal] ?? "—")));
    }

    times.append(el("p", { class: "note" },
      `${done} of 32 finished` +
      (progress.shared ? ", together" : ", on this browser")));
    times.append(...rows);
  }

  // ---- everybody else's times --------------------------------------------

  /**
   * The best time on one level, across every pair who is willing to be listed.
   *
   * A projection, not a window onto `pair_progress` -- that table is still
   * members-only in every verb, and `leaderboard()` returns a rank, two names
   * and a time rather than the row they came from. Nothing here can read a
   * pair's progress; it can only be told where they placed.
   */
  let boardMode = "adventure";
  let boardNum = 1;
  let boardOpen = false;

  /** The map node for a level, from the table the game itself indexes by. */
  function nodeOf(mode: string, num: number): number {
    const table = view.game.Translation as string[] | undefined;
    if (!table) return 0;
    const type = MODES.findIndex(([v]) => v === mode) + 1;
    return table.indexOf(`${type}_${num}`) + 1;
  }

  async function drawBoard(): Promise<void> {
    clear(board);
    const toggle = el("button", {
      class: "ghost small",
      onclick: () => { boardOpen = !boardOpen; void drawBoard(); },
    }, boardOpen ? "Hide" : "Show");
    board.append(el("h2", {}, "Leaderboard", toggle));
    if (!boardOpen) return;

    const mode = el("select", { class: "pick" },
      ...MODES.map(([value, label]) =>
        el("option", { value, selected: value === boardMode }, label)));
    const num = el("select", { class: "pick" });
    const fill = () => {
      const count = MODES.find(([v]) => v === mode.value)?.[2] ?? 1;
      num.replaceChildren(...Array.from({ length: count }, (_, i) =>
        el("option", { value: String(i + 1), selected: i + 1 === boardNum },
           `Level ${i + 1}`)));
    };
    fill();
    mode.addEventListener("change", () => {
      boardMode = mode.value; boardNum = 1; void drawBoard();
    });
    num.addEventListener("change", () => {
      boardNum = Number(num.value); void drawBoard();
    });
    board.append(el("div", { class: "row" }, mode, num));

    const node = nodeOf(boardMode, boardNum);
    if (node <= 0) {
      board.append(el("p", { class: "note" }, "No such level."));
      return;
    }
    const { data, error } = await supabase.rpc("leaderboard", { p_node: node });
    if (error) {
      board.append(el("p", { class: "note" }, error.message));
      return;
    }
    const rows = (data ?? []) as {
      rank: number; a_username: string; b_username: string;
      best_time_str: string; is_mine: boolean;
    }[];
    if (rows.length === 0) {
      board.append(el("p", { class: "note" },
        "Nobody has finished this one yet."));
      return;
    }
    for (const r of rows) {
      board.append(el("div", { class: r.is_mine ? "row mine" : "row" },
        el("span", { class: "rank" }, `${r.rank}.`),
        el("span", { class: "name" }, `${r.a_username} & ${r.b_username}`),
        el("span", { class: "grade" }, r.best_time_str || "")));
    }
  }

  // ---- the lobby ---------------------------------------------------------

  panel.append(el("p", { class: "note" }, "Connecting to your friends…"));
  drawTimes();
  void drawBoard();

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
    unsubscribe.push(l.onResume((invite) => void showResume(invite)));
    unsubscribe.push(l.onHandover((h) => {
      if (match && match.invite.session === h.session) setChooser(h.chooser);
    }));
    unsubscribe.push(l.onSharing((x) => {
      if (match && match.invite.session === x.session) setSharing(x.on);
    }));
    unsubscribe.push(l.onShowing((x) => {
      if (x.on) showing.set(x.topic, x);
      else showing.delete(x.topic);
      drawPanel(l.list);
    }));
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
          disabled: !online || match !== null || pending !== null,
          onclick: () => showInviteForm(f),
        }, "Invite")));
    }

    // Games our friends have opened. Pushed to us when they turn watching on,
    // because a friend cannot ask who is playing -- other people's friendships
    // are not theirs to see.
    if (showing.size > 0) {
      panel.append(el("h2", {}, "Watch"));
      for (const [topic, s] of showing) {
        panel.append(el("div", { class: "row" },
          el("span", { class: "dot in_game" }),
          el("span", { class: "name" }, s.players.join(" & ")),
          el("button", {
            class: "ghost", disabled: match !== null,
            onclick: () => { location.hash = `/watch?t=${topic}`; },
          }, "Watch")));
      }
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
        begin(ready, ready.invite);
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
    if (match) return;                 // already playing
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
        begin(ready, invite);
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
  function begin(ready: Ready, invite: Invite): void {
    // Opened once per match rather than per level: it is the pair's topic, not
    // the level's, and joining it again on every Start would be a subscription
    // churned for nothing.
    if (!watchRoom && ready.host) {
      void WatchChannel.open(watchTopicFor(auth().user!.id, ready.friend.id))
        .then((w) => { watchRoom = w; showShare(); })
        .catch((e) => console.warn("could not open the watch topic:", e));
    }
    linkKind = ready.kind === "webrtc" ? "direct" : "relay";
    partner = ready.friend;
    match = {
      friend: ready.friend, invite, slot: ready.slot, iInvited: ready.host,
    };
    banner.hidden = true;
    noticeText = "";
    stalling = false;
    leave.hidden = false;
    void lobby?.setActivity("in_game");

    // The inviter carries the feed. Built even when nothing is being shared:
    // it costs a wrapper and no messages, and it means turning watching on is
    // instant rather than a renegotiation.
    let transport = ready.transport;
    if (ready.host && watchRoom) {
      mirror = new WatchMirror(transport, watchRoom);
      mirror.setSharing(sharing);
      transport = mirror;
    }

    const session = view.join(transport, ready.slot, {
      // The inviter picked this level and picks the rest of them.
      canChooseLevel: ready.host,
      onDesync: (f, mine, theirs) =>
        console.warn(`desync at frame ${f}: ${mine} != ${theirs}`),
      onQuit: (bySlot, forGood) => quit(bySlot, forGood),
      onLinkDown: (why) => lost(why),
    });
    if (ready.host) session.requestStart(ready.mode, ready.num);
    showShare();
    canvas.focus();
    drawPanel(lobby?.list ?? []);
  }

  // ---- losing the link, and getting it back ------------------------------

  /**
   * The transport says it is gone.
   *
   * Not the same as the peer being slow, and that distinction is the point:
   * a stall is answered by waiting, and this is answered by building a new
   * link. The old session goes without a word, because a Quit could not
   * arrive over the thing that just died.
   */
  function lost(why: string): void {
    if (!match || rebuilding) return;
    console.info("the link is gone:", why);
    view.dropLink();
    void reconnect();
  }

  /**
   * Rebuild the link over the channel the pair still shares.
   *
   * Only the peer who did the inviting offers -- it was the caller the first
   * time and is the caller now, so there is nothing to re-agree and no race
   * between two peers both trying. The other side waits for the broadcast and
   * answers it in `showResume`.
   *
   * The level restarts. Resuming mid-level would mean both peers swapping how
   * far their input logs are confirmed and truncating to the earlier, which is
   * real machinery to save ninety seconds of a level you are about to replay
   * anyway.
   */
  async function reconnect(): Promise<void> {
    if (!match || rebuilding) return;
    const abort = new AbortController();
    rebuilding = abort;
    const them = match.friend.username;

    if (!match.iInvited) {
      // Not ours to offer -- but very much ours to ask for. A peer connection
      // can fail at one end and be perfectly healthy at the other, so the side
      // that noticed has to be able to start something, or a one-sided failure
      // is a pair sitting and waiting for each other forever.
      notice(`Lost the connection to ${them}. Reconnecting…`);
      for (const wait of [0, 1000, 2000, 4000, 8000, 16000]) {
        if (abort.signal.aborted || !match) return;
        await new Promise((r) => setTimeout(r, wait));
        if (abort.signal.aborted || !match) return;
        if (view.session) return;              // they got through to us
        lobby?.askResume(match.friend.id, match.invite);
      }
      return;
    }

    // Backing off, because the usual cause is a network that is still coming
    // back and hammering it helps nobody.
    for (const wait of [500, 1000, 2000, 4000, 8000, 16000]) {
      if (abort.signal.aborted || !match) break;
      notice(`Lost the connection to ${them}. Reconnecting…`);
      try {
        const ready = await lobby!.resume(match.friend.id, match.invite, {
          signal: abort.signal,
        });
        rebuilding = null;
        begin(ready, match.invite);
        return;
      } catch (e) {
        if (abort.signal.aborted) return;
        console.info("reconnect attempt failed:", (e as Error).message);
      }
      // A friend who has gone offline in presence has closed the tab. There is
      // nobody to reconnect to and no point pretending otherwise.
      const still = lobby?.list.find((f) => f.id === match?.friend.id);
      if (!still || still.activity === null) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    if (abort.signal.aborted) return;
    rebuilding = null;
    endSession(`Could not get back to ${them}.`);
  }

  /** The other side is rebuilding the link. Answer it, without asking anybody. */
  async function showResume(invite: Invite): Promise<void> {
    if (!match || match.invite.session !== invite.session) return;
    // The inviter offers and the other side answers, the same way round as the
    // first time -- so a resume arriving HERE, at the inviter, is not an offer.
    // It is the other side saying their link is gone and asking for one.
    if (match.iInvited) { void reconnect(); return; }
    if (rebuilding && rebuilding.signal.aborted) return;
    const abort = rebuilding ?? new AbortController();
    rebuilding = abort;
    // A resume can arrive before this side has even noticed the link died --
    // the peer connection fails at each end on its own schedule.
    view.dropLink();
    try {
      const ready = await lobby!.join(invite, { signal: abort.signal });
      rebuilding = null;
      begin(ready, invite);
    } catch (e) {
      if (abort.signal.aborted) return;
      console.info("could not answer a resume:", (e as Error).message);
      // Left in place deliberately: they are the one retrying, and the next
      // attempt is theirs to make.
    }
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
    drawTimes();
    void drawBoard();
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

  /**
   * Drop the match, put the solo progress back, and say why.
   *
   * Keyed on the MATCH and not on `view.session`, because there is a real state
   * where you are still in a match and there is no session: the link has gone
   * and is being rebuilt. Leave has to work there most of all -- it is the way
   * out of a reconnection that is not coming.
   */
  function endSession(why: string): void {
    if (!match) return;
    match = null;
    rebuilding?.abort();
    rebuilding = null;
    view.leave();
    progress.release();
    partner = null;
    linkKind = "";
    leave.hidden = true;
    hand.hidden = true;
    share.hidden = true;
    stalling = false;
    // The match is over, so the audience is told and the topic is let go.
    if (sharing) {
      sharing = false;
      lobby?.announceShowing({
        topic: watchRoom?.topic ?? "", players: ["", ""], on: false,
      });
    }
    mirror = null;
    void watchRoom?.close();
    watchRoom = null;
    void lobby?.setActivity("in_lobby");
    notice(why);
    drawPanel(lobby?.list ?? []);
    // The pair's map has just been handed back for this browser's own.
    drawTimes();
  }

  // A tab that goes away without saying so leaves the other person waiting on
  // input that is never coming. This is the last chance to tell them, and it is
  // one small packet on a channel that is still open.
  const onHide = () => { rebuilding?.abort(); if (view.session) view.leave(); };
  addEventListener("pagehide", onHide);

  // Tearing the view down matters: it owns a requestAnimationFrame loop, window
  // key listeners and an audio context. The LOBBY is deliberately left alone --
  // it belongs to the session, and closing it here would take the pair offline
  // to each other every time somebody opened their friends list.
  return () => {
    removeEventListener("pagehide", onHide);
    rebuilding?.abort();
    rebuilding = null;
    match = null;
    mirror = null;
    void watchRoom?.close();
    watchRoom = null;
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
