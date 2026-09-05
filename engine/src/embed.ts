/**
 * The game, mounted on a canvas.
 *
 * Everything the ported game needs to be playable in a page and nothing it does
 * not: the fixed-step loop, the art and audio, the keyboard and the mouse, and
 * a socket for a netplay session. No readouts, no debug buttons, no test hooks
 * -- those belong to the engine's own harness, which builds on this.
 *
 * The loop is a fixed 1/26 s accumulator, never delta-time, because the
 * simulation has to advance in identical discrete steps on both peers. Each
 * step does what Flash did in a frame, in Flash's order: advance the playheads
 * (running any frame scripts), then broadcast ENTER_FRAME. The ported shell
 * hangs off that broadcast entirely -- level.Update, the pause tray's slide,
 * the results board's easing, the timer, the fireflies.
 *
 * There is deliberately no stage transform here. `Game.StartGame` does it
 * itself (`m_level.scaleX = 0.8; m_level.x += 16`), exactly as the original
 * did, and applying it a second time would shrink the level inside the menus.
 */
import { Game, level, tickClock, resetClock } from "./game/game.js";
import { hashLevel } from "./net/hash.js";
import {
  SoundBus, Keyboard, advanceTree, enterFrameTree,
} from "./flash/flash.js";
import { SpriteRenderer } from "./render/sprites.js";
import { ShellInput } from "./game/shellinput.js";
import { AudioPlayer } from "./audio/player.js";
import { NetSession, Slot } from "./net/session.js";
import { GameHost } from "./net/gamehost.js";
import { Command } from "./net/protocol.js";
import { Transport } from "./net/transport.js";
import { getSaveStore, setSaveStore, type SaveStore } from "./game/save.js";
import type { Intent } from "./game/shellinput.js";

/** The original stage: 39*20*0.8 + 16 = 640, 29*20*0.8 + 16 = 480. */
export const STAGE_W = 640;
export const STAGE_H = 480;

const TIME_STEP = 1 / 26;

/** Keys that drive a character, in both control schemes. */
const MOVEMENT = ["ArrowLeft", "ArrowRight", "ArrowUp", "a", "d", "w"];

const CODES: Record<string, number> = {
  ArrowLeft: Keyboard.LEFT, ArrowRight: Keyboard.RIGHT,
  ArrowUp: Keyboard.UP, ArrowDown: Keyboard.DOWN,
  Enter: Keyboard.ENTER, Escape: Keyboard.ESCAPE, " ": Keyboard.SPACE,
};

export interface GameViewOptions {
  canvas: HTMLCanvasElement;
  /** Where the extracted art and audio live. */
  assets?: string;
  /**
   * Where this view's progress is kept.
   *
   * Per view, and that is the whole point of it. `openSave` reads a module
   * global, and a global that one screen sets and never puts back is a global
   * every later screen inherits: the play screen installed the PAIR's store,
   * the watch screen built a view without mentioning saves, and a level watched
   * to its end wrote the players' medals and times into the watcher's own
   * progress -- or, after a visit to pair play, into the pair's. The comment at
   * the top of `screens/watch.ts` promised that watching touches nothing, and
   * nothing implemented the promise.
   *
   * A watcher passes `MemorySave`; a pair passes the pair's store; solo passes
   * nothing and gets this browser's `localStorage` as before. The factory is
   * scoped around the one constructor call that consults it and restored
   * afterwards, so no view can leave it pointing anywhere.
   */
  save?: SaveStore;
  /** Called after every rendered frame, for whatever the page shows around it. */
  onFrame?: (view: GameView) => void;
  /** Emitted only when observable shell/session state changes. */
  onState?: (view: GameView) => void;
  onConfirmed?: (view: GameView, frame: number) => void;
  /** Runs after scene preparation and before the first simulation frame. */
  onPrepareRun?: (view: GameView) => Promise<void>;
  /**
   * A button that changes shared state was pressed and could not be honoured.
   * Today the only one is a map node clicked by the peer who does not choose
   * levels, which the page turns into "waiting for them to pick".
   */
  onRefused?: (reason: RefusedReason) => void;
}

export type RefusedReason = "not-your-pick" | "preparation-failed";

