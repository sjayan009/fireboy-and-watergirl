/**
 * A minimal, deterministic reimplementation of the slice of the Flash display
 * API that the game actually uses.
 *
 * This is NOT a rendering layer. It is part of the simulation, because
 * level.as reads display state back as game state:
 *
 *   - the exit doors' `currentFrame` gates level completion (`< 22`, `== 22`)
 *   - levers and wind machines address a child named "light"
 *   - the characters address children `mc_1`..`mc_5` and `mc_4.head`
 *   - `userData` on a Box2D body *is* the MovieClip, and bodies are found
 *     again through `getChildByName`
 *
 * So the scene graph has to have the same frame counts, the same named
 * children, and the same frame-advance behaviour as the original, or that
 * logic quietly breaks. Frame counts and child names come straight out of the
 * SWF (see tools/extract_symbols.py).
 *
 * Rendering reads this tree; it never writes to it.
 */

export class Event {
  static readonly ENTER_FRAME = "enterFrame";
  static readonly COMPLETE = "complete";
  static readonly CHANGE = "change";
  /**
   * Set by dispatchEvent. Recuento.Ease and GameOvero.Ease animate
   * `param1.target.y` -- the board slides in off the event's target, not off
   * `this` -- so a dispatch that leaves this null silently does nothing.
   */
  target: any = null;
  currentTarget: any = null;
  constructor(public type: string) {}
}

/**
 * Mouse events, for the handler signatures throughout Game.as.
 *
 * Buttons are not wired up: menus are driven from the keyboard, and the
 * dispatcher hands each ported handler one of these carrying the `target`
 * whose `name`, `x` and `y` it reads (StartGameBtn parses the level out of
 * "b_1_13"; Glowin positions the firefly cursor from the button's
 * coordinates). Keeping the real event shape is what lets those handlers stay
 * verbatim, and what will let real buttons become just another event source.
 */
export class MouseEvent extends Event {
  static readonly CLICK = "click";
  static readonly MOUSE_DOWN = "mouseDown";
  static readonly MOUSE_UP = "mouseUp";
  static readonly MOUSE_OVER = "mouseOver";
  static readonly MOUSE_OUT = "mouseOut";
  static readonly ROLL_OVER = "rollOver";
  static readonly ROLL_OUT = "rollOut";
  constructor(type: string, target?: any) {
    super(type);
    if (target !== undefined) { this.target = target; this.currentTarget = target; }
  }
}

/** The Flash right-click menu. Suppressed by the original; a stub here. */
export class ContextMenu {
  hideBuiltInItems(): void {}
}



export class Filter {}
export class GlowFilter extends Filter {
  constructor(public color = 0xFF0000, public alpha = 1, public blurX = 6,
              public blurY = 6, public strength = 2, public quality = 1,
              public inner = false, public knockout = false) { super(); }
}
export class DropShadowFilter extends Filter {
  constructor(public distance = 4, public angle = 45, public color = 0,
              public alpha = 1, public blurX = 4, public blurY = 4,
              public strength = 1, public quality = 1, public inner = false,
              public knockout = false, public hideObject = false) { super(); }
}
export class Matrix {
  constructor(public a = 1, public b = 0, public c = 0, public d = 1,
              public tx = 0, public ty = 0) {}
}
export class BitmapData {
  /**
   * CreateGround rasterises the assembled terrain into a BitmapData and adds
   * only the resulting Bitmap to the stage -- GroundMC itself never gets a
   * parent. That was a Flash performance trick; we cannot rasterise here, so
   * we remember what was drawn and let the renderer walk the source tree
   * instead. Visually equivalent, and it keeps the ported code untouched.
   */
  source: any = null;
  sourceMatrix: Matrix | null = null;

  constructor(public width: number, public height: number,
              public transparent = true, public fillColor = 0xFFFFFFFF) {}

  draw(src: any, m?: Matrix): void {
    this.source = src;
    this.sourceMatrix = m ?? null;
  }

  dispose(): void {
    this.source = null;
    this.sourceMatrix = null;
  }
}

export class DisplayObject {
  [key: string]: any;          // AS3 symbol classes are `dynamic`

