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
import { drainOutbox, pairProgress } from "../pairsave.js";
import { soloProgress } from "../solosave.js";
import type { Invite, Showing } from "../net/pairchannel.js";
import { WatchChannel } from "../net/watchchannel.js";
import { WatchMirror } from "../net/watch.js";
import { auth, signOut } from "../auth.js";
import { clear, el, on } from "../ui/dom.js";
import { FriendState, getLobby, Lobby, Ready } from "../lobby.js";
import { PlayShell } from "../ui/playshell.js";
import { FriendsPanel } from "./friends.js";
import { Leaderboard } from "../ui/leaderboard.js";
import { ProgressPanel } from "../ui/progress.js";
import { leaderboardCache } from "../ranking.js";
import { PlayController, loadSelection, selectionKey } from "../playstate.js";
import { MatchLease } from "../matchlease.js";
import { MatchSharing, type SharingState } from "../sharing.js";
import { QoeRecorder } from "../net/qoe.js";
import { networkFlags } from "../net/flags.js";

const MUTE_KEY = "fbwg.muted";

/** The 32 levels, as the map numbers them. */
const MODES: [string, string, number][] = [
  ["adventure", "Adventure", 17],
  ["puzzle", "Puzzle", 9],
  ["speed", "Speed", 6],
];

/**
 * What a banner message is ABOUT, so it can be taken down when that stops
 * being the case.
 *
 * Every notice used to be a string with one way out: the Dismiss button. So
 * "Sarah went back to the map" and "Sarah picks the next level" -- both of
 * which are true for about four seconds -- sat on the other person's screen
 * through the whole of the next level, and they had to dismiss a message about
 * a decision that had already been made. The person who made it saw nothing and
 * had no idea.
 *
 * A kind is the answer to "when does this stop being true":
 *
 *  * `map` and `chooser` stop the moment a level starts. Both describe the gap
 *    between levels, and a level running is proof the gap is over.
 *  * `stall` stops when the link recovers. `watchStall` owns it outright and
 *    nothing else may take it down, or the two would disagree about whether
 *    the message is up.
 *  * `suspend` stops after it has been read. Pausing is a COMMAND inside the
 *    simulation rather than a stop, so the session goes on running and there is
 *    no transition to hang it off -- and the game draws its own pause over the
 *    canvas anyway. The nudge says which key; once there has been time to read
 *    it, it has done its job.
 *  * `session` and `art` never expire on their own. Somebody left, or the game
 *    is missing pieces -- the reader has to actually see those.
 */
type NoticeKind = "stall" | "chooser" | "map" | "session" | "art" | "suspend";

/** Kinds a level starting makes untrue. */
const BETWEEN_LEVELS: NoticeKind[] = ["map", "chooser", "suspend"];

/** Kinds that also come down on their own, having been read. */
const FADES: NoticeKind[] = ["map", "chooser", "suspend"];

/**
 * How long an informational line stays up with nothing else happening.
 *
 * The backstop for the case the rule above does not cover: the pick was handed
 * over and then nobody started anything. Long enough to read twice, short
 * enough that it is gone before it becomes furniture. `session`, `art` and
 * `stall` ignore it -- each of those is either something the reader has to act
 * on or something with an owner that will take it down itself.
 */
const NOTICE_MS = 8000;

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