export interface JoinOptions {
  initialLevel?: { mode: string; num: number };
  /**
   * Whether this peer's map clicks start a level for the pair.
   *
   * Exactly one of the two says yes, and it is the one who sent the invitation.
   * Between levels both maps are live and local, so without a single decider
   * two people clicking different nodes at the same moment would each start
   * their own and there would be no way back.
   */
  canChooseLevel?: boolean;
  onDesync?: (frame: number, mine: string, theirs: string) => void;
  /** A Quit took effect. `bySlot` is who asked for it. */
  onQuit?: (bySlot: Slot, forGood: boolean) => void;
  /** The link is gone. The page decides whether to rebuild it. */
  onLinkDown?: (why: string) => void;
}

export class GameView {
  readonly game: any;
  readonly shell: ShellInput;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly onFrame?: (v: GameView) => void;
  private readonly onState?: (v: GameView) => void;
  private readonly onConfirmed?: (v: GameView, frame: number) => void;
  private lastState = "";
  private inputEnabled = true;
  private lastDrawnFrame = -1;
  private lastSaveFrame = -1;
  private assetBase: string;
  private preparation: Promise<void> | null = null;
  private preparationGeneration = 0;
  private prepared = false;
  private lastAssetRevision = -1;
  private readonly onRefused?: (reason: RefusedReason) => void;
  private readonly onPrepareRun?: (view: GameView) => Promise<void>;

  sprites: SpriteRenderer | null = null;
  audio: AudioPlayer | null = null;

  /** The netplay session, once two peers have paired. Null when solo. */
  session: NetSession | null = null;
  slot: Slot = 0;
  /** Whether this peer's map clicks start a level for the pair. */
  canChooseLevel = false;
  /** Watching somebody else's game rather than playing in one. */
  watching = false;
  private transport: Transport | null = null;

  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = true;
  private muted = false;
  private frame = 0;
  private lastLevel: any = null;
  /** Movement keys currently held, for the session's three bits. */
  private held = new Set<string>();
  private listeners: (() => void)[] = [];