  name = "";
  x = 0;
  y = 0;
  scaleX = 1;
  scaleY = 1;
  rotation = 0;
  alpha = 1;
  visible = true;
  filters: Filter[] = [];
  cacheAsBitmap = false;
  parent: DisplayObjectContainer | null = null;

  /** Symbol name from the SWF library; the renderer draws by this. */
  readonly symbol: string;

  /**
   * True while this object is serving as someone else's mask. Flash never
   * paints a mask directly -- it only clips. CreateGround puts GroundMask
   * inside GroundMC, so drawing it would paint over all 378 terrain tiles.
   */
  isMask = false;

  private _mask: DisplayObject | null = null;
  get mask(): DisplayObject | null { return this._mask; }
  set mask(m: DisplayObject | null) {
    if (this._mask) this._mask.isMask = false;
    this._mask = m;
    if (m) m.isMask = true;
  }

  constructor(symbol = "") {
    this.symbol = symbol;
  }

  /**
   * Game.as registers its keyboard listeners on `stage` and sets
   * `stage.focus`. There is exactly one stage, so hand out the singleton
   * rather than modelling stage membership, which nothing here reads.
   */
  get stage(): Stage { return theStage; }

  /**
   * Only reached by GameReady's portal sniff
   * (`loaderInfo.loaderURL.indexOf("kongregate.com")`), which moves the game
   * off-screen on two 2009 portals. Returning an empty URL keeps that code
   * literal and makes the condition false, which is the behaviour we want.
   */
  get loaderInfo(): { loaderURL: string; bytesLoaded: number;
                      bytesTotal: number } {
    return { loaderURL: "", bytesLoaded: 1, bytesTotal: 1 };
  }

  /**
   * Flash dispatches ENTER_FRAME itself; here the game loop drives it, so
   * listeners are just recorded and invoked explicitly. AS3 method references
   * are bound, so dispatch calls them with the target as `this`.
   */
  private listeners: Map<string, Function[]> = new Map();

  /**
   * AS3 method references are BOUND: `Rboard.addEventListener(ENTER_FRAME,
   * Ease)` inside Recuento passes a closure that still sees Recuento as
   * `this`, even though the listener lives on Rboard. Plain JS would call it
   * with Rboard as `this` and Ease would animate nothing.
   *
   * gen_game.py wraps every method reference passed to add/removeEventListener
   * in a call to this. It memoises, because removeEventListener matches by
   * identity -- RetryGame and EndGame both tear listeners back down, and a
   * fresh bind each time would leave them attached forever.
   */
  private __bound: Map<Function, Function> | null = null;

  __bind(fn: Function): Function {
    if (typeof fn !== "function") return fn;
    if (!this.__bound) this.__bound = new Map();
    let b = this.__bound.get(fn);
    if (!b) {
      b = fn.bind(this);
      this.__bound.set(fn, b);
    }
    return b;
  }

  addEventListener(type: string, fn: Function, _capture = false,
                   _priority = 0, _weak = false): void {
    const list = this.listeners.get(type);
    if (list) {
      if (!list.includes(fn)) list.push(fn);
    } else {
      this.listeners.set(type, [fn]);
    }
  }

  removeEventListener(type: string, fn: Function, _capture = false): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  hasEventListener(type: string): boolean {
    return (this.listeners.get(type) ?? []).length > 0;
  }

  dispatchEvent(event: Event): boolean {
    const list = this.listeners.get(event.type);
    if (!list || list.length === 0) return true;
    if (event.target == null) event.target = this;
    event.currentTarget = this;
    for (const fn of list.slice()) fn.call(this, event);
    return true;
  }

  /**
   * Only ever used to fade the tutorial overlay, never to gate gameplay.
   * Real vector hit-testing is a rendering concern we do not reproduce.
   */
  hitTestPoint(_x: number, _y: number, _shapeFlag = false): boolean {
    return true;
  }
}

export class DisplayObjectContainer extends DisplayObject {
  readonly children: DisplayObject[] = [];