/** `--leave` in styles.css. The attribute follows the animation, so they agree. */
const LEAVE_MS = 140;
/** Asked rather than assumed, and re-asked: the setting can change mid-session. */
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

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
  // Solo progress belongs to the ACCOUNT now, not to this browser -- see
  // solosave.ts for the key that used to be shared by everybody who signed in
  // here. `pairProgress` still wraps it: alone it is this store, and in a pair
  // it becomes the pair's shared map and hands the solo one back afterwards.
  const solo = soloProgress();
  const progress = pairProgress(solo.store);
  // Whatever this browser has, merged with whatever the account has, before the
  // first frame puts a map on screen.
  void solo.sync();

  // A live region: the connection state changes on the network's schedule
  // rather than on the reader's, so a stall, a reconnection or a friend leaving
  // has to announce itself or it is invisible to anybody not watching the top
  // of the screen. Polite, because none of it is urgent enough to interrupt.
  const status = el("span", {
    class: "status", role: "status", "aria-live": "polite",
  }, "solo");
  const mute = el("button", { class: "ghost" }, muted ? "Unmute" : "Mute");
  /*
   * Whether the two of you are actually linked, in one glance: green
   * "Connected" while a session is running and input is arriving, amber while
   * it waits on the friend, neutral while it (re)connects, and absent when
   * playing locally. A status, not a button -- it looks like a label so it
   * does not promise a click. The live region above says the same in words.
   */
  const connection = el("span", { class: "link-state", "data-state": "local", "aria-hidden": "true" });
  connection.hidden = true;
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
  // Built only into an explicitly flagged preview. The console hook returns
  // counters and path state, never the transport, tokens or ICE credentials.
  type PreviewManager = Transport & { inner?: Transport; state?: string;
    attempts?: number; migrations?: number; duplicates?: number;
    attempt?: { transport?: Transport & { pc?: { close(): void } } } };
  const previewManager = (): PreviewManager | null => {
    let current: PreviewManager | null = link as PreviewManager | null;
    for (let i = 0; current && i < 4; i++) {
      if (typeof current.attempts === "number") return current;
      current = current.inner as PreviewManager | null ?? null;
    }
    return null;
  };
  const previewWindow = window as Window & { fbwgNetworkTest?: {
    snapshot(): unknown; closeRtc(): boolean; blackholeRtc(): boolean;
    ice(): Promise<unknown>; digestAt(frame: number): string | null;
    rememberRtc(): boolean; retiredRtcIgnored(): boolean } };
  if (__PATH_MANAGER__ && __NETWORK_TEST_HOOKS__) {
    let initialSession: unknown = null;
    let initialLevel: unknown = null;
    let initialView: unknown = null;
    const retiredAttempts: unknown[] = [];
    let observedManager: unknown = null;
    let relayInputs = 0;
    previewWindow.fbwgNetworkTest = {
      snapshot: () => {
        const manager = previewManager();
        if (manager && manager !== observedManager) {
          const observed = manager as PreviewManager & {
            deliver?: (bytes: Uint8Array, source: string) => void };
          if (observed.deliver) {
            const original = observed.deliver.bind(observed);
            observed.deliver = (bytes, source) => {
              if (source === "relay" && bytes[0] === 1) relayInputs++;
              original(bytes, source);
            };
            observedManager = manager;
          }
        }
        const session = view.session;
        if (initialSession === null && session?.running) initialSession = session;
        if (initialLevel === null && view.level) initialLevel = view.level;
        if (initialView === null && session?.running) initialView = view;
        const internals = session as unknown as {
          confirmed?: number; lastRemoteFrame?: number; nextLocal?: number } | null;
        return { at: Date.now(), path: link?.activePath ?? null,
          state: manager?.state ?? null, attempts: manager?.attempts ?? null,
          migrations: manager?.migrations ?? null, duplicates: manager?.duplicates ?? null,
          frame: session?.frame ?? null, confirmed: internals?.confirmed ?? null,
          generation: session?.generation ?? null, runSerial: session?.runSerial ?? null,
          sameSession: initialSession === null ? null : session === initialSession,
          sameLevel: initialLevel === null ? null : view.level === initialLevel,
          sameView: initialView === null ? null : view === initialView,
          running: session?.running ?? null, desyncs: session?.desyncs ?? null,
          stalls: session?.stalls ?? null, rollbacks: session?.rollbacks ?? null,
          deepestRollback: session?.deepestRollback ?? null,
          lastRemoteFrame: internals?.lastRemoteFrame ?? null,
          nextLocal: internals?.nextLocal ?? null,
          relaySent: manager?.attempts === undefined ? null :
            (manager as PreviewManager & { relay?: { sent?: number } }).relay?.sent ?? null,
          relayInputs,
          relayReceived: (manager as PreviewManager & {
            relay?: { stats?: { receivedPackets?: number } } } | null)?.relay?.stats?.receivedPackets ?? null,
          qoe: qoe.summary() };
      },
      digestAt: (frame: number) => {
        const session = view.session as unknown as {
          confirmed?: number; hashes?: Map<number, string> } | null;
        if (!Number.isSafeInteger(frame) || frame < 0 ||
            frame > (session?.confirmed ?? -1)) return null;
        return session?.hashes?.get(frame) ?? null;
      },
      ice: async () => {
        const manager = previewManager();
        const pc = manager?.attempt?.transport?.pc as RTCPeerConnection | undefined;
        if (!pc) return null;
        const stats = await pc.getStats();
        const values = [...stats.values()] as unknown as Array<Record<string, unknown>>;
        const transport = values.find(s => s.type === "transport" && s.selectedCandidatePairId);
        const pair = values.find(s => s.id === transport?.selectedCandidatePairId) ??
          values.find(s => s.type === "candidate-pair" && s.nominated === true && s.state === "succeeded");
        const local = values.find(s => s.id === pair?.localCandidateId);
        const remote = values.find(s => s.id === pair?.remoteCandidateId);
        return pair ? { candidateType: local?.candidateType ?? null,
          protocol: local?.protocol ?? null,
          localCandidateType: local?.candidateType ?? null,
          remoteCandidateType: remote?.candidateType ?? null,
          currentRoundTripTime: pair.currentRoundTripTime ?? null } : null;
      },
      rememberRtc: () => {
        const manager = previewManager();
        if (manager?.state !== "RTC_ACTIVE" || !manager.attempt) return false;
        retiredAttempts.push(manager.attempt);
        return true;
      },
      closeRtc: () => {
        const manager = previewManager();
        const pc = manager?.state === "RTC_ACTIVE" ? manager.attempt?.transport?.pc : null;
        if (!pc) return false;
        retiredAttempts.push(manager?.attempt);
        pc.close(); return true;
      },
      blackholeRtc: () => {
        const manager = previewManager();
        const transport = manager?.state === "RTC_ACTIVE" ? manager.attempt?.transport : null;
        if (!transport) return false;
        retiredAttempts.push(manager?.attempt);
        transport.send = () => {}; return true;
      },
      retiredRtcIgnored: () => {
        const manager = previewManager() as PreviewManager & {
          attempt?: unknown; receiver?: (data: Uint8Array) => void;
          onRTC?: (attempt: unknown, data: Uint8Array) => void;
          lastInput?: Uint8Array } | null;
        if (!manager?.receiver || !manager.onRTC || !retiredAttempts.length ||
            retiredAttempts.some(attempt => attempt === manager.attempt)) return false;
        const receiver = manager.receiver;
        let delivered = 0;
        manager.receiver = data => { delivered++; receiver(data); };
        try {
          for (const attempt of retiredAttempts)
            manager.onRTC(attempt, manager.lastInput ?? new Uint8Array([1]));
        } finally { manager.receiver = receiver; }
        return delivered === 0;
      },
    };
  }
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
  /**
   * The line in the banner, and what it is about.
   *
   * The kind is what lets it be taken down by something other than a click;
   * see `NoticeKind`.
   */
  let noticed: { kind: NoticeKind; text: string } | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The exit animation in flight, so an arriving message can cancel it. */
  let leaving: ReturnType<typeof setTimeout> | null = null;
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
  /*
   * No `Ranking` here.
   *
   * It drove the replay verifier, which has never been deployed:
   * `play_private.engine_versions` is seeded empty, so every registration was
   * refused and every finished level put "Not ranked · replay could not be
   * queued" on a second footer line the player could do nothing about. The
   * board reads `pair_progress` and never needed it (see `leaderboard.ts`).
   * `ranking.ts` stays, for when the verifier comes back as a badge.
   */

  const qoe = new QoeRecorder();
  if (import.meta.env.DEV) (window as Window & { fbwgQoe?: () => unknown }).fbwgQoe = () => qoe.summary();
  const view = new GameView({
    canvas,
    assets: __ASSETS__,
    rollbackSmoothing: networkFlags.rollbackSmoothing,
    localDescendantInterpolation: networkFlags.descendantInterpolation,
    onRenderTiming: sample => qoe.rendered(sample),
    save: progress.store,
    onPrepareRun: async v => {
      // Said once per prepared scene, so a level that starts with holes in it
      // says so rather than looking like a rendering bug somebody should
      // report. Preparation retries what failed last time, so this clears
      // itself the moment the art actually arrives.
      if (!v.artComplete) {
        notice("art", "Some game art did not load. The level still plays.");
      }
    },
    onState: () => {
      refreshStatus();
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
        if (playing) {
          lobby?.setActivity("in_game");
          // The whole of the sticky-banner bug, answered in one line.
          //
          // "They went back to the map" and "They pick the next level" describe
          // the gap between levels. A level running is proof the gap is over,
          // and it is proof on BOTH sides at once -- which is what was missing:
          // the person who picked saw nothing to dismiss and the other person
          // was left holding a message about a decision already made.
          clearNotice(...BETWEEN_LEVELS);
        }
      }
      rememberSelection(playing);
      showHand();
      showShare();
    },
    onFrame: () => {
      qoe.tick(performance.now(), view.session);
      const path = link?.activePath;
      if (path === "rtc" || path === "relay") {
        const nextKind = path === "rtc" ? "direct" : "relay";
        if (nextKind !== linkKind) { linkKind = nextKind; refreshStatus(); }
      }
      watchStall(); pace(); freshenReadout();
    },
    onConfirmed: (v, frame) => {
      if (v.session) mirror?.confirmed(v.session,frame);
      if (frame % 26 === 0 || v.game.children.some((c: { Rboard?: unknown }) => c.Rboard)) {
        progress.confirm(v.game.The_cookie.data);
        // `confirm` is the pair path and returns early when there is no
        // partner, so playing alone reached storage and stopped there. This is
        // the other half: alone, the same confirmed state goes up to the
        // account once it settles.
        if (!progress.shared) solo.touched();
      }
    },
    onRefused: (why) => {
      if (why === "preparation-failed") {
        notice("art", "Some game art could not load.",el("button", { class: "ghost", onclick: () => { void view.prepare().catch(() => {}); } },"Retry loading"));
        shell.open("setup");
      }
      if (why === "not-your-pick") {
        notice("chooser", `Waiting for ${partner?.username ?? "them"} to pick the ` +
               "next level.");
      }
    },
  });
  view.setMuted(muted);

  /** The one line in the header that says what is going on. */
  function describe(): string {
    const s = view.session;
    const who = partner?.username ?? "your friend";
    if (!s) return match ? `Reconnecting with ${who}` : "Play locally or invite a friend";
    if (!s.running) return `With ${who} · choosing a level`;
    // `stalling`, not `s.stalled`.
    //
    // The session's own flag goes true on any frame the peer's input has not
    // arrived for and false on the very next one that has, which under ordinary
    // jitter is several times a second -- and it is in the engine's state key,
    // so `onState` fires with it. Reading it here made "waiting for your friend"
    // strobe next to the username at very nearly frame rate, which is what this
    // was reported as. `watchStall` already computes the same fact with two
    // seconds of patience and a second of hysteresis on the way out; that is
    // the one a person should be shown.
    return `${view.slot === 0 ? "Fireboy" : "Watergirl"} with ${who}` +
      (stalling ? " · waiting for your friend" : "") + cost();
  }

  /**
   * Write the status line, from wherever the thing it describes changed.
   *
   * Two callers now, because the two facts it needs change on different
   * schedules: engine state arrives through `onState`, and `stalling` is
   * decided here, per frame, by `watchStall`.
   */
  function refreshStatus(): void {
    const next = describe();
    if (next !== lastStatus) { status.textContent = next; lastStatus = next; }
    const s = view.session;
    const state = s ? (stalling ? "waiting" : "connected") : match ? (rebuilding ? "reconnecting" : "connecting") : "local";
    if (connection.dataset.state !== state) {
      connection.dataset.state = state;
      connection.hidden = state === "local";
      connection.textContent = { connected: "Connected", waiting: "Waiting for friend", reconnecting: "Reconnecting", connecting: "Connecting", local: "" }[state];
    }
  }

  /** When the development readout last changed, so a counter cannot redraw at frame rate. */
  let costAt = 0;
  let costText = "";
  /**
   * What this match is costing and how it is faring, in development only.
   *
   * A relayed pair's message rate is what decides how many games can be played
   * at once -- the free tier allows a hundred a second across the whole project
   * -- and until now every figure about it was arithmetic on the batch
   * interval. `RealtimeTransport` has been counting the real number since it
   * was written; this is the first thing to read it. A direct pair has no
   * counter and nothing is shown, which is itself the point: they cost nothing.
   *
   * `stalls` and the round trip are here for the other half of the same
   * question. Adaptive batching trades one against the other, and without the
   * two side by side there is no way to see whether the trade worked.
   *
   * Rate-limited to once a second, because `sent` changes constantly and is not
   * in the engine's state key: without this the counter alone would rewrite
   * `status.textContent` on every state change, which is the layout thrash the
   * rest of this file is busy removing.
   */
  function cost(): string {
    if (!import.meta.env.DEV) return "";
    const now = Date.now();
    if (now - costAt < 1000) return costText;
    costAt = now;
    const parts: string[] = [];
    const s = view.session;
    if (typeof link?.sent === "number") parts.push(`${link.sent} msgs`);
    // The session's own measurement first: it rides the input packets, so it
    // works on every browser. `getStats` is the cross-check and is null on
    // Firefox forever -- see `sampleRtt` in webrtc.ts.
    const rtt = s?.rttMs ?? (typeof link?.rttMs === "number" ? link.rttMs : null);
    if (link?.rtc?.candidateType) parts.push(`ICE ${link.rtc.candidateType}/${link.rtc.protocol ?? "?"}`);
    if (rtt !== null) parts.push(`${Math.round(rtt)}ms rtt`);
    if (s && s.jitterMs > 0) parts.push(`±${Math.round(s.jitterMs)}ms`);
    // The whole point of the exercise: how far apart the two clocks are, and
    // what is being done about it. Both used to be invisible.
    if (s) parts.push(`adv ${s.advantage.toFixed(1)}`);
    if (s && s.dilation < 1) parts.push(`×${s.dilation.toFixed(3)}`);
    if (s) parts.push(`age ${Math.round(s.inputAgeMs)}/${Math.round(s.windowMs)}ms`);
    if (s && s.inputDelay > 0) parts.push(`delay ${s.inputDelay}`);
    if (hurried) parts.push("hurried");
    const stalls = s?.stalls ?? 0;
    if (stalls) parts.push(`${stalls} stalls`);
    costText = parts.length ? ` · ${parts.join(" · ")}` : "";
    return costText;
  }

  /**
   * Keep the development readout moving, which it otherwise does not.
   *
   * `refreshStatus` runs from `onState`, and the engine's state key holds
   * things that barely change while a level is being played -- whether it is
   * running, the generation, the mute. So the line could sit frozen for a
   * minute at a time, which is fine for the sentence a player reads and
   * useless for the numbers this build added to it: a round trip that arrives
   * after the last state change would simply never be drawn.
   *
   * Gated on the same one-second throttle `cost` already uses, so this costs a
   * comparison a frame and a string once a second. Compiled out entirely in
   * production, where the readout does not exist.
   */
  function freshenReadout(): void {
    if (!import.meta.env.DEV) return;
    if (Date.now() - costAt < 1000) return;
    refreshStatus();
  }

  /**
   * The last selection written down, so writing it is not a per-frame act.
   *
   * This used to run on every `onState`, and `session.stalled` is in the state
   * key -- so a jittery link turned a preference into a synchronous
   * `localStorage.setItem` several times a second, on the same thread that is
   * drawing the game. It is the likeliest single cause of the game "feeling
   * laggy" exactly when the waiting message appeared, because the two had the
   * same trigger.
   */
  let lastSelection = "";
  /** Who this account last played with, for the two panels that open on a pair. */
  function rememberPartner(id: string): void {
    if (lastPartner === id) return;
    lastPartner = id;
    leaderboard.invalidate();
    try { localStorage.setItem(`fbwg.lastPartner.${auth().user!.id}`, id); } catch { /* optional */ }
  }
  function rememberSelection(playing: boolean): void {
    if (!playing || !match || !view.session) return;
    const selection = view.session.selection;
    const value = JSON.stringify({ ...selection, iAmFireboy: view.slot === 0 });
    if (value === lastSelection) return;
    lastSelection = value;
    try { localStorage.setItem(selectionKey(auth().user!.id, match.friend.id), value); } catch { /* optional */ }
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
    mute.setAttribute("aria-pressed", String(muted));
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
      }).catch(() => { if (!gone) notice("session", "The spectator feed could not connect."); });
    } else if (state?.shared) setSharing(true);
    showShare();
  }

  function setSharing(on: boolean): void {
    if (!match) return;
    if (sharing === on) return;
    sharing = on;
    mirror?.setSharing(on);
    showShare();
    notice("session", on
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
    notice("chooser", mine
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

  // The partner is handed in as a getter rather than a value: the board outlives
  // any one match, and `leaderboard_standing` is a question about a PAIR.
  let lastPartner: string | null = null;
  try { lastPartner = localStorage.getItem(`fbwg.lastPartner.${auth().user!.id}`); } catch { /* optional */ }
  // The partner is handed in as a getter rather than a value: the board outlives
  // any one match, and `leaderboard_standing` is a question about a PAIR.
  const leaderboard = new Leaderboard(board,
    () => view.game.Translation as string[] | undefined,
    () => match?.friend.id ?? lastPartner);
  const shell = new PlayShell(host, {
    canvas, name, status, mute, banner, friends: panel, times, board, connection,
    input: (enabled) => view.setInputEnabled(enabled),
    onPanel: (panel, changed) => {
      if (panel === "leaderboard") leaderboard.open(view.session?.selection ?? loadSelection(auth().user!.id, lastPartner ?? ""), changed);
      // `open`, not `refresh`: the panel has to be told it is visible before it
      // will fetch anything, and it points itself at the current match on the
      // way in. Reached only after construction -- the shell opens "friends".
      if (panel === "progress") progressPanel.open();
    },
    actions: [hand, share, leave, el("button", {
      class: "ghost", onclick: async () => {
        if (match && !confirm("Sign out and leave the game?")) return;
        await signOut();
      },
    }, "Sign out")],
  });
  const progressPanel = new ProgressPanel(times, {
    progress,
    friends: () => lobby?.list ?? [],
    partner: () => partner,
    table: () => view.game.Translation as string[] | undefined,
  });
  const friendsUI = new FriendsPanel(panel, { onInvite: showInviteForm, busy: () => match !== null || pending !== null });
  const watchList = el("section", { class: "watch-list" });
  panel.append(watchList);
  /** How many results had reached the server last time we looked. */
  let sentResults = progress.saves;
  const offSave = progress.onChange(() => {
    const error = progress.lastError ?? progress.storageError;
    shell.saveStatus.textContent = error ? "Retry needed" : progress.waiting ? "Saving…" : "Saved";
    shell.saveStatus.title = error ?? "Your progress";
    // A result that has actually landed is a leaderboard that has actually
    // changed, and the board holds a fifteen-second cache. `quit` has always
    // asked it to redraw, but it asked in the same breath as the save -- so the
    // answer was either the cache or a query that ran before the row existed,
    // and a pair finishing a level watched the board go on saying it was
    // waiting for its first pair. Clearing on the acknowledgement is the only
    // moment that is neither too early nor a guess.
    if (progress.saves !== sentResults) {
      sentResults = progress.saves;
      leaderboardCache.clear();
      leaderboard.invalidate();
      void drawBoard();
    }
    void progressPanel.refresh();
  });
  const otherTab = el("span", { class: "other-tab" }, "Playing in another tab. ");
  otherTab.hidden = true;
  const takeover = el("button", { class: "ghost" }, "Take over here");
  otherTab.append(takeover);
  shell.root.querySelector("footer")!.append(otherTab);
  const lease = new MatchLease(auth().user!.id, busy => { otherTab.hidden = !busy; }, () => {
    pending?.abort.abort(); flow.cancel(); endSession("Your match moved to another tab.");
    notice("session", "Your match moved to another tab.");
  });
  takeover.addEventListener("click", () => {
    takeover.disabled = true;
    void lease.takeover().then(ok => {
      takeover.disabled = false;
      if (ok) { shell.open("friends"); lease.release(); }
      else notice("session", "The other tab did not release the match. Close it and try again.");
    });
  });
  // Toggles, like the toolbar buttons: press it again and Progress goes away.
  // The flush is not conditional on which way it went -- when the label reads
  // "Retry needed" the press IS the retry, and it should still happen on the
  // press that closes the panel.
  on(shell.saveStatus, "click", async () => { shell.toggle("progress"); await progress.flushNow(); drawTimes(); });
  shell.notify("Preparing the game…");
  const prepare = () => {
    void view.prepare().then(() => { if (!gone) { shell.notify(""); void leaderboard.refresh(); } }).catch(() => {
      if (gone) return;
      notice("art", "Some game art could not be loaded.", el("button", { class: "ghost", onclick: prepare }, "Retry loading"));
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

  /**
   * A one-line message, replacing whatever the banner was showing.
   *
   * Idempotent, and that is load-bearing rather than tidy. Three callers repeat
   * themselves as a matter of course -- `onRefused("not-your-pick")` fires on
   * every click at a map that is not yours to click, the resume message fires on
   * every `visibilitychange`, and `watchStall` re-asserts on recovery -- and
   * each repeat used to rebuild the banner's DOM and move the node between two
   * parents. At a rate somebody drumming on the mouse can reach, that is layout
   * thrash on a page whose stage height is a function of its width.
   */
  function notice(kind: NoticeKind, text: string, ...extra: (Node | string)[]): void {
    if (noticed?.kind === kind && noticed.text === text && extra.length === 0) return;
    shell.showNotice();
    noticed = { kind, text };
    showBanner();
    clear(banner);
    banner.append(el("span", {}, text), ...extra,
      el("button", { class: "ghost", onclick: () => clearNotice() }, "Dismiss"));
    if (noticeTimer !== null) { clearTimeout(noticeTimer); noticeTimer = null; }
    if (FADES.includes(kind)) {
      noticeTimer = setTimeout(() => { noticeTimer = null; clearNotice(kind); }, NOTICE_MS);
    }
  }

  /**
   * The banner is about to hold a FORM rather than a message.
   *
   * An invitation, outbound or incoming, lives in the same strip: it is the one
   * thing on this screen somebody has to answer. Whatever notice was there is
   * replaced, so the kind is let go with it -- otherwise the next automatic
   * clear would be deciding the fate of a message no longer on screen.
   */
  function takeBanner(): void {
    if (noticeTimer !== null) { clearTimeout(noticeTimer); noticeTimer = null; }
    noticed = null;
    showBanner();
    clear(banner);
  }

  /**
   * Put the banner on screen, cancelling an exit that had already begun.
   *
   * Interruptibility, in the one place on this screen that has any: a message
   * arriving while the last one is on its way out must not wait for it, and
   * must not be left invisible because the exit's timer fires afterwards and
   * hides what has since replaced it.
   */
  function showBanner(): void {
    if (leaving !== null) { clearTimeout(leaving); leaving = null; }
    banner.classList.remove("leaving");
    banner.hidden = false;
  }

  /**
   * Take it off screen the way it came on.
   *
   * `[hidden]` is `display:none`, which cannot be animated, so the exit plays
   * first and the attribute follows it. Reduced motion skips straight to the
   * end -- the point of that setting is not to see the travel, and a 140ms
   * pause with nothing moving in it would be the worst of both.
   */
  function hideBanner(): void {
    if (banner.hidden || leaving !== null) return;
    if (reduceMotion.matches) { banner.hidden = true; return; }
    banner.classList.add("leaving");
    leaving = setTimeout(() => {
      leaving = null;
      banner.classList.remove("leaving");
      banner.hidden = true;
    }, LEAVE_MS);
  }

  /**
   * Take the banner down.
   *
   * With no kinds it is unconditional: a Dismiss press, a cancelled invitation
   * and a new session all mean "whatever is in there, it is over" -- and that
   * has to hold for a FORM too, which has no kind at all.
   *
   * With kinds it is the automatic route, and it must be conditional: a level
   * starting clears the messages about there not being one, and must not clear
   * the message saying somebody left.
   */
  function clearNotice(...kinds: NoticeKind[]): void {
    if (kinds.length && (!noticed || !kinds.includes(noticed.kind))) return;
    noticed = null;
    if (noticeTimer !== null) { clearTimeout(noticeTimer); noticeTimer = null; }
    hideBanner();
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
  /** How many separate stalls this match has suffered, for `hurry`. */
  let stallEpisodes = 0;
  /** Whether the link has been asked to spend messages on latency. */
  let hurried = false;
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
    if (bad) {
      notice("stall", `Waiting for ${partner?.username ?? "your friend"}…`);
      stallEpisodes++;
    } else clearNotice("stall");
    // `stalling` is not in the engine's state key, so nothing else will.
    refreshStatus();
  }

  /**
   * Decide whether to spend messages on a shorter batch.
   *
   * This used to be "the second stall in a match, then latch it forever",
   * which was a proxy standing in for a measurement nobody had. The session
   * now reports `pressure` -- how much of the rollback window the peer's input
   * age is actually eating -- so the decision can be made on the thing it was
   * always about.
   *
   * The order is deliberate and it is the opposite of what it looks like.
   * Input delay is the cheaper lever in the only currency that runs out here:
   * a frame of it costs 38.5 ms of feel and NOT ONE MESSAGE, where halving the
   * batch doubles a relayed pair's traffic -- 17.4 message-units a second
   * becomes 34.8, and the free tier's hundred a second goes from about six
   * concurrent relayed pairs to about three. So the session takes delay first,
   * inside the window, and this only fires when the window has run out anyway.
   *
   * Hysteresis on both sides, because flipping the interval every time a link
   * steadied for a second would be worse than either setting.
   */
  function pace(): void {
    const s = view.session;
    if (!s || !match) return;
    // No measurement yet -- a brand new link, or a peer on a build without the
    // trailer. Fall back to the old proxy rather than to nothing.
    const blind = s.rttMs === null;
    const want = blind ? stallEpisodes >= 2 : s.pressure > 0.6;
    const done = blind ? false : s.pressure < 0.4;
    if (want && !hurried) { hurried = true; link?.hurry?.(true); }
    else if (done && hurried) { hurried = false; link?.hurry?.(false); }
  }

  // ---- what you have finished --------------------------------------------

  /**
   * The 32 results, for whichever map the reader asked for.
   *
   * It used to draw `The_cookie.data` -- whatever store the game happened to be
   * holding -- which showed the pair's map during a match and this account's
   * afterwards, with no way to ask for either on purpose. See `ProgressPanel`,
   * which takes a subject and reads a friend's map without adopting it.
   */
  function drawTimes(): void { void progressPanel.refresh(); }

  function drawBoard(): Promise<void> { return leaderboard.refresh(); }

  // ---- the lobby ---------------------------------------------------------


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
      watchDeparture();
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
      notice("session", `${from.username} called that off.`);
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
    friendsUI.update(friends);
    // Whose maps there are to look at. Cheap, and this is the one place the
    // friend list is known to have changed -- including somebody being removed,
    // which has to take their option away with them.
    progressPanel.fill();
    clear(watchList);
    // Games our friends have opened. Pushed to us when they turn watching on,
    // because a friend cannot ask who is playing -- other people's friendships
    // are not theirs to see.
    if (showing.size > 0) {
      watchList.append(el("h2", {}, "Watch"));
      for (const [topic, s] of showing) {
        watchList.append(el("div", { class: "row" },
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
  function showInviteForm(friend: FriendState, slot: HTMLElement): void {
    if (match || pending) return;
    flow.set("configuring");
    lobby?.prioritize(friend.id);
    shell.placeSetup(slot);
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
      clearNotice();
      drawPanel(lobby?.list ?? []);
      shell.open("friends");
    });

    takeBanner();
    banner.append(
      el("span", {}, `Invite ${friend.username}:`),
      el("label", { class: "setup-field" }, "Mode", mode),
      el("label", { class: "setup-field" }, "Level", num),
      el("label", { class: "setup-field" }, "Characters", roles), go, say,
      stop);
    mode.focus({ preventScroll: true });
    requestAnimationFrame(() => { if (!gone && slot.isConnected) banner.scrollIntoView({ block: "nearest" }); });

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
      clearNotice();
      drawPanel(lobby?.list ?? []);
    });

    takeBanner();
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
    qoe.attach(ready.transport, ready.kind);
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
    clearNotice();
    stalling = false;
    // A new link, and the batching question asked again from scratch. A pair
    // that was on the fast interval may have just been handed a direct peer
    // connection, where there is nothing to hurry -- and `pace` re-decides
    // from measurement within a second either way, so there is no verdict here
    // worth carrying over.
    stallEpisodes = 0;
    hurried = false;
    leave.hidden = false;
    lobby?.setActivity("in_game");
    // Remembered HERE rather than where the invitation is sent.
    //
    // It was written only by the person who did the inviting, so somebody who
    // always accepts never had a last partner -- and that name is what the
    // Leaderboard opens on and what `leaderboard_standing` is a question
    // about. Half the pairs in every game had the feature turned off by which
    // of them pressed the button. A match beginning is the event that is true
    // for both of them.
    rememberPartner(ready.friend.id);
    // Whose map the Progress panel shows, unless the reader has already said.
    progressPanel.follow();

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
    refreshStatus();
    const them = match.friend.username;

    if (!match.iInvited) {
      // Not ours to offer -- but very much ours to ask for. A peer connection
      // can fail at one end and be perfectly healthy at the other, so the side
      // that noticed has to be able to start something, or a one-sided failure
      // is a pair sitting and waiting for each other forever.
      notice("session", `Lost the connection to ${them}. Reconnecting…`);
      // The last wait is the inviter's to use: it is their final attempt
      // answering our final request, not another request of our own.
      const waits = [0, 1000, 2000, 4000, 8000, 16000, 16000];
      for (const [i, wait] of waits.entries()) {
        if (abort.signal.aborted || !match) return;
        await new Promise((r) => setTimeout(r, wait));
        if (abort.signal.aborted || !match) return;
        if (view.session) return;              // they got through to us
        if (departed()) break;
        if (i < waits.length - 1) lobby?.askResume(match.friend.id, match.invite);
      }
      // This used to `return` here and leave the match in place, with no link
      // and nobody retrying: the header said "Reconnecting with …" and the pill
      // said "Connecting" for as long as the tab stayed open, while the friends
      // list beside them had already said Offline.
      if (abort.signal.aborted || !match || view.session) return;
      rebuilding = null;
      endSession(departed() ? `${them} left the game.` : `Could not get back to ${them}.`);
      return;
    }

    // Backing off, because the usual cause is a network that is still coming
    // back and hammering it helps nobody.
    for (const wait of [500, 1000, 2000, 4000, 8000, 16000]) {
      if (abort.signal.aborted || !match) break;
      notice("session", `Lost the connection to ${them}. Reconnecting…`);
      try {
        // Carrying whether the last link was a relay, so neither side spends
        // eight seconds asking a NAT the question it already refused -- and
        // spends them with the transport blocked by the handshake, which for
        // a relayed pair is the game's own channel. Both peers read this one
        // invitation, so the two of them cannot disagree about it.
        const ready = await lobby!.resume(
          match.friend.id,
          { ...match.invite, relay: match.invite.pathManager ? false : linkKind === "relay" },
          { signal: abort.signal });
        rebuilding = null;
        begin(ready, ready.invite);
        return;
      } catch (e) {
        if (abort.signal.aborted) return;
        console.info("reconnect attempt failed:", (e as Error).message);
      }
      if (departed()) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    if (abort.signal.aborted) return;
    rebuilding = null;
    endSession(departed() ? `${them} left the game.` : `Could not get back to ${them}.`);
  }

  /**
   * Whether the partner has gone offline in presence -- closed the tab, most
   * likely. There is nobody to reconnect to and no point pretending otherwise.
   */
  function departed(): boolean {
    const still = lobby?.list.find((f) => f.id === match?.friend.id);
    return !still || still.activity === null;
  }

  /**
   * End a match whose link is gone once presence says the partner is too.
   *
   * `reconnect` only looks at presence between its own attempts, and an attempt
   * can sit on a handshake for many seconds -- so a friend who closed their tab
   * left this side on "Reconnecting with …" long after the friends list said
   * Offline. This answers the presence change itself.
   *
   * Only while OUR presence is connected, because a lobby channel that has
   * dropped shows every friend as absent at once, and only after a short grace,
   * because presence can flap on a rejoin.
   */
  let departure: ReturnType<typeof setTimeout> | null = null;
  function watchDeparture(): void {
    const them = match && lobby?.list.find((f) => f.id === match!.friend.id);
    const linkless = !view.session || view.session.linkDown;
    const left = !!them && linkless && them.connection === "connected" && them.activity === null;
    if (!left) {
      if (departure !== null) { clearTimeout(departure); departure = null; }
      return;
    }
    if (departure !== null) return;
    departure = setTimeout(() => {
      departure = null;
      const still = match && lobby?.list.find((f) => f.id === match!.friend.id);
      if (!match || !still || (view.session && !view.session.linkDown)) return;
      if (still.connection === "connected" && still.activity === null) {
        endSession(`${match.friend.username} left the game.`);
      }
    }, 3000);
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
        notice("map", `${partner?.username ?? "They"} went back to the map.`);
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
    if (departure !== null) { clearTimeout(departure); departure = null; }
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
    stallEpisodes = 0;
    hurried = false;
    lastSelection = "";
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
    notice("session", why);
    // Before `drawTimes`, because the panel follows the match and there is no
    // longer one -- the picker goes back to "Just me" and the tab with it.
    progressPanel.released();
    drawPanel(lobby?.list ?? []);
    // The pair's map has just been handed back for this browser's own.
    drawTimes();
    // Header and link pill, which otherwise wait for the engine's next state
    // change to stop saying "Reconnecting".
    refreshStatus();
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
      void consent?.refresh();
      if (match) notice("suspend", "Press P when you are both ready to continue.");
    }
  };
  document.addEventListener("visibilitychange",visibility);


  // Tearing the view down matters: it owns a requestAnimationFrame loop, window
  // key listeners and an audio context. The LOBBY is deliberately left alone --
  // it belongs to the session, and closing it here would take the pair offline
  // to each other every time somebody opened their friends list.
  return () => {
    gone = true;
    qoe.close();
    if (import.meta.env.DEV) delete (window as Window & { fbwgQoe?: () => unknown }).fbwgQoe;
    if (__PATH_MANAGER__ && __NETWORK_TEST_HOOKS__) delete previewWindow.fbwgNetworkTest;
    flow.cancel();
    if (noticeTimer !== null) { clearTimeout(noticeTimer); noticeTimer = null; }
    if (leaving !== null) { clearTimeout(leaving); leaving = null; }
    if (departure !== null) { clearTimeout(departure); departure = null; }
    shell.destroy();
    friendsUI.destroy();
    leaderboard.destroy();
    progressPanel.destroy();
    consent?.close(); consent = null; watchGeneration++;
    lease.close();
    // One last push, then stop. Leaving the screen is the most likely moment
    // for a level finished seconds ago to still be sitting in the settle timer.
    void solo.sync();
    solo.close();
    offSave();
    removeEventListener("pagehide", onHide);
    removeEventListener("pageshow", onShow);
    document.removeEventListener("visibilitychange",visibility);

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