  constructor(o: GameViewOptions) {
    this.canvas = o.canvas;
    this.canvas.width = STAGE_W;
    this.canvas.height = STAGE_H;
    this.ctx = this.canvas.getContext("2d")!;
    this.onFrame = o.onFrame;
    this.onState = o.onState;
    this.onConfirmed = o.onConfirmed;
    this.onRefused = o.onRefused;
    this.onPrepareRun = o.onPrepareRun;

    resetClock();
    // Scoped, not installed: `Game`'s constructor calls `openSave` once and
    // holds the result forever, so the factory only has to be right for the
    // length of this call -- and must be back to whatever it was afterwards,
    // or the next view built anywhere inherits this one's storage.
    const previous = getSaveStore();
    if (o.save) setSaveStore(() => o.save!);
    try {
      this.game = new (Game as any)();
    } finally {
      setSaveStore(previous);
    }
    this.shell = new ShellInput(this.game, this.game.stage);

    const base = o.assets ?? "/extracted/assets";
    this.assetBase = base;
    // Art and audio arrive whenever they arrive. The game is playable before
    // either does -- the renderer draws nothing it has not got, and the sound
    // bus holds its queue -- so neither is awaited.
    //
    // And whenever they arrive may be after this view is gone: a route change
    // during the first few seconds used to leave a loader resolving into a
    // destroyed view, which for the audio player meant an AudioContext and two
    // global gesture listeners that nothing would ever take down again.
    void this.prepare().catch((e) => console.warn("sprite art unavailable:", e));
    AudioPlayer.load(base).then((a) => {
      if (this.destroyed) { a.dispose(); return; }
      this.audio = a;
    }).catch((e) => console.warn("audio unavailable:", e));

    // Installed before anything can be clicked. Solo it answers "not mine" to
    // everything and the ported handlers run untouched; in a session it is what
    // stops a button changing one machine's world and not the other's.
    this.shell.onIntent((i) => this.handleIntent(i));

    this.bind();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  // ---- what a button means ----------------------------------------------

  /**
   * Turn a shared-state button into a command, or refuse it.
   *
   * Returning false leaves the ported handler to run, which is right whenever
   * nothing is shared: solo, and on the map between levels where each player is
   * looking at their own copy of the shell.
   */
  private handleIntent(intent: Intent): boolean {
    const s = this.session;

    // Mute is this player's preference and always has been -- one of them
    // wanting quiet says nothing about the other. The ported button writes
    // `Game.Muted`, which the snapshot walk reaches, so in a session it used to
    // be undone within a frame while the audio it had already silenced stayed
    // silent. The page's own mute is outside the snapshot and is the honest
    // place for it.
    //
    // The little icon follows, because `showMute` re-asserts it after every
    // tick. It is in the snapshot and gets rewound like everything else; it is
    // simply written again, which is safe precisely because nothing reads it.
    if (intent.kind === "mute") {
      if (!s) return false;
      this.setMuted(!this.muted);
      return true;
    }
    if (!s && intent.kind === "start") {
      void this.prepareLevel(intent.mode,intent.num).then(() => {
        if (!this.destroyed && !this.session) {
          new GameHost(this.game,undefined,() => this.prepareScene()).start(intent.mode,intent.num);
        }
      }).catch(() => this.onRefused?.("preparation-failed"));
      return true;
    }
    if (!s) return false;

    // Watching. Every button that would change the game belongs to the two
    // people playing it, so they are all swallowed -- not dispatched locally,
    // which is the bug this hook exists to prevent, and not sent, because the
    // session refuses that too.
    if (this.watching) return true;

    if (intent.kind === "start") {
      // Mid-level there is no map to have clicked, but a Start applied on one
      // peer and dropped by the other's guard has no way back, so say no twice.
      if (s.running) return true;
      if (!this.canChooseLevel) { this.onRefused?.("not-your-pick"); return true; }
      void this.prepareLevel(intent.mode,intent.num).then(() => {
        if (!this.destroyed && this.session === s && this.canChooseLevel) s.requestStart(intent.mode,intent.num);
      }).catch(() => this.onRefused?.("preparation-failed"));
      return true;
    }

    // Between levels the shell is local, so the pause tray and the boards --
    // which cannot be on screen anyway -- are nobody else's business.
    //
    // Except that "cannot be on screen anyway" is an assumption, and when it
    // broke the consequence was not small: the ported handler ran `EndGame`
    // against a level that had already gone and `CreateMainMenu` built a
    // second map on top of the first. Retry and quit mean nothing with no
    // level up, so they are refused here rather than dispatched.
    if (!s.running) {
      return intent.kind === "retry" || intent.kind === "quit";
    }
    switch (intent.kind) {
      case "retry": s.send(Command.Retry); return true;
      case "pause": s.send(Command.Pause); return true;
      case "quit": s.send(Command.Quit, this.slot); return true;
    }
    return false;
  }

  // ---- input ------------------------------------------------------------

  private bind(): void {
    const on = <K extends keyof WindowEventMap>(
      target: EventTarget, type: K, fn: (e: WindowEventMap[K]) => void,
    ) => {
      target.addEventListener(type, fn as EventListener);
      this.listeners.push(() => target.removeEventListener(type, fn as EventListener));
    };

    on(window, "keydown", (e) => this.keyDown(e));
    on(window, "keyup", (e) => this.keyUp(e));
    on(window, "blur", () => {
      // Release everything, or a key held across a tab switch sticks down.
      this.held.clear();
      for (const c of [Keyboard.LEFT, Keyboard.RIGHT, Keyboard.UP,
                       Keyboard.A, Keyboard.D, Keyboard.W]) this.shell.forwardUp(c);
    });
    on(window, "focusin", (e) => {
      if (GameView.aimedElsewhere(e as unknown as KeyboardEvent)) this.clearInput();
    });
    on(window, "pagehide", () => { this.game.The_cookie?.flush?.(); });

    on(this.canvas, "pointermove", (e) => {
      const over = this.shell.pointerMove(this.pick(e as PointerEvent));
      this.canvas.style.cursor = over ? "pointer" : "default";
    });
    on(this.canvas, "pointerdown", (e) => {
      if (!this.inputEnabled) return;
      this.canvas.focus({ preventScroll: true });
      const target = this.pick(e as PointerEvent);
      if (!target) return;
      e.preventDefault();
      // Capture, so releasing off the button still reaches us and the press
      // can be cancelled the way Flash cancels it.
      this.canvas.setPointerCapture((e as PointerEvent).pointerId);
      this.shell.pointerDown(target);
    });
    on(this.canvas, "pointerup", (e) => {
      // The click fires on release, not on the press, so the down art is on
      // screen for at least a frame before its screen is torn down.
      const target = this.pick(e as PointerEvent);
      if (target === null) this.shell.pointerCancel();
      else this.shell.pointerUp();
      this.canvas.style.cursor = target ? "pointer" : "default";
    });
    on(this.canvas, "pointercancel", () => this.shell.pointerCancel());
    on(this.canvas, "pointerleave", () => {
      this.shell.pointerCancel();
      this.shell.pointerMove(null);
      this.canvas.style.cursor = "default";
    });
  }

  private static codeOf(e: KeyboardEvent): number {
    if (CODES[e.key] !== undefined) return CODES[e.key];
    if (e.key.length === 1) return e.key.toUpperCase().charCodeAt(0);
    return 0;
  }

  /**
   * Whether this key belongs to the control it was pressed on rather than to
   * the game.
   *
   * The keyboard is bound to `window`, not to the canvas, so that a player who
   * has clicked a button in the chrome can still move -- but that also means
   * every key on the page arrives here, including the ones somebody is aiming
   * at a form control. The level and leaderboard pickers are `<select>`s and
   * sit on the same screen as a running game: the arrows that open one and walk
   * its options were being cancelled by `keyDown`'s own `preventDefault` and fed
   * to Fireboy at the same time, and `r` -- which a select reads as type-ahead
   * -- was sending Retry to a shared session.
   *
   * A select or a text field owns every key while it has focus. A button or a
   * link owns only the two that press it, so muting and then carrying on
   * playing still works.
   */
  private static aimedElsewhere(e: KeyboardEvent): boolean {
    const target = e.target as HTMLElement | null;
    // No target at all is the document's key, which is the game's.
    if (!target) return false;
    if (target.isContentEditable) return true;
    switch (target.tagName) {
      case "INPUT": case "TEXTAREA": case "SELECT": case "OPTION": return true;
      case "BUTTON": case "A": return e.key === " " || e.key === "Enter";
      default: return false;
    }
  }

  private keyDown(e: KeyboardEvent): void {
    if (!this.inputEnabled || e.defaultPrevented || GameView.aimedElsewhere(e)) return;
    if (e.repeat && ["p", "r", "Escape"].includes(e.key.toLowerCase())) return;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(e.key)) {
      e.preventDefault();
    }
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    // Only while a LEVEL is running. Between levels the same keys are the map's
    // -- the arrows walk its nodes -- and a session that is not running a level
    // has nothing shared for P or R to change.
    if (this.live && !this.watching) {
      // In a session the level's input belongs to the netcode, not to
      // Game.keyPressed: writing it locally would apply this player's move
      // without the other peer ever hearing about it.
      if (MOVEMENT.includes(key)) { this.held.add(key); return; }
      if (key === "p") { this.session!.send(Command.Pause); return; }
      if (key === "r") { this.session!.send(Command.Retry); return; }
    }

    const code = GameView.codeOf(e);
    // The shell gets Escape first, because on a board it means that board's
    // "to menu" button and goes out as a command through the intent hook. Only
    // an Escape nothing else wanted is the blunt "leave this level".
    if (this.shell.keyDown(code, key)) return;
    if (this.live && !this.watching && key === "Escape") {
      this.session!.send(Command.Quit, this.slot);
      return;
    }
    this.shell.forwardDown(code);
  }