  addChild<T extends DisplayObject>(child: T): T {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  addChildAt<T extends DisplayObject>(child: T, index: number): T {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild<T extends DisplayObject>(child: T): T {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
      child.parent = null;
    }
    return child;
  }

  removeChildAt(index: number): DisplayObject | null {
    const c = this.children[index];
    if (c) {
      this.children.splice(index, 1);
      c.parent = null;
    }
    return c ?? null;
  }

  getChildAt(index: number): DisplayObject | null {
    return this.children[index] ?? null;
  }

  /** AS3 returns null when there is no match; callers compare against null. */
  getChildByName(name: string): DisplayObject | null {
    for (const c of this.children) if (c.name === name) return c;
    return null;
  }

  swapChildren(a: DisplayObject, b: DisplayObject): void {
    const i = this.children.indexOf(a);
    const j = this.children.indexOf(b);
    if (i >= 0 && j >= 0) {
      this.children[i] = b;
      this.children[j] = a;
    }
  }

  contains(child: DisplayObject): boolean {
    if (child === this) return true;
    for (const c of this.children) {
      if (c === child) return true;
      if (c instanceof DisplayObjectContainer && c.contains(child)) return true;
    }
    return false;
  }

  get numChildren(): number { return this.children.length; }
}

export class Bitmap extends DisplayObject {
  constructor(public bitmapData: BitmapData | null = null,
              public pixelSnapping = "auto", public smoothing = false) {
    super("");
  }
}

/**
 * flash.text.TextField, for the 35 DefineEditText fields the game writes to:
 * the timer, the diamond counters, the results time, the per-level best times
 * on the menu map.
 *
 * The 56 static DefineText characters need nothing -- JPEXS bakes those into
 * the sprite art as glyph outlines, and they are already on screen.
 *
 * This is display state and it must stay out of hashLevel(): text is derived
 * from the simulation, never an input to it, and measuring a string depends on
 * the font the browser actually loaded.
 */
export class TextField extends DisplayObject {
  text = "";
  textColor = 0xffcc00;
  /** Point size, and the SWF font character id the renderer maps to a face. */
  size = 12;
  fontId = 0;
  align: "left" | "right" | "center" | "justify" = "left";
  /** The DefineEditText bounding box, in the field's own coordinates. */
  bounds = { x: 0, y: 0, w: 0, h: 0 };
  multiline = false;
  autoSize: string = "none";
  selectable = true;
  mouseEnabled = true;

  get textWidth(): number { return this.bounds.w; }
  get textHeight(): number { return this.bounds.h; }

  /** TextField is a leaf; setSelection exists only so ported code compiles. */
  setSelection(_a: number, _b: number): void {}
}

export const TextFieldAutoSize = {
  NONE: "none", LEFT: "left", RIGHT: "right", CENTER: "center",
};

export class Sprite extends DisplayObjectContainer {}

export class MovieClip extends Sprite {
  /** 1-based, exactly like Flash. */
  currentFrame = 1;
  totalFrames = 1;
  /**
   * Flash plays a placed clip automatically -- a multi-frame symbol animates
   * unless something stops it. What stops it is the SWF frame script:
   * `addFrameScript(0, frame1)` where `frame1()` calls `stop()`. Those frames
   * are recorded in `stopFrames` (see gen_symbols.py) and applied whenever the
   * playhead enters one, which is exactly when Flash would run the script.
   */
  playing = false;
  stopFrames: Set<number> | null = null;
  /**
   * Frame scripts that do more than stop(). Only three clips in the whole SWF
   * need one, and two of them are load-bearing: deadFire's frame 32 calls
   * Game.GameOver() and WaterGirlStairs' frame 35 calls Game.Recuent(). They
   * are the ONLY triggers for the death and results screens, so without this
   * the shell can be fully built and still never appear.
   */
  private frameScripts: Map<number, () => void> | null = null;

  constructor(symbol = "", totalFrames = 1, stopFrames?: number[] | null) {
    super(symbol);
    this.totalFrames = Math.max(1, totalFrames);
    if (stopFrames && stopFrames.length) this.stopFrames = new Set(stopFrames);
    this.playing = this.totalFrames > 1;
    this.runFrameScript();
  }

  /**
   * Register a frame script, matching AS3's `addFrameScript(index, fn)` --
   * note the index is 0-based there and frames are 1-based here.
   *
   * Flash runs a frame's script when the playhead enters that frame. A clip is
   * constructed already sitting on frame 1, and a subclass can only register
   * after super() has returned, so registering for the current frame runs it
   * straight away. That is what Flash does when the clip is placed.
   */
  addFrameScript(index: number, fn: () => void): void {
    const frame = Math.floor(index) + 1;
    if (!this.frameScripts) this.frameScripts = new Map();
    this.frameScripts.set(frame, fn);
    if (frame === this.currentFrame) fn.call(this);
  }

