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
import type { Transport } from "@engine/net/transport.js";
import { LocalSave } from "@engine/game/save.js";
import { drainOutbox, pairProgress } from "../pairsave.js";
import type { Invite, Showing } from "../net/pairchannel.js";
import { WatchChannel } from "../net/watchchannel.js";
import { WatchMirror } from "../net/watch.js";
import { auth, signOut } from "../auth.js";
import { supabase } from "../supabase.js";
import { clear, el, on } from "../ui/dom.js";
import { FriendState, getLobby, Lobby, Ready } from "../lobby.js";
import { PlayShell } from "../ui/playshell.js";
import { PlayController, loadSelection, selectionKey } from "../playstate.js";
import { Ranking, leaderboardCache } from "../ranking.js";
import { MatchLease } from "../matchlease.js";
import { MatchSharing, type SharingState } from "../sharing.js";

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

/**
 * How long the link has to be healthy again before the message comes down.
 *
 * The banner appearing is cheap and the banner FLICKERING is not -- it relaid
 * the page out at frame rate, which is what sent the scrollbar up and down.
 * `stalledFrames` is now the length of the current stall rather than a lifetime
 * tally, so this is no longer load-bearing; it is here so that one good frame
 * inside a bad patch cannot blink the message away either.
 */
const RECOVERED_FRAMES = 26;