  private keyUp(e: KeyboardEvent): void {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // The release clears the held set wherever it happened. A key pressed over
    // the game and released after focus has moved into a picker is the one way
    // a direction could otherwise stay down forever, and window `blur` does not
    // fire for a focus change inside the same page.
    if (this.live && MOVEMENT.includes(key)) { this.held.delete(key); return; }
    if (!this.inputEnabled || GameView.aimedElsewhere(e)) return;
    this.shell.forwardUp(GameView.codeOf(e));
  }

  /** A session that is actually simulating a level right now. */
  private get live(): boolean {
    return this.session !== null && this.session.running;
  }

  /**
   * This player's three bits.
   *
   * Either control scheme drives YOUR character: you only have one, so there
   * is nothing to disambiguate, and asking the Watergirl player to use W/A/D
   * because that is what the 2009 keyboard split said would be pointless when
   * they are alone at their own keyboard.
   */
  private bits(): number {
    const h = this.held;
    return ((h.has("ArrowLeft") || h.has("a")) ? 1 : 0) |
           ((h.has("ArrowRight") || h.has("d")) ? 2 : 0) |
           ((h.has("ArrowUp") || h.has("w")) ? 4 : 0);
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    if (!enabled) this.clearInput();
  }
  get isPreparing(): boolean { return !this.prepared; }
  /**
   * Whether every image this scene reaches is actually loaded.
   *
   * False is playable and not an error -- see `SpriteRenderer.prepare` -- but
   * it is a reason not to rank the run, because a replay is only worth
   * verifying if both peers were simulating and drawing the same thing. Only a
   * manifest that will not load at all is fatal, and that rejects `prepare`
   * rather than showing up here.
   *
   * Meaningful once `prepare` has settled, which both of its readers satisfy:
   * `onPrepareRun` is called from inside it, and the frame loop does not run
   * at all until `prepared`.
   */
  get artComplete(): boolean { return (this.sprites?.missing ?? 0) === 0; }
  private prepareScene(): void {
    this.preparationGeneration++;
    this.prepared = false;
    this.preparation = null;
    this.clearInput();
    void this.prepare().catch(() => this.onRefused?.("preparation-failed"));
  }