  /** Flash runs a frame's script on entering it. */
  private runFrameScript(): void {
    if (this.stopFrames && this.stopFrames.has(this.currentFrame)) {
      this.playing = false;
    }
    const fn = this.frameScripts && this.frameScripts.get(this.currentFrame);
    if (fn) fn.call(this);
  }

  gotoAndStop(frame: number | string): void {
    const to = this.clampFrame(frame);
    const moved = to !== this.currentFrame;
    this.currentFrame = to;
    this.playing = false;
    // Only on entering a *different* frame: Flash does not re-run a script
    // for a gotoAndStop onto the frame the playhead already occupies.
    if (moved) this.runFrameScript();
  }

  gotoAndPlay(frame: number | string): void {
    this.currentFrame = this.clampFrame(frame);
    this.playing = true;
    this.runFrameScript();
  }

  play(): void { this.playing = true; }
  stop(): void { this.playing = false; }
  nextFrame(): void { this.gotoAndStop(this.currentFrame + 1); }
  prevFrame(): void { this.gotoAndStop(this.currentFrame - 1); }

  private clampFrame(frame: number | string): number {
    const f = typeof frame === "number" ? Math.floor(frame) : 1;
    if (!Number.isFinite(f) || f < 1) return 1;
    return f > this.totalFrames ? this.totalFrames : f;
  }

  /**
   * One stage tick. Flash advances playing clips automatically at the stage
   * frame rate; the game loop drives this explicitly so animation state stays
   * part of the deterministic simulation.
   */
  advance(): void {
    if (this.playing && this.totalFrames > 1) {
      this.currentFrame = this.currentFrame >= this.totalFrames
        ? 1
        : this.currentFrame + 1;
      this.runFrameScript();
    }
  }
}

/**
 * flash.display.Stage, only as much of it as Game.as touches: it registers the
 * keyboard listeners here and sets `stage.focus`. One instance for the whole
 * display list, because there is one stage.
 */
export class Stage extends DisplayObjectContainer {
  focus: any = null;
  frameRate = 26;
  quality = "high";
}

const theStage = new Stage();

/**
 * Broadcast ENTER_FRAME depth-first over the display list.
 *
 * Flash fires this on every object every frame, and the shell leans on it
 * heavily: PauseMenu.Update slides the tray and ducks the music, Recuento.Ease
 * eases the results board in, Game.TimerUpdate advances the clock,
 * Game.FliesMove chases the firefly cursor. The level's own Update is still
 * called directly by the host, exactly as before.
 *
 * Children are snapshotted because handlers add and remove them mid-frame --
 * Transit removes the menu and starts a level from inside its own listener.
 */
export function enterFrameTree(root: DisplayObject): void {
  const ev = new Event(Event.ENTER_FRAME);
  const visit = (node: DisplayObject): void => {
    ev.target = node;
    ev.currentTarget = node;
    node.dispatchEvent(ev);
    if (node instanceof DisplayObjectContainer) {
      for (const c of node.children.slice()) visit(c);
    }
  };
  visit(root);
}

/**
 * Advance every MovieClip under `root`, including `root` itself.
 *
 * The walk descends through *any* container, not only MovieClips. That matters
 * now that the root is Game: `level` is a plain Sprite, so a MovieClip-only
 * recursion stopped dead at it and nothing inside a level ever animated --
 * doors frozen shut, and deadFire stuck on frame 1 so the game-over screen
 * never arrived.
 *
 * Children are snapshotted because a frame script can change the display list
 * while the walk is running: deadFire's frame 32 calls Game.GameOver(), which
 * adds the results board.
 */
export function advanceTree(root: DisplayObject): void {
  if (root instanceof MovieClip) root.advance();
  if (root instanceof DisplayObjectContainer) {
    for (const c of root.children.slice()) advanceTree(c);
  }
}

// --- sound ---------------------------------------------------------------
// Playback is a side effect, deliberately kept out of the simulation: the
// engine records what should be heard and the host plays it. Keeping audio out
// of the deterministic path means a muted peer cannot desync a loud one.

export interface SoundEvent {
  kind: "play";
  symbol: string;
  loops: number;
  frame: number;
}

/** flash.media.SoundTransform -- only `volume` is ever set by this game. */
export class SoundTransform {
  constructor(public volume = 1, public pan = 0) {}
}

/**
 * Master volume, the game's mute button.
 *
 * Routed through SoundBus rather than straight at Web Audio, for the same
 * reason every other sound is: audio must be a side effect of the simulation
 * and never an input to it, or a muted peer and a loud one would drift apart.
 */
export const SoundMixer = {
  _transform: new SoundTransform(1),
  get soundTransform(): SoundTransform { return this._transform; },
  set soundTransform(t: SoundTransform) {
    this._transform = t;
    SoundBus.volume("", t ? t.volume : 1);
  },
};

export class SoundChannel {
  stopped = false;
  /** Which symbol this channel is playing, so volume changes can find it. */
  symbol = "";
  stop(): void { this.stopped = true; SoundBus.stopChannel(this.symbol); }

