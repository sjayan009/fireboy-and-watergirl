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
import { Game, tickClock, resetClock } from "./game/game.js";
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
  /** Called after every rendered frame, for whatever the page shows around it. */
  onFrame?: (view: GameView) => void;
}

export class GameView {
  readonly game: any;
  readonly shell: ShellInput;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly onFrame?: (v: GameView) => void;

  sprites: SpriteRenderer | null = null;
  audio: AudioPlayer | null = null;

  /** The netplay session, once two peers have paired. Null when solo. */
  session: NetSession | null = null;
  slot: Slot = 0;

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

    resetClock();
    this.game = new (Game as any)();
    this.shell = new ShellInput(this.game, this.game.stage);

    const base = o.assets ?? "/extracted/assets";
    // Art and audio arrive whenever they arrive. The game is playable before
    // either does -- the renderer draws nothing it has not got, and the sound
    // bus holds its queue -- so neither is awaited.
    SpriteRenderer.load(base).then((r) => { this.sprites = r; })
      .catch((e) => console.warn("sprite art unavailable:", e));
    AudioPlayer.load(base).then((a) => { this.audio = a; })
      .catch((e) => console.warn("audio unavailable:", e));

    this.bind();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
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
    on(window, "pagehide", () => { this.game.The_cookie?.flush?.(); });

    on(this.canvas, "pointermove", (e) => {
      const over = this.shell.pointerMove(this.pick(e as PointerEvent));
      this.canvas.style.cursor = over ? "pointer" : "default";
    });
    on(this.canvas, "pointerdown", (e) => {
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

  private keyDown(e: KeyboardEvent): void {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(e.key)) {
      e.preventDefault();
    }
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (this.session) {
      // In a session the level's input belongs to the netcode, not to
      // Game.keyPressed: writing it locally would apply this player's move
      // without the other peer ever hearing about it.
      if (MOVEMENT.includes(key)) { this.held.add(key); return; }
      if (key === "p") { this.session.send(Command.Pause); return; }
      if (key === "r") { this.session.send(Command.Retry); return; }
      if (key === "Escape") { this.session.send(Command.Quit); return; }
    }

    const code = GameView.codeOf(e);
    if (this.shell.keyDown(code, key)) return;
    this.shell.forwardDown(code);
  }

  private keyUp(e: KeyboardEvent): void {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (this.session && MOVEMENT.includes(key)) { this.held.delete(key); return; }
    this.shell.forwardUp(GameView.codeOf(e));
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
  join(transport: Transport, slot: Slot,
       onDesync?: (f: number, a: string, b: string) => void): NetSession {
    this.slot = slot;
    this.held.clear();
    this.session = new NetSession({
      // Rollback: your own character answers on the very next frame, exactly as
      // in single-player, and the peer's input is predicted and corrected.
      rollback: true,
      slot, transport, host: new GameHost(this.game), onDesync,
    });
    return this.session;
  }

  leave(): void {
    if (!this.session) return;
    this.session.send(Command.Quit);
    this.session = null;
    this.held.clear();
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
    if (!this.running) return;

    if (this.session) {
      // The session owns the clock now: it decides which frames run, predicts
      // the other player and corrects itself when the prediction was wrong.
      this.session.setLocalInput(this.bits());
      this.session.tick(dt);
      this.frame = this.session.frame;
    } else {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= TIME_STEP && steps < 5) {
        this.step();
        this.acc -= TIME_STEP;
        steps++;
      }
    }

    if (this.game.m_level !== this.lastLevel) {
      this.lastLevel = this.game.m_level;
      // Ask for the whole level's art at once rather than discovering it a
      // frame at a time. Costs one burst of requests; saves the level filling
      // itself in for the first few seconds of play.
      if (this.game.m_level) this.sprites?.warm(this.game.m_level);
      this.shell.syncMap();
      this.game.The_cookie?.flush?.();
    }
    if (this.frame % 26 === 0) this.game.The_cookie?.flush?.();

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

    this.render();
    this.onFrame?.(this);
  };

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
  setRunning(on: boolean): void { this.running = on; }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    for (const off of this.listeners) off();
    this.listeners = [];
    this.game.The_cookie?.flush?.();
    this.audio?.setMuted(true);
  }
}