  prepare(): Promise<void> {
    if (this.preparation === null) {
      const generation = this.preparationGeneration;
      this.preparation = (async () => {
        const sprites = this.sprites ?? await SpriteRenderer.load(this.assetBase);
        if (this.destroyed || generation !== this.preparationGeneration) return;
        this.sprites = sprites;
        await sprites.prepare(this.game);
        if (this.destroyed || generation !== this.preparationGeneration) return;
        await this.onPrepareRun?.(this);
        if (this.destroyed || generation !== this.preparationGeneration) return;
        this.prepared = true;
        this.render();
      })().catch(e => {
        if (generation === this.preparationGeneration) this.preparation = null;
        throw e;
      });
    }
    return this.preparation;
  }

  async prepareLevel(mode: string, num: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.prepare();
    signal?.throwIfAborted();
    const scene = new (level as any)(mode, num);
    await this.sprites!.prepare(scene);
    signal?.throwIfAborted();
  }

  clearInput(): void {
    this.held.clear();
    for (const c of [Keyboard.LEFT, Keyboard.RIGHT, Keyboard.UP, Keyboard.A, Keyboard.D, Keyboard.W]) this.shell.forwardUp(c);
    this.session?.setLocalInput(0);
  }

  pauseForSuspension(): void {
    this.clearInput();
    if (this.session) this.session.send(Command.Pause, 1);
    else new GameHost(this.game).pause(true);
  }

  /**
   * The canvas is a fixed 640x480 stage that CSS may be scaling, so pointer
   * coordinates have to come back through that scale before they mean anything
   * to the display list.
   */
  private pick(e: PointerEvent): any {
    if (!this.sprites) return null;
    const r = this.canvas.getBoundingClientRect();
    return this.sprites.hitTest(
      this.game,
      (e.clientX - r.left) * (STAGE_W / r.width),
      (e.clientY - r.top) * (STAGE_H / r.height));
  }

  // ---- netplay ----------------------------------------------------------

  /**
   * Hand the clock to a lockstep-with-rollback session.
   *
   * Everything above the transport is the same code the netcode tests drive,
   * so what they prove holds here.
   */
  join(transport: Transport, slot: Slot, o: JoinOptions = {}): NetSession {
    // Whatever was here goes first. Reconnecting calls this again, and simply
    // assigning over `session` and `transport` left the previous pair of them
    // alive and unreferenced -- still holding a message handler, and for a
    // relayed session still holding a batching timer.
    this.dropLink();
    this.slot = slot;
    this.held.clear();
    this.canChooseLevel = o.canChooseLevel ?? false;
    this.transport = transport;
    this.session = new NetSession({
      // Rollback: your own character answers on the very next frame, exactly as
      // in single-player, and the peer's input is predicted and corrected.
      rollback: true,
      slot, transport, host: new GameHost(this.game, (frame) => this.onConfirmed?.(this, frame), () => this.prepareScene(), () => this.prepared),
      mayReceiveStart: (mode,num) => {
        if (this.session?.runSerial === 0 && o.initialLevel) return mode === o.initialLevel.mode && num === o.initialLevel.num;
        return !this.canChooseLevel;
      },
      onDesync: o.onDesync, onQuit: o.onQuit, onLinkDown: o.onLinkDown,
    });
    return this.session;
  }