  private _transform = new SoundTransform(1);
  get soundTransform(): SoundTransform { return this._transform; }
  /** PauseMenu ducks the music to 0.2 through here while the tray is open. */
  set soundTransform(t: SoundTransform) {
    this._transform = t;
    SoundBus.volume(this.symbol, t ? t.volume : 1);
  }
}

export class Sound {
  constructor(public readonly symbol = "") {}
  play(_offset = 0, loops = 0, _transform?: any): SoundChannel {
    SoundBus.emit(this.symbol, loops);
    // The channel remembers what it is playing so a later volume change or
    // stop -- PauseMenu ducking the music, EndGame killing it -- can name it.
    const ch = new SoundChannel();
    ch.symbol = this.symbol;
    return ch;
  }
}

/**
 * A volume change or an explicit stop.
 *
 * An empty `symbol` means the master mix (SoundMixer); otherwise it is the
 * sound whose channel is being adjusted -- PauseMenu ducking the soundtrack to
 * 0.2, or EndGame stopping it.
 */
export interface SoundControl {
  kind: "volume" | "stop";
  symbol: string;
  volume: number;
  frame: number;
}

export type SoundItem = SoundEvent | SoundControl;

/**
 * One ORDERED queue for everything audible.
 *
 * Plays and volume/stop commands share a queue on purpose. Keeping them apart
 * and applying all commands before all plays reorders them whenever more than
 * one frame is drained at once -- which is exactly what happens after a tab
 * stall. The symptom is specific and confusing: finishing a level queues
 * "stop Adv_Sound" and then "play Menu_Sound", and processing the stop first
 * leaves the in-game soundtrack running underneath the menu music.
 */
export const SoundBus = {
  queue: [] as SoundItem[],
  frame: 0,
  /**
   * Set while re-simulating a frame that has already been played once.
   *
   * Rollback netplay runs recent frames again with corrected input. The physics
   * must come out identical, but the audio must not happen twice -- and this is
   * the only place in the engine where a simulation step escapes into the world,
   * so it is the only place that has to know. Without it a correction sounds
   * like a machine gun.
   */
  replaying: false,
  emit(symbol: string, loops: number): void {
    if (this.replaying) return;
    this.queue.push({ kind: "play", symbol, loops, frame: this.frame });
  },
  volume(symbol: string, volume: number): void {
    if (this.replaying) return;
    this.queue.push({ kind: "volume", symbol, volume, frame: this.frame });
  },
  stopChannel(symbol: string): void {
    if (this.replaying) return;
    this.queue.push({ kind: "stop", symbol, volume: 0, frame: this.frame });
  },
  /** Hand the pending sounds to the host, in order, and clear the queue. */
  drain(): SoundItem[] {
    const q = this.queue;
    this.queue = [];
    return q;
  },
};

// --- events --------------------------------------------------------------

export class KeyboardEvent extends Event {
  static readonly KEY_DOWN = "keyDown";
  static readonly KEY_UP = "keyUp";
  keyCode = 0;
  constructor(type: string, keyCode = 0) { super(type); this.keyCode = keyCode; }
}

export const Keyboard = {
  LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, SPACE: 32, ENTER: 13, ESCAPE: 27,
  A: 65, D: 68, W: 87, S: 83, P: 80, M: 77, R: 82,
};