export function playScreen(host: HTMLElement): () => void {
  const flow = new PlayController();
  const canvas = el("canvas", {
    id: "stage", width: STAGE_W, height: STAGE_H, tabindex: "0",
    // The game is pixels. Its menus, its map, its results board and its two
    // characters exist only on this canvas, so none of them are in the
    // accessibility tree -- and a focusable element with no name is a stop on
    // the tab order that says nothing about itself. Naming it and pointing at
    // the key list is not an accessible game; it is the difference between
    // "graphic, The game" and an unlabelled focus ring. A real alternative
    // interface would have to mirror the shell in semantic HTML, which is a
    // design job rather than an attribute.
    role: "application",
    "aria-label": "Fireboy and Watergirl, played on a canvas",
    "aria-describedby": "play-keys",
  });

  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === "1"; } catch { muted = false; }

  // Handed to the view rather than installed globally: `Game`'s constructor
  // calls `openSave` once and holds the result forever, so the store has to
  // exist before the view -- but a module global that one screen sets and never
  // puts back is what used to make WATCHING write into somebody else's save.
  // Alone this is the browser's localStorage; in a pair session it becomes the
  // pair's shared map and then hands the solo one back.
  const progress = pairProgress(new LocalSave("FBCookie"));

  // A live region: the connection state changes on the network's schedule
  // rather than on the reader's, so a stall, a reconnection or a friend leaving
  // has to announce itself or it is invisible to anybody not watching the top
  // of the screen. Polite, because none of it is urgent enough to interrupt.
  const status = el("span", {
    class: "status", role: "status", "aria-live": "polite",
  }, "solo");
  const mute = el("button", { class: "ghost" }, muted ? "Unmute" : "Mute");
  const leave = el("button", { class: "ghost leave" }, "Leave game");
  leave.hidden = true;
  const hand = el("button", { class: "ghost" }, "Let them pick");
  hand.hidden = true;
  const share = el("button", { class: "ghost" }, "Let friends watch");
  share.hidden = true;
  // The banner carries the things somebody has to answer -- an invitation, a
  // lost connection -- so it is assertive where the status line is polite.
  const banner = el("div", {
    class: "banner", role: "alert", "aria-live": "assertive",
  });
  banner.hidden = true;
  const panel = el("div", { class: "panel" });
  const times = el("div", { class: "panel" });
  const board = el("div", { class: "panel" });
  const name = auth().profile?.username ?? "";

  let linkKind = "";
  /**
   * The transport this match is riding, kept only so its cost can be read.
   *
   * `RealtimeTransport.sent` counts messages actually put on the wire, and a
   * relayed pair's message rate is the thing that decides how many games this
   * project can host at once -- so it is worth a number rather than an
   * estimate. Shown in development only; see `describe`.
   */
  let link: (Transport & { readonly sent?: number }) | null = null;
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
    /**
     * Whose pick it is, which is NOT the same as who did the inviting.
     *
     * It starts as the inviter and moves with every handover, so it has to be
     * remembered here: rebuilding a dropped link goes back through `begin`, and
     * `begin` taking `ready.host` as the answer handed the pick silently back
     * to the inviter while the banner still said otherwise.
     */
    chooser: string;
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
  let consent: MatchSharing | null = null;
  let watchTopic: string | null = null;
  let watchGeneration = 0;
  /**
   * Said again every few seconds while the game is open to watchers.
   *
   * A broadcast reaches whoever is subscribed at that instant and nobody else,
   * so announcing once means a friend who was between subscriptions -- or who
   * simply opened the app a minute later -- never learns there is anything to
   * watch. Repeating is how a broadcast becomes a state that can be discovered
   * rather than an event that can be missed, and only while somebody has
   * actually asked to be watchable.
   *
   * Every twenty seconds rather than every five, and to online friends only
   * (see `Lobby.announceShowing`). Those two together take this from the most
   * expensive thing the app does -- it was one message per friend per beat,
   * for the whole match, growing with the friend graph rather than with the
   * number of games -- to something that costs about what it is worth. What it
   * buys is a row that can take twenty seconds to appear for somebody who
   * opened their friends list mid-match, which nobody is timing.
   */
  const SHOWING_MS = 20000;
  let beating: ReturnType<typeof setInterval> | null = null;
  /** Games our friends have opened to watchers, by topic. */
  const showing = new Map<string, Showing & { heard: number }>();
  /**
   * An invitation in flight, in either direction.
   *
   * `session` is set only for one we RECEIVED, because that is the only case
   * this screen has to match a cancel against: a cancel of our own outbound
   * invitation comes back as a rejection from `Lobby.invite` instead.
   */
  let pending: { session: string | null; attempt?: string; friendId: string; abort: AbortController } | null = null;
  /** A transient line in the banner: a stall, a refusal, somebody leaving. */
  let noticeText = "";
  /** What the status line last said, so it is not rewritten 26 times a second. */
  let lastStatus = "";
  /** Whether presence has been told a level is running. */
  let inGame = false;

  /**
   * Whether this screen has already been torn down.
   *
   * `getLobby()` is a round trip, and navigating away inside it used to leave
   * the teardown running over an empty list while every handler below landed
   * afterwards -- holding a detached DOM and redrawing panels nobody could see,
   * for as long as the tab stayed open.
   */
  let gone = false;
  const rankedStatus = el("span", { class: "ranked-status", role: "status", "aria-live": "polite" });
  const ranking = new Ranking(label => { rankedStatus.textContent = label; });

  /**
   * What identifies this run to the ranking, or null when there is nothing to
   * rank.
   *
   * One function rather than the same object literal in three places: the three
   * were already identical, and `eligible` is exactly the kind of field that
   * gets added to two of them.
   */
  function rankedContext() {
    if (!match) return null;
    return {
      friend: match.friend.id,
      connection: match.invite.attempt ?? match.invite.session,
      uploader: match.iInvited,
      eligible: view.artComplete,
    };
  }

  const view = new GameView({
    canvas,
    assets: __ASSETS__,
    save: progress.store,
    onPrepareRun: async v => {
      // Said once per prepared scene, so a level that starts with holes in it
      // says so rather than looking like a rendering bug somebody should
      // report. Preparation retries what failed last time, so this clears
      // itself the moment the art actually arrives.
      if (!v.artComplete) {
        notice("Some game art did not load. The level still plays, but this " +
               "run will not be ranked.");
      }
      const context = rankedContext();
      if (context && v.session) await ranking.prepare(context, v.session);
    },
    onState: () => {
      const next = describe();
      if (next !== lastStatus) { status.textContent = next; lastStatus = next; }
      // The game has a mute button of its own, inside the canvas, and in a
      // session it now drives this same local mute -- so neither button can own
      // the label and it is read back from the one thing both of them set.
      if (view.isMuted !== muted) syncMute();
      // A level starting is not an event this screen is told about -- either
      // peer's map click can begin one, and the command lands inside the
      // session. Presence used to say "in a game" until the first level ended
      // and "in the lobby" for the rest of the evening.
      const playing = match !== null && (view.session?.running ?? false);
      if (playing !== inGame) {
        inGame = playing;
        if (match) flow.set(playing ? "playing" : "between-levels");
        if (playing) lobby?.setActivity("in_game");
      }
      if (playing && match && view.session) {
        const selection = view.session.selection;
        try { localStorage.setItem(selectionKey(auth().user!.id,match.friend.id),JSON.stringify({ ...selection, iAmFireboy: view.slot === 0 })); } catch { /* optional */ }
      }
      showHand();
      showShare();
      const context = rankedContext();
      if (context && view.session) ranking.observe(context, view.session, view.game);
    },
    onFrame: () => watchStall(),
    onConfirmed: (v, frame) => {
      if (v.session) mirror?.confirmed(v.session,frame);
      if (frame % 26 === 0 || v.game.children.some((c: { Rboard?: unknown }) => c.Rboard)) progress.confirm(v.game.The_cookie.data);
      const context = rankedContext();
      if (context && v.session) ranking.observe(context, v.session, v.game, frame);
    },
    onRefused: (why) => {
      if (why === "preparation-failed") {
        notice("Some game art could not load.",el("button", { class: "ghost", onclick: () => { void view.prepare().catch(() => {}); } },"Retry loading"));
        shell.open("setup");
      }
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
    if (!s) return match ? `Reconnecting with ${who}` : "Play solo or invite a friend";
    if (!s.running) return `With ${who} · choosing a level`;
    return `${view.slot === 0 ? "Fireboy" : "Watergirl"} with ${who}` +
      (s.stalled ? " · waiting for your friend" : "") + cost();
  }

  /**
   * What this match has cost the server, in development only.
   *
   * A relayed pair's message rate is what decides how many games can be played
   * at once -- the free tier allows a hundred a second across the whole project
   * -- and until now every figure about it was arithmetic on `FLUSH_MS`.
   * `RealtimeTransport` has been counting the real number since it was written;
   * this is the first thing to read it. A direct pair has no counter and
   * nothing is shown, which is itself the point: they cost nothing.
   */
  function cost(): string {
    if (!import.meta.env.DEV) return "";
    const sent = link?.sent;
    return typeof sent === "number" ? ` · ${sent} msgs` : "";
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

  leave.addEventListener("click", () => {
    if (confirm("Leave this game? Your friend will return to the map.")) endSession("You left the game.");
  });

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
    if (!match || !lobby || match.chooser !== auth().user?.id || view.session?.running) return;
    const chooser = match.friend.id;
    lobby.handover(match.friend.id, { session: match.invite.session, attempt: match.invite.attempt, chooser });
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
    if (!match || !lobby || !consent) return;
    share.disabled = true;
    void consent.set(!consent.consent).then(() => {
      share.disabled = false;
      if (match) lobby?.sharing(match.friend.id, { session: match.invite.session, on: consent?.consent ?? false });
    });
  });

  function updateSharing(state: SharingState | null): void {
    const generation = ++watchGeneration;
    if (watchTopic !== state?.topic || !state?.shared) {
      if (sharing) setSharing(false);
      void watchRoom?.close(); watchRoom = null;
    }
    watchTopic = state?.topic ?? null;
    if (state?.shared && match?.iInvited && !watchRoom) {
      const topic = state.topic;
      void WatchChannel.open(topic).then(room => {
        if (gone || generation !== watchGeneration || !match || watchTopic !== topic) { void room.close(); return; }
        watchRoom = room;
        room.onViewer(() => mirror?.catchUp(view.session));
        setSharing(true);
      }).catch(() => { if (!gone) notice("The spectator feed could not connect."); });
    } else if (state?.shared) setSharing(true);
    showShare();
  }

  function setSharing(on: boolean): void {
    if (!match) return;
    if (sharing === on) return;
    sharing = on;
    mirror?.setSharing(on);
    showShare();
    notice(on
      ? "Your friends can watch this game."
      : "This game is private again.");

    announceShowing(on);
    if (beating !== null) { clearInterval(beating); beating = null; }
    if (on) {
      beating = setInterval(() => announceShowing(true, match, true), SHOWING_MS);
    }
  }

  /**
   * Told to everyone who could watch, on the channels we are allowed to speak
   * on. Both players announce, so a friend of either of them hears about it.
   *
   * `repeat` marks the beat rather than the news, and it is what
   * `Lobby.announceShowing` narrows to friends who are actually online. See
   * there for why the two are not the same message.
   */
  function announceShowing(on: boolean, m = match, repeat = false): void {
    if (!m || !watchTopic) return;
    const me = auth().profile?.username ?? "";
    lobby?.announceShowing({
      topic: watchTopic,
      players: [me, m.friend.username],
      on,
    }, repeat);
  }

  /**
   * Written only when it actually changes.
   *
   * `onFrame` runs 26 to 60 times a second, and assigning `textContent` the
   * string it already holds still replaces the text node and dirties layout.
   * With a stage whose height is a function of the page's width -- see the
   * scrollbar gutter in styles.css -- a permanently dirty layout is a page that
   * never settles.
   */
  function set(node: HTMLElement, text: string, hidden: boolean): void {
    if (node.textContent !== text) node.textContent = text;
    if (node.hidden !== hidden) node.hidden = hidden;
  }

  function showShare(): void {
    // Gated on the match and not on the mirror. Only the inviter carries the
    // feed, but being watched is not one of two people's decision to make: the
    // other player flips the same switch and both are told.
    set(share, consent?.consent ? (sharing ? "Stop letting friends watch" : "Cancel sharing request") : "Let friends watch",
        match === null);
  }

  /** Put the pick where the pair has just agreed it goes. */
  function setChooser(chooser: string): void {
    const mine = chooser === auth().user?.id;
    if (match) match.chooser = chooser;
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
    set(hand, `Let ${partner?.username ?? "them"} pick`,
        !between || !view.canChooseLevel);
  }

  const shell = new PlayShell(host, {
    canvas, name, status, mute, banner, friends: panel, times, board,
    input: (enabled) => view.setInputEnabled(enabled),
    actions: [hand, share, leave, el("button", {
      class: "ghost", onclick: async () => {
        if (match && !confirm("Sign out and leave the game?")) return;
        await signOut();
      },
    }, "Sign out")],
  });
  const offSave = progress.onChange(() => {
    const error = progress.lastError ?? progress.storageError;
    shell.saveStatus.textContent = error ? "Retry needed" : progress.waiting ? "Saving…" : "Saved";
    shell.saveStatus.title = error ?? "Your progress";
  });
  shell.root.querySelector("footer")!.append(rankedStatus);
  const otherTab = el("span", { class: "other-tab" }, "Playing in another tab. ");
  otherTab.hidden = true;
  const takeover = el("button", { class: "ghost" }, "Take over here");
  otherTab.append(takeover);
  shell.root.querySelector("footer")!.append(otherTab);
  const lease = new MatchLease(auth().user!.id, busy => { otherTab.hidden = !busy; }, () => {
    pending?.abort.abort(); flow.cancel(); endSession("Your match moved to another tab.");
    notice("Your match moved to another tab.");
  });
  takeover.addEventListener("click", () => {
    takeover.disabled = true;
    void lease.takeover().then(ok => {
      takeover.disabled = false;
      if (ok) { shell.open("friends"); lease.release(); }
      else notice("The other tab did not release the match. Close it and try again.");
    });
  });
  // Toggles, like the toolbar buttons: press it again and Progress goes away.
  // The flush is not conditional on which way it went -- when the label reads
  // "Retry needed" the press IS the retry, and it should still happen on the
  // press that closes the panel.
  on(shell.saveStatus, "click", async () => { shell.toggle("progress"); await progress.flushNow(); drawTimes(); });
  shell.notify("Preparing the game…");
  const prepare = () => {
    void view.prepare().then(() => { if (!gone) shell.notify(""); }).catch(() => {
      if (gone) return;
      notice("Some game art could not be loaded.", el("button", { class: "ghost", onclick: prepare }, "Retry loading"));
      shell.open("setup");
    });
  };
  prepare();

  canvas.focus();

  // A deliberate hook, and only in development. Asking whether two people are
  // simulating the same game is not something the DOM can answer, so the
  // end-to-end test needs a way in; shipping that way in to production would be
  // handing every page a handle on the running game for no reason.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__fbwg = {
      view, progress, drainOutbox, get lobby() { return lobby; },
    };
  }

  // ---- the banner --------------------------------------------------------

  /** A one-line message, replacing whatever the banner was showing. */
  function notice(text: string, ...extra: (Node | string)[]): void {
    shell.notify(text);
    noticeText = text;
    banner.hidden = false;
    clear(banner);
    banner.append(el("span", {}, text), ...extra,
      el("button", {
        class: "ghost",
        onclick: () => { noticeText = ""; banner.hidden = true; shell.notify(""); },
      }, "Dismiss"));
  }

  function clearNotice(): void {
    if (!noticeText) return;
    noticeText = "";
    banner.hidden = true;
    shell.notify("");
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
  /** Frames since the session last looked stalled, for the hysteresis above. */
  let healthy = 0;
  function watchStall(): void {
    const s = view.session;
    // Never while the link is being rebuilt. "Waiting for them" and "the
    // connection is gone" are the two things this whole change exists to tell
    // apart, and the weaker of the two must not overwrite the stronger.
    const live = !rebuilding && !!s && s.running && !s.linkDown;
    healthy = live && s!.stalled ? 0 : healthy + 1;
    const bad = stalling
      ? live && healthy < RECOVERED_FRAMES
      : live && s!.stalled && s!.stalledFrames > STALL_FRAMES;
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
        // The grade carries a colour of its own. All four used to be the same
        // orange, so the column that exists to say HOW WELL a level went said
        // only that it had been played.
        el("span", { class: `grade g${medal}` }, GRADES[medal] ?? "—")));
    }

    times.append(el("p", { class: "note" },
      `${done} of 32 finished` +
      (progress.shared ? ", together" : ", on this browser")));

    // A save that is not being saved used to look exactly like one that was.
    // `localStorage.setItem` throws on a full quota and in some private modes,
    // and both the solo store and the pair store swallowed it -- so somebody
    // could finish half the map in a private window and lose all of it without
    // a single word on screen.
    const trouble = progress.shared ? progress.lastError : progress.storageError;
    if (trouble) {
      times.append(el("p", { class: "error", role: "alert" },
        progress.shared
          ? `The last result could not be saved: ${trouble}. It will be sent ` +
            "again when the connection comes back."
          : `This browser is not storing progress: ${trouble}. A private ` +
            "window or a full quota will do that."));
    } else if (progress.waiting > 0) {
      times.append(el("p", { class: "note" },
        `${progress.waiting} result${progress.waiting === 1 ? "" : "s"} still ` +
        "waiting to be sent. They will go when the connection allows."));
    }
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
  /**
   * Which selection the board is drawing for.
   *
   * Both pickers call the same async draw, and the RPC has no cancellation --
   * so choosing level 3 and then level 4 while the network is slow could resolve
   * in either order, and the loser used to append its rows under the winner's
   * heading. The rank and the times looked exactly like level 4's.
   */
  let boardGeneration = 0;

  /** The map node for a level, from the table the game itself indexes by. */
  function nodeOf(mode: string, num: number): number {
    const table = view.game.Translation as string[] | undefined;
    if (!table) return 0;
    const type = MODES.findIndex(([v]) => v === mode) + 1;
    return table.indexOf(`${type}_${num}`) + 1;
  }

  async function drawBoard(): Promise<void> {
    const generation = ++boardGeneration;
    clear(board);
    const toggle = el("button", {
      class: "ghost small",
      onclick: () => { boardOpen = !boardOpen; void drawBoard(); },
    }, boardOpen ? "Hide" : "Show");
    board.append(el("h2", {}, "Verified leaderboard", toggle));
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
    const loading = el("p", { class: "note" }, "Loading…");
    board.append(loading);
    const key = `${auth().user?.id}:${node}`;
    const cached = leaderboardCache.get(key);
    const { data, error } = cached && Date.now() - cached.at < 15000
      ? { data: cached.data, error: null }
      : await supabase.rpc("verified_leaderboard", { p_node: node });
    if (!error) leaderboardCache.set(key, { at: Date.now(), data });
    // Anything that resolves after a newer selection has started belongs to a
    // heading that is no longer on screen.
    if (generation !== boardGeneration || gone) return;
    loading.remove();
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
        "No verified results yet. Historical personal results are preserved in your progress."));
      return;
    }
    for (const r of rows) {
      board.append(el("div", { class: r.is_mine ? "row mine" : "row" },
        el("span", { class: "rank" }, `${r.rank}.`),
        el("span", { class: "name" }, `${r.a_username} & ${r.b_username}`),
        // A time, not a grade: dimmer than the name beside it, so that the
        // orange marking WHICH ROW IS YOURS is the only orange in the list.
        el("span", { class: "time" }, r.best_time_str || "")));
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

  getLobby().then((l) => {
    if (gone) return;
    lobby = l;
    // Anything a previous session could not finish saying. A pair result that
    // was still in the debounce timer when the tab closed, or whose request
    // failed, is written down rather than lost -- and this is the next
    // authenticated moment at which it can be sent. Monotonic on the server, so
    // replaying one that was in fact delivered changes nothing.
    void drainOutbox().catch(() => { /* The save status exposes the retry on its own next flush. */ });
    // The list may be stale if a friendship was accepted on another screen.
    void l.refresh();
    l.setActivity("in_lobby");
    unsubscribe.push(l.onChange((friends) => {
      drawPanel(friends);
      if (match && !friends.some(f => f.id === match!.friend.id && f.status === "accepted")) endSession("This friendship is no longer available.");
    }));
    unsubscribe.push(l.onInvite((invite, from) => showInvite(invite, from)));
    unsubscribe.push(l.onResume((invite, from) => void showResume(invite, from)));
    unsubscribe.push(l.onHandover((h) => {
      if (match && match.invite.session === h.session && match.invite.attempt === h.attempt && h.from === match.friend.id && match.chooser === h.from && h.chooser === auth().user?.id && !view.session?.running) setChooser(h.chooser);
    }));
    unsubscribe.push(l.onSharing((x) => {
      if (match && match.invite.session === x.session && x.from === match.friend.id) void consent?.refresh();
    }));
    unsubscribe.push(l.onShowing((x) => {
      if (x.on) showing.set(x.topic, { ...x, heard: Date.now() });
      else showing.delete(x.topic);
      drawPanel(l.list);
    }));
    // A pair whose tab closed mid-game never says "stopped", so a row that has
    // not been repeated for a while is one nobody is offering any more.
    //
    // Derived from the beat rather than written down, because the two used to
    // be the same twenty seconds by coincidence of the beat being five: a row
    // now expires exactly as the beat that would have renewed it arrives, and
    // whether it survives is a race. Two and a half beats tolerates a missed
    // one -- which a broadcast is entitled to be -- and still takes a
    // disappeared pair off the list inside a minute.
    const STALE_MS = SHOWING_MS * 2.5;
    const stale = setInterval(() => {
      let dropped = false;
      for (const [topic, x] of showing) {
        if (Date.now() - x.heard > STALE_MS) { showing.delete(topic); dropped = true; }
      }
      if (dropped) drawPanel(l.list);
    }, SHOWING_MS / 2);
    unsubscribe.push(() => clearInterval(stale));
    // Their invitation is gone: take the banner down whether or not this side
    // had got as far as pressing anything.
    unsubscribe.push(l.onCancel((session, from, attempt) => {
      if (!pending || pending.session !== session || pending.friendId !== from.id || pending.attempt !== attempt) return;
      flow.cancel();
      pending.abort.abort();
      pending = null;
      shell.invite(false);
      void progress.release();
      notice(`${from.username} called that off.`);
    }));
    // The `await` above is another place this screen can have gone, and by
    // here there is something to take back. Last, so it covers every handler.
    if (gone) { for (const off of unsubscribe) off(); unsubscribe = []; }
  }).catch((e) => {
    if (gone) return;
    panel.replaceChildren(el("p", { class: "note" },
      `Could not reach your friends list: ${(e as Error).message}`));
  });

  function drawPanel(friends: FriendState[]): void {
    shell.friends(friends.filter(f => f.status === "accepted" && f.activity !== null).length);
    const accepted = friends.filter((f) => f.status === "accepted").sort((a, b) => Number(b.activity !== null) - Number(a.activity !== null) || a.username.localeCompare(b.username));
    clear(panel);
    panel.append(el("h2", {}, "Play together"));
    if (lobby?.lastError) panel.append(el("p", { class: "error" }, "Friends could not refresh. ", el("button", { class: "ghost", onclick: () => { void lobby?.refresh(); } }, "Retry")));

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
          : f.activity ? "online" : f.connection === "connecting" ? "connecting" : f.connection === "unavailable" ? "unavailable" : "offline"),
        el("button", {
          // Paired with somebody is paired with somebody, level or no level:
          // between levels the session is still up and still theirs. Leaving is
          // what makes this button live again, and there is a button for that.
          class: "ghost",
          // Named for the row it is in. The label is the same four letters on
          // every one of them, and the name that says WHICH friend it invites
          // is a sibling span -- so a screen reader walking this list heard
          // "Invite, Invite, Invite" fifty times with no way to tell them
          // apart. The visible text stays short; only the accessible name is
          // the long one.
          "aria-label": `${!online && f.connection === "unavailable" ? "Connect to" : "Invite"} ${f.username}`,
          disabled: (!online && f.connection !== "unavailable") || match !== null || pending !== null,
          onclick: () => { if (!online) lobby?.prioritize(f.id); else showInviteForm(f); },
        }, !online && f.connection === "unavailable" ? "Connect" : "Invite")));
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
            // A class, not just the label. "Let friends watch" is also a button
            // with "watch" in it, and a text selector cannot tell them apart.
            class: "ghost watch", disabled: match !== null,
            // Named for its row, for the same reason the invite buttons are.
            "aria-label": `Watch ${s.players.join(" and ")}`,
            onclick: () => { location.hash = `/watch?t=${topic}`; },
          }, "Watch")));
      }
    }
  }

  /** Choose the level and the roles, then send the invitation. */
  function showInviteForm(friend: FriendState): void {
    if (match || pending) return;
    flow.set("configuring");
    lobby?.prioritize(friend.id);
    shell.open("setup");
    const selection = loadSelection(auth().user!.id, friend.id);
    const mode = el("select", { class: "pick" },
      ...MODES.map(([value, label]) => el("option", { value }, label)));
    const num = el("select", { class: "pick" });
    const roles = el("select", { class: "pick" },
      el("option", { value: "me" }, `${auth().profile?.username} is Fireboy`),
      el("option", { value: "them" }, `${friend.username} is Fireboy`));
    mode.setAttribute("aria-label", "Game mode");
    num.setAttribute("aria-label", "Level");
    roles.setAttribute("aria-label", "Characters");
    mode.value = selection.mode;
    roles.value = selection.iAmFireboy ? "me" : "them";

    const fillNumbers = () => {
      const count = MODES.find(([v]) => v === mode.value)?.[2] ?? 1;
      num.replaceChildren(...Array.from({ length: count }, (_, i) =>
        el("option", { value: String(i + 1) }, `Level ${i + 1}`)));
    };
    fillNumbers();
    num.value = String(selection.num);
    mode.addEventListener("change", fillNumbers);

    const say = el("span", { class: "dim" });
    const go = el("button", { class: "primary small" }, "Send invite");

    // Cancel has to survive the click on "Send invite", because the whole point
    // is to be able to change your mind while it is out. It used to hide the
    // banner and nothing else, so the invitation carried on being accepted
    // behind it and the game started anyway.
    const stop = el("button", { class: "ghost" }, "Cancel");
    stop.addEventListener("click", () => {
      lease.release();
      flow.cancel();
      if (pending) { pending.abort.abort(); pending = null; }
      void progress.release();
      banner.hidden = true;
      drawPanel(lobby?.list ?? []);
      shell.open("friends");
    });

    banner.hidden = false;
    noticeText = "";
    clear(banner);
    banner.append(
      el("span", {}, `Invite ${friend.username}:`), mode, num, roles, go, say,
      stop);

    on(go, "click", async () => {
      go.disabled = true;
      const abort = flow.start("inviting");
      // The session id belongs to the lobby, which mints it. Nothing here needs
      // it: a cancel of this invitation arrives as a rejection below.
      pending = { session: null, friendId: friend.id, abort };
      drawPanel(lobby?.list ?? []);
      try {
        if (!await lease.acquire()) throw new Error("Playing in another tab. Use Take over here to continue.");
        if (!flow.owns(abort) || gone) { lease.release(); return; }
        say.textContent = "loading your progress…";
        await progress.adopt(friend.id, abort.signal);
        await view.prepareLevel(mode.value, Number(num.value), abort.signal);
        if (!flow.owns(abort) || gone) return;
        try { localStorage.setItem(selectionKey(auth().user!.id, friend.id), JSON.stringify({ mode: mode.value, num: Number(num.value), iAmFireboy: roles.value === "me" })); } catch { /* optional preference */ }
        const ready = await lobby!.invite(friend.id, {
          mode: mode.value,
          num: Number(num.value),
          iAmFireboy: roles.value === "me",
          signal: abort.signal,
          onProgress: (what) => { if (flow.owns(abort)) say.textContent = what; },
        });
        if (!flow.finish(abort, "playing") || gone) { ready.transport.close(); return; }
        pending = null;
        begin(ready, ready.invite);
      } catch (e) {
        if (!flow.owns(abort) || gone) return;
        flow.finish(abort, "configuring");
        lease.release();
        pending = null;
        void progress.release();
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
    if (pending) {
      // The lower account id keeps its outbound offer; both peers make the same decision.
      if (pending.friendId !== from.id || auth().user!.id < from.id || pending.session !== null) {
        lobby?.decline(invite); return;
      }
      flow.cancel();
      pending = null;
      void progress.release();
    }

    const mine = invite.fireboy === auth().user?.id;
    const say = el("span", { class: "dim" });
    const yes = el("button", { class: "primary small" }, "Accept");
    const no = el("button", { class: "ghost" }, "Decline");

    const abort = flow.start("accepting");
    pending = { session: invite.session, attempt: invite.attempt, friendId: from.id, abort };
    shell.invite(true);
    shell.open("setup");

    // "Not now" is an answer, and it now gets sent. Silence used to be the only
    // way to decline, and silence is what somebody who has walked away from
    // their desk also does -- so the other side waited out two full minutes
    // either way. After "Play" the same button is the way back out of a
    // handshake, so it stays and only changes its name.
    no.addEventListener("click", () => {
      lease.release();
      // Said out loud, always. Aborting is what stops a handshake we may have
      // started; the decline is what stops THEM waiting, and in the usual case
      // -- the banner is up and the answer is no -- there is no handshake and
      // this is the only thing that travels at all.
      lobby?.decline(invite);
      abort.abort();
      flow.cancel();
      pending = null;
      shell.invite(false);
      void progress.release();
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

    on(yes, "click", async () => {
      yes.disabled = true;
      no.textContent = "Cancel";
      try {
        if (!await lease.acquire()) throw new Error("Playing in another tab. Use Take over here to continue.");
        if (!flow.owns(abort) || gone) { lease.release(); return; }
        // Adopted before answering, not after. Saying "ready" is what tells the
        // other side to send Start, and the level must not begin against this
        // browser's solo progress -- `Recuent` compares the run it has just
        // finished against what is stored to decide whether it was an
        // improvement, and it has to be the PAIR's best it compares against.
        say.textContent = "loading your progress…";
        await progress.adopt(from.id, abort.signal);
        await view.prepareLevel(invite.mode, invite.num, abort.signal);
        if (!flow.owns(abort) || gone) return;
        flow.set("connecting");
        const ready = await lobby!.join(invite, {
          signal: abort.signal,
          onProgress: (what) => { say.textContent = what; },
        });
        if (!flow.finish(abort, "playing") || gone) { ready.transport.close(); return; }
        pending = null;
        begin(ready, invite);
      } catch (e) {
        if (!flow.owns(abort) || gone) return;
        lease.release();
        pending = null;
        void progress.release();
        say.textContent = (e as Error).message;
        yes.disabled = false;
        no.textContent = "Decline";
        drawPanel(lobby?.list ?? []);
      }
    });
  }

  /** Hand the clock to the session, and start the level if we are the host. */
  function begin(ready: Ready, invite: Invite): void {
    if (gone) { ready.transport.close(); return; }
    shell.invite(false);
    shell.notify("");
    shell.close(true);
    linkKind = ready.kind === "webrtc" ? "direct" : "relay";
    partner = ready.friend;
    // Whoever was picking before this link died is still picking. Only a match
    // that did not exist a moment ago starts with the inviter.
    const chooser = match?.invite.session === invite.session
      ? match.chooser
      : (ready.host ? auth().user!.id : ready.friend.id);
    match = {
      friend: ready.friend, invite, slot: ready.slot, iInvited: ready.host,
      chooser,
    };
    consent ??= new MatchSharing(invite.session, ready.friend.id, updateSharing);
    banner.hidden = true;
    noticeText = "";
    stalling = false;
    leave.hidden = false;
    lobby?.setActivity("in_game");

    // The inviter carries the feed. Built even when nothing is being shared and
    // even before the watch topic has finished being joined: it costs a wrapper
    // and no messages, it means turning watching on is instant rather than a
    // renegotiation, and it asks for the channel each time rather than holding
    // one, because joining that topic is a round trip that has not come back
    // yet at the moment the session must be built.
    let transport = ready.transport;
    // Held only to be counted. `RealtimeTransport` has kept a tally of the
    // messages it actually put on the wire since it was written and nothing
    // has ever read it, so every number about what a relayed pair costs has
    // been a model. See `describe`.
    link = transport;
    if (ready.host) {
      mirror = new WatchMirror(transport, () => watchRoom);
      mirror.setSharing(sharing);
      transport = mirror;
    }

    const session = view.join(transport, ready.slot, {
      ...(!invite.between ? { initialLevel: { mode: ready.mode, num: ready.num } } : {}),
      // The inviter picked the first level; after that it is whoever the pair
      // last agreed on, which a reconnection must not quietly undo.
      canChooseLevel: chooser === auth().user?.id,
      onDesync: (f, mine, theirs) =>
        console.warn(`desync at frame ${f}: ${mine} != ${theirs}`),
      onQuit: (bySlot, forGood) => quit(bySlot, forGood),
      onLinkDown: (why) => lost(why),
    });
    if (ready.host && !invite.between) session.requestStart(ready.mode, ready.num);
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
    rememberLevel();
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
    flow.set("reconnecting");
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
        // Carrying whether the last link was a relay, so neither side spends
        // eight seconds asking a NAT the question it already refused -- and
        // spends them with the transport blocked by the handshake, which for
        // a relayed pair is the game's own channel. Both peers read this one
        // invitation, so the two of them cannot disagree about it.
        const ready = await lobby!.resume(
          match.friend.id,
          { ...match.invite, relay: linkKind === "relay" },
          { signal: abort.signal });
        rebuilding = null;
        begin(ready, ready.invite);
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
  async function showResume(invite: Invite, from: FriendState): Promise<void> {
    if (!match || from.id !== match.friend.id || match.invite.session !== invite.session || invite.fireboy !== match.invite.fireboy || invite.from !== match.invite.from || !invite.attempt) return;
    // The inviter offers and the other side answers, the same way round as the
    // first time -- so a resume arriving HERE, at the inviter, is not an offer.
    // It is the other side saying their link is gone and asking for one.
    //
    // The old session goes first, as it does on every other route into
    // `reconnect`. A peer connection fails at each end on its own schedule, so
    // this side may still believe it has a perfectly good link -- and building
    // the replacement on top of it left the old session and its transport
    // running, unreferenced, for the rest of the match.
    if (match.iInvited) { rememberLevel(); view.dropLink(); void reconnect(); return; }
    rebuilding?.abort();
    const abort = new AbortController();
    rebuilding = abort;
    // A resume can arrive before this side has even noticed the link died --
    // the peer connection fails at each end on its own schedule.
    view.dropLink();
    try {
      const ready = await lobby!.join(invite, { signal: abort.signal });
      if (abort.signal.aborted || rebuilding !== abort || !match || match.invite.session !== invite.session) { ready.transport.close(); return; }
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
    lobby?.setActivity("in_lobby");
    // Between levels, not out of the match. Whichever of them starts the next
    // one puts both back to "in a game"; see `onFrame`.
    inGame = false;
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
    consent?.close(); consent = null; watchGeneration++;
    lease.release();
    if (!match) return;
    // Held, because the announcement below is addressed BY topic and the topic
    // is derived from who the two of us are. Reading `watchRoom?.topic` instead
    // meant the peer who did not do the inviting -- who has no watch room --
    // published an empty topic that matched nothing in anybody's list, and the
    // row for a game that had ended sat there until it aged out.
    const was = match;
    flow.cancel();
    flow.set("ended");
    match = null;
    inGame = false;
    rebuilding?.abort();
    rebuilding = null;
    view.leave();
    void progress.release();
    partner = null;
    linkKind = "";
    link = null;
    leave.hidden = true;
    hand.hidden = true;
    share.hidden = true;
    stalling = false;
    // The match is over, so the audience is told and the topic is let go.
    if (beating !== null) { clearInterval(beating); beating = null; }
    if (sharing) {
      sharing = false;
      announceShowing(false, was);
    }
    mirror = null;
    void watchRoom?.close();
    watchRoom = null;
    lobby?.setActivity("in_lobby");
    notice(why);
    drawPanel(lobby?.list ?? []);
    // The pair's map has just been handed back for this browser's own.
    drawTimes();
  }

  // A tab that goes away without saying so leaves the other person waiting on
  // input that is never coming. This is the last chance to tell them, and it is
  // one small packet on a channel that is still open.
  // A tab that goes away without saying so leaves TWO things unfinished: the
  // other player waiting on input that is never coming, and whatever the pair
  // earned in the last second and a half sitting in a debounce timer. The Quit
  // is one small packet on a channel that is still open; the beacon is a
  // `keepalive` request the browser is allowed to finish after this document
  // has gone. Neither is guaranteed, which is why the result is also written to
  // a durable outbox -- see `pairsave.ts`.
  const onHide = () => {
    lease.release();
    rebuilding?.abort();
    progress.beacon();
    if (view.session) view.leave();
  };
  addEventListener("pagehide", onHide);
  const onShow = (event: PageTransitionEvent) => {
    if (event.persisted && match) endSession("This tab was suspended. Invite your friend again to reconnect.");
  };
  addEventListener("pageshow", onShow);
  const visibility = () => {
    view.clearInput();
    if (document.hidden) {
      // Idempotent forced pause; returning never automatically unpauses either player.
      view.pauseForSuspension();
      if (consent?.consent) void consent.set(false);
    } else {
      void lobby?.refresh(); void consent?.refresh(); void ranking.flush();
      if (match) notice("Press P when you are both ready to continue.");
    }
  };
  document.addEventListener("visibilitychange",visibility);
  const refreshFriends = setInterval(() => { if (!document.hidden) void lobby?.refresh(); },15000);

  // Tearing the view down matters: it owns a requestAnimationFrame loop, window
  // key listeners and an audio context. The LOBBY is deliberately left alone --
  // it belongs to the session, and closing it here would take the pair offline
  // to each other every time somebody opened their friends list.
  return () => {
    gone = true;
    flow.cancel();
    shell.destroy();
    consent?.close(); consent = null; watchGeneration++;
    lease.close();
    ranking.close();
    offSave();
    removeEventListener("pagehide", onHide);
    removeEventListener("pageshow", onShow);
    document.removeEventListener("visibilitychange",visibility);
    clearInterval(refreshFriends);
    rebuilding?.abort();
    rebuilding = null;
    if (beating !== null) { clearInterval(beating); beating = null; }
    // The audience is told here too. Leaving this screen ends the feed, and a
    // row offering a game nobody is publishing is a link to a frozen canvas
    // until it ages out.
    if (sharing) { sharing = false; announceShowing(false); }
    match = null;
    inGame = false;
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
    void progress.release();
    progress.close();
    view.destroy();
    for (const off of unsubscribe) off();
    unsubscribe = [];
    lobby?.setActivity("online");
  };

  function rememberLevel(): void {
    if (!match || !view.session) return;
    const current = view.session.selection;
    match.invite = { ...match.invite, mode: current.mode, num: current.num, between: !view.session.running };
  }
}