  /**
   * Follow somebody else's game.
   *
   * The same engine, the same host, the same everything -- the only difference
   * is that the session is neither player, so it takes both of their inputs off
   * the wire and sends nothing back. Determinism is what makes that enough: the
   * simulation is a pure function of the level and the input log, and a watcher
   * has both.
   */
  observe(transport: Transport, o: JoinOptions = {}): NetSession {
    this.dropLink();
    this.held.clear();
    this.canChooseLevel = false;
    this.watching = true;
    this.transport = transport;
    this.session = new NetSession({
      slot: 0, observer: true, transport, host: new GameHost(this.game),
      onQuit: o.onQuit, onLinkDown: o.onLinkDown,
    });
    return this.session;
  }

  /**
   * Put the session down without saying anything, because there is nobody to
   * say it to.
   *
   * The counterpart to `leave`, for a link that has already gone: no Quit,
   * because it could not arrive, and no delay before closing, because there is
   * nothing left to flush. What follows is either another `join` on a rebuilt
   * link or nothing at all, and both want this first.
   */
  dropLink(): void {
    this.session = null;
    this.watching = false;
    this.transport?.close();
    this.transport = null;
    this.held.clear();
  }

  /**
   * Leave for good: tell the peer, then stop being in a session at all.
   *
   * The Quit is sent BEFORE the session is dropped, and it is the difference
   * between the other person being returned to their map and being left staring
   * at a character that will never move again. The transport goes too -- for a
   * relayed pair that only stops the batching timer, and the pair's channel
   * outlives it either way, because it is also their presence.
   */
  leave(): void {
    const going = this.session;
    if (!going) return;
    // Cleared FIRST. `depart` ends the session, and a page that reacts to that
    // by calling this again must find nothing left to do rather than recurse.
    this.session = null;
    this.watching = false;
    going.depart();
    this.held.clear();

    // Closed on a delay, and that is the whole point of the delay: the Quit
    // above has been handed to the transport but not yet put on the wire.
    // Closing here and now discards it -- SCTP drops what it has not sent when
    // the peer connection goes, and the relay's send is batched and would lose
    // the queue with the timer. The other person is then not told at all, which
    // is the exact failure this message exists to prevent. Half a second is far
    // longer than either needs and costs a departing session nothing.
    const link = this.transport;
    this.transport = null;
    setTimeout(() => link?.close(), 500);
  }

  // ---- the loop ---------------------------------------------------------

  /** One frame, in Flash's order: playheads and frame scripts, then events. */
  private step(): void {
    tickClock();
    SoundBus.frame = this.frame;
    advanceTree(this.game);
    enterFrameTree(this.game);
    this.frame++;
  }

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min((now - this.last) / 1000, 0.25);   // clamp a tab stall
    this.last = now;
    if (!this.running || !this.prepared) return;

    // Held in a local, not re-read off `this`. A command applied inside `tick`
    // can end the session -- the peer left -- and the page's reaction to being
    // told is to call `leave`, which sets `this.session` to null underneath us.
    const session = this.session;
    if (session && session.running) {
      // The session owns the clock now: it decides which frames run, predicts
      // the other player and corrects itself when the prediction was wrong.
      session.setLocalInput(this.bits());
      session.tick(dt);
      this.frame = session.frame;
    } else {
      // No level running -- either solo, or a pair sitting on the map between
      // levels. `NetSession.tick` returns immediately when it is not started,
      // so handing it the clock here would stop the world: no ENTER_FRAME, a
      // frozen map, and a level built by the next click that never advances a
      // frame. The shell is not shared state while no level is up, so each
      // side runs it on its own accumulator and a Start resynchronises them.
      this.acc += dt;
      let steps = 0;
      while (this.acc >= TIME_STEP && steps < 5) {
        this.step();
        this.acc -= TIME_STEP;
        steps++;
      }
    }

    this.showMute();

    if (this.game.m_level !== this.lastLevel) {
      this.lastLevel = this.game.m_level;
      // Ask for the whole level's art at once rather than discovering it a
      // frame at a time. Costs one burst of requests; saves the level filling
      // itself in for the first few seconds of play.
      if (this.game.m_level) this.sprites?.warm(this.game.m_level);
      this.shell.syncMap();
      this.game.The_cookie?.flush?.();
    }
    if (this.frame % 26 === 0 && this.lastSaveFrame !== this.frame) {
      this.lastSaveFrame = this.frame;
      this.game.The_cookie?.flush?.();
    }

    // Audio is a side effect of the simulation, never an input to it.
    if (this.audio) {
      this.audio.setMuted(this.muted);
      this.audio.drain();
    } else if (SoundBus.queue.length > 256) {
      // The player is still loading its manifest. Hold the queue rather than
      // discarding it: the soundtrack starts ONCE, on the intro menu, in the
      // first few frames -- throw that away and the music never plays at all.
      // The cap is only there so a failed load cannot grow the queue forever.
      SoundBus.drain();
    }

    if (document.visibilityState !== "hidden" &&
        (this.lastDrawnFrame !== this.frame || this.lastAssetRevision !== this.sprites?.revision)) {
      this.render();
      this.lastDrawnFrame = this.frame;
      this.lastAssetRevision = this.sprites?.revision ?? 0;
    }
    const state = [this.session?.running, this.session?.generation, this.session?.stalled,
      this.session?.linkDown, this.session?.desyncs, this.muted, this.canChooseLevel,
      this.game.cur_type, this.game.cur_lev].join(":");
    if (state !== this.lastState) { this.lastState = state; this.onState?.(this); }
    this.onFrame?.(this);
  };

  /**
   * Draw the game's own mute button in the state this player is actually in.
   *
   * `Game.Muted` and the icon's `visible` are hung off the Game, so the
   * snapshot walk reaches them and a rollback puts them back -- which is why
   * pressing the in-canvas mute button used to silence the audio and then flip
   * its own picture back within a frame.
   *
   * Re-asserting them every frame is safe for one specific reason: `hash()`
   * covers `m_level` and nothing above it, so two peers can disagree about
   * whether they are muted without disagreeing about the game. Mute is one
   * player's preference. It should differ.
   */
  private showMute(): void {
    const muter = this.game.m_muter;
    if (!muter) return;
    this.game.Muted = this.muted;
    if (muter.muteLines) muter.muteLines.visible = !this.muted;
  }

  render(): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    if (this.sprites) this.sprites.draw(ctx, this.game);
  }

  /** The level currently on screen, or null -- `m_level` outlives its level. */
  get level(): any {
    const lv = this.game.m_level;
    return lv && lv.parent ? lv : null;
  }

  /** How far the simulation has got. */
  get simFrame(): number { return this.frame; }

  /**
   * A digest of the shared simulation state, or null outside a level.
   *
   * The only way to ask "are these two people playing the same game?" and get
   * an answer that is not a guess, which makes it the assertion every netplay
   * test is built on.
   */
  digest(): string | null {
    const lv = this.level;
    return lv ? hashLevel(lv) : null;
  }

  setMuted(muted: boolean): void { this.muted = muted; }
  /** This player's mute, which the game's own button now also drives. */
  get isMuted(): boolean { return this.muted; }
  setRunning(on: boolean): void { this.running = on; }

  /**
   * Whether this view has been torn down.
   *
   * Read by the asset loaders above, which resolve on their own schedule and
   * used to attach to a view that no longer had a canvas.
   */
  private destroyed = false;

  /**
   * Put the view down: the loop, the listeners, the audio, and the save.
   *
   * Idempotent, because a page can reach this by more than one route -- a
   * navigation and a `pagehide` in the same instant -- and closing an
   * AudioContext twice is an exception rather than a no-op.
   *
   * The audio used to be MUTED here and nothing else, which is why the comment
   * in `screens/play.ts` claiming this releases the audio context was wrong:
   * every play or watch screen left a live context, its sources still
   * connected, behind it. Browsers cap those in the low tens.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const off of this.listeners) off();
    this.listeners = [];
    this.game.The_cookie?.flush?.();
    this.audio?.dispose();
    this.audio = null;
    this.sprites = null;
  }
}
