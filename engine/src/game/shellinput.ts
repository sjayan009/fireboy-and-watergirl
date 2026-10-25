/**
 * Menu input: mouse and keyboard, both ending in the same place.
 *
 * Neither path calls a handler directly. Each decides which button is meant --
 * the mouse by hit-testing the display list, the keyboard by walking a
 * selection -- and then dispatches a real MouseEvent at that clip, so every
 * listener Game.as registered fires exactly as it would have on a click and
 * not one line of the ported shell knows the difference.
 *
 * Two consequences worth stating:
 *
 *  * StartGameBtn parses the level out of e.target.name ("b_1_13" ->
 *    adventure 13) and Glowin positions the firefly cursor from e.target.x/y.
 *    Dispatching at the real clip gets both for free, so the firefly chases
 *    the pointer exactly as it did in 2009 -- and chases the keyboard
 *    selection too, which the original never had.
 *  * In-game input needs no special case at all: Game.as registers
 *    keyPressed/keyReleased on the stage, so the host forwards key events
 *    there and the original handler does the rest, P for pause included.
 *
 * The two stay in step: picking a node with the mouse moves the keyboard
 * cursor to it, so arrow keys carry on from wherever the pointer left off.
 *
 * ## The intent hook
 *
 * Every button on this screen is one of two kinds, and dispatching them the
 * same way is a bug in a netplay session.
 *
 * Retry, quit, pause and picking a level all change state BOTH peers simulate.
 * The whole `Game` is inside the rollback snapshot, so applying one of them
 * here -- locally, the moment the mouse comes up -- is either erased by the
 * next correction restoring the snapshot the click was supposed to change, or
 * kept and never told to the other machine. Both outcomes look to a player like
 * a button that does nothing.
 *
 * So a caller may install `onIntent`, and the shell asks it before dispatching
 * anything. A session answers "handled" and sends a command instead, to be
 * applied on a frame both peers agree on. With no hook installed -- solo, and
 * every engine test -- not one dispatch changes.
 */
import {
  DisplayObject, KeyboardEvent, MouseEvent, Keyboard, Stage,
} from "../flash/flash.js";
import { MODES } from "../net/session.js";
import type { Ported } from "../ported.js";

/** Which of the 32 map nodes is highlighted, 1-based like Game.cur_node. */
const FIRST_NODE = 1;

/**
 * Which art a button draws. The renderer reads it; nothing else does, and it
 * never reaches the simulation.
 *
 * Set on the clip rather than tracked here because the same button can be
 * reached from the mouse and from the keyboard, and both should light it the
 * same way. That is a small liberty: the original only ever highlighted under
 * the pointer, because it had no keyboard navigation to highlight for.
 */
function setState(target: Ported, state: "up" | "over" | "down"): void {
  if (target) target.__btnState = state;
}

function dispatch(target: Ported): void {
  if (!target) return;
  target.dispatchEvent(new MouseEvent(MouseEvent.CLICK, target));
  // Several screens listen for MOUSE_DOWN rather than CLICK -- the pause
  // tray's retry and end-game buttons, the results board's back button.
  target.dispatchEvent(new MouseEvent(MouseEvent.MOUSE_DOWN, target));
}

/**
 * What a button MEANS, as opposed to which clip it is.
 *
 * Only the buttons that change shared state are named here. Everything else --
 * the intro menu, the instructions, the credits, the map's navigation -- is
 * this player looking around their own copy of the shell, and travels nowhere.
 */
export type Intent =
  | { kind: "retry" }
  | { kind: "quit" }
  | { kind: "pause" }
  | { kind: "mute" }
  | { kind: "start"; mode: string; num: number }
  // The title screen's Play, which the page may answer with its own choice of
  // how to play before the map. Not shared state; it is asked all the same.
  | { kind: "play" };

function roll(target: Ported, over: boolean): void {
  if (!target) return;
  setState(target, over ? "over" : "up");
  const type = over ? MouseEvent.ROLL_OVER : MouseEvent.ROLL_OUT;
  target.dispatchEvent(new MouseEvent(type, target));
  if (over) target.dispatchEvent(new MouseEvent(MouseEvent.MOUSE_OVER, target));
}

export class ShellInput {
  /** Index into the intro menu's three live buttons. */
  private introSel = 0;
  /** 1-based map node, matching Game.cur_node. */
  private nodeSel = FIRST_NODE;
  /** 0 = retry, 1 = end game, within the pause tray. */
  private traySel = 0;

  private readonly introButtons = ["Starter", "Instructer", "Crediter"];

  constructor(private game: Ported, private stage: Stage) {}

  // ---- intents ----------------------------------------------------------

  private intentHandler: ((i: Intent) => boolean) | null = null;

  /**
   * Be asked before any button is dispatched.
   *
   * Return true to swallow the click -- the caller has taken responsibility for
   * making it happen, which for a session means scheduling a command on a frame
   * both peers agree on. Return false and the ported handler runs exactly as it
   * always has.
   */
  onIntent(fn: (i: Intent) => boolean): () => void {
    this.intentHandler = fn;
    return () => { if (this.intentHandler === fn) this.intentHandler = null; };
  }

  /** Run a button's own handler without asking anybody what it means. */
  activate(target: Ported): void { dispatch(target); }

  /** Ask about the button, then dispatch it if nobody claimed it. */
  private click(target: Ported): void {
    if (!target) return;
    if (this.intentHandler) {
      const intent = this.intentFor(target);
      if (intent && this.intentHandler(intent)) return;
    }
    dispatch(target);
  }

  /**
   * Which of the shared-state buttons this clip is, if it is one.
   *
   * Compared by IDENTITY against the clips the ported code built, not by name.
   * Names in this shell are not unique -- every map node is a `b_*`, and the
   * boards reuse `RetryBtn` and `ToMenuBtn` between them -- so identity is the
   * only test that cannot quietly match the wrong thing after a rebuild.
   */
  private intentFor(target: Ported): Intent | null {
    const g = this.game as Ported;

    if (g.m_muter && target === g.m_muter.muteBtn) return { kind: "mute" };
    if (this.has(g.m_introMenu) && target === g.m_introMenu.Buttons?.Starter) return { kind: "play" };

    if (g.m_pauseMenu) {
      if (target === g.m_pauseMenu.btn) return { kind: "pause" };
      if (target === g.m_pauseMenu.retryBtn) return { kind: "retry" };
      if (target === g.m_pauseMenu.endGameBtn) return { kind: "quit" };
    }

    const board: Ported = this.overlay();
    const inner = board && (board.GOboard || board.Rboard);
    if (inner) {
      if (target === inner.RetryBtn) return { kind: "retry" };
      if (target === inner.ToMenuBtn) return { kind: "quit" };
    }

    // A map node. `Translation` holds "1_13" -- type then level -- and the type
    // digit is the same one `StartGame` switches on.
    if (g.m_mainMenu && this.has(g.m_mainMenu)) {
      const name: string = (target && target.name) || "";
      if (name.startsWith("b_") && g.m_mainMenu[name] === target) {
        const parts = name.slice(2).split("_");
        const mode = MODES[Number(parts[0]) - 1];
        const num = Number(parts[1]);
        if (mode && num > 0) return { kind: "start", mode, num };
      }
    }
    return null;
  }

  // ---- what is on screen ------------------------------------------------

  private has(node: DisplayObject | null | undefined): boolean {
    return !!node && node.parent === this.game;
  }

  private overlay(): Ported {
    // Boards are added last, so they sit on top and own the keyboard.
    for (const c of [...(this.game as Ported).children].reverse()) {
      if ((c as Ported).GOboard || (c as Ported).Rboard) return c;
    }
    return null;
  }

  private screen(): string {
    if (this.has((this.game as Ported).instr)) return "instructions";
    if (this.has((this.game as Ported).crd)) return "credits";
    if (this.overlay()) return "board";
    if (this.has((this.game as Ported).m_mainMenu)) return "map";
    if (this.has((this.game as Ported).m_introMenu)) return "intro";
    if (this.has((this.game as Ported).m_level)) return "game";
    return "none";
  }

  /** The clip for a map node: node 15 is the button named "b_1_13". */
  private nodeButton(node: number): Ported {
    const g = this.game as Ported;
    const name = g.Translation && g.Translation[node - 1];
    return name && g.m_mainMenu ? g.m_mainMenu["b_" + name] : null;
  }

  private unlocked(node: number): boolean {
    const g = this.game as Ported;
    const stats = g.The_cookie && g.The_cookie.data && g.The_cookie.data.stats;
    return !!stats && stats[node - 1] >= 0;
  }

  // ---- map navigation ---------------------------------------------------

  /**
   * Step to the neighbour that best matches an arrow key.
   *
   * Candidates are the node's neighbours in Adjacencies -- the same graph the
   * game uses to decide what finishing a level unlocks -- so navigation
   * follows the drawn paths instead of jumping across the map. Among those,
   * take the one whose direction agrees most with the key, damped by distance
   * so a near neighbour beats a far one pointing the same way.
   */
  private step(dx: number, dy: number): void {
    const g = this.game as Ported;
    const adj = g.Adjacencies;
    if (!adj) return;
    const from = this.nodeButton(this.nodeSel);
    if (!from) return;

    let best = -1;
    let bestScore = 0;
    for (let j = 0; j < 32; j++) {
      if (j === this.nodeSel - 1 || adj[this.nodeSel - 1][j] !== 1) continue;
      if (!this.unlocked(j + 1)) continue;
      const to = this.nodeButton(j + 1);
      if (!to) continue;
      const vx = to.x - from.x;
      const vy = to.y - from.y;
      const len = Math.hypot(vx, vy) || 1;
      const score = (vx * dx + vy * dy) / len / Math.sqrt(len);
      if (score > bestScore) { bestScore = score; best = j + 1; }
    }
    if (best > 0) this.select(best);
  }

  private select(node: number): void {
    if (node === this.nodeSel) return;
    roll(this.nodeButton(this.nodeSel), false);
    this.nodeSel = node;
    roll(this.nodeButton(this.nodeSel), true);
  }

  /** Re-highlight after the map is rebuilt, e.g. on returning from a level. */
  syncMap(): void {
    const g = this.game as Ported;
    if (!this.has(g.m_mainMenu)) return;
    if (!this.unlocked(this.nodeSel)) this.nodeSel = FIRST_NODE;
    roll(this.nodeButton(this.nodeSel), true);
  }

  // ---- key handling -----------------------------------------------------

  /** Returns true if the shell consumed the key. */
  keyDown(code: number, key: string): boolean {
    const g = this.game as Ported;

    // The mute button is reachable wherever it exists.
    if (key === "m" && this.has(g.m_muter)) {
      this.click(g.m_muter.muteBtn);
      return true;
    }

    switch (this.screen()) {
      case "intro":
        return this.introKey(code);
      case "map":
        return this.mapKey(code);
      case "instructions":
        if (code === Keyboard.ENTER || code === Keyboard.ESCAPE) {
          this.click(g.instr.OKO);
          return true;
        }
        return false;
      case "credits":
        if (code === Keyboard.ENTER || code === Keyboard.ESCAPE) {
          this.click(g.crd.OKO);
          return true;
        }
        return false;
      case "board":
        return this.boardKey(code, key);
      case "game":
        return this.gameKey(code, key);
    }
    return false;
  }

  private introKey(code: number): boolean {
    const buttons = (this.game as Ported).m_introMenu.Buttons;
    if (code === Keyboard.UP || code === Keyboard.DOWN) {
      const d = code === Keyboard.UP ? -1 : 1;
      const n = this.introButtons.length;
      this.introSel = (this.introSel + d + n) % n;
      return true;
    }
    if (code === Keyboard.ENTER || code === Keyboard.SPACE) {
      this.click(buttons[this.introButtons[this.introSel]]);
      return true;
    }
    return false;
  }

  private mapKey(code: number): boolean {
    const g = this.game as Ported;
    switch (code) {
      case Keyboard.LEFT:  this.step(-1, 0); return true;
      case Keyboard.RIGHT: this.step(1, 0); return true;
      case Keyboard.UP:    this.step(0, -1); return true;
      case Keyboard.DOWN:  this.step(0, 1); return true;
      case Keyboard.ENTER:
      case Keyboard.SPACE:
        this.click(this.nodeButton(this.nodeSel));
        return true;
      case Keyboard.ESCAPE:
        this.click(g.m_mainMenu.BackToIntro);
        return true;
    }
    return false;
  }

  private boardKey(code: number, key: string): boolean {
    const board: Ported = this.overlay();
    const inner = board.GOboard || board.Rboard;
    if (!inner) return false;
    if (key === "r" && inner.RetryBtn) {
      this.click(inner.RetryBtn);
      return true;
    }
    if (code === Keyboard.ENTER || code === Keyboard.ESCAPE) {
      this.click(inner.ToMenuBtn);
      return true;
    }
    return false;
  }

  /**
   * In a level, movement and P go straight to Game.keyPressed via the stage.
   * The only addition is choosing between the pause tray's two buttons, which
   * have no keyboard equivalent in the original because they were clicked.
   */
  private gameKey(code: number, _key: string): boolean {
    const g = this.game as Ported;
    const paused = g.m_level && g.m_level.pause === true;
    if (paused && g.m_pauseMenu) {
      if (code === Keyboard.UP || code === Keyboard.DOWN) {
        this.traySel = this.traySel === 0 ? 1 : 0;
        return true;
      }
      if (code === Keyboard.ENTER) {
        this.click(this.traySel === 0 ? g.m_pauseMenu.retryBtn
                                      : g.m_pauseMenu.endGameBtn);
        return true;
      }
    }
    return false;
  }

  // ---- mouse ------------------------------------------------------------

  /** The button the pointer is currently over, so ROLL_OUT can be paired. */
  private hovered: Ported = null;

  /**
   * Move the pointer. `target` is whatever the renderer hit-tested, or null.
   *
   * Rolling over drives the original's own Glowin/Glowout and OverSounder, so
   * the firefly cursor chases the mouse exactly as it chased it in 2009, and
   * the keyboard selection follows along -- pick a node with the mouse and the
   * arrow keys carry on from there rather than jumping back.
   */
  pointerMove(target: Ported): boolean {
    if (target === this.hovered) return !!target;
    if (this.hovered) roll(this.hovered, false);
    this.hovered = target;
    if (target) {
      roll(target, true);
      this.syncSelectionTo(target);
    }
    return !!target;
  }

  /** Press whatever the pointer is over, and show the down art. */
  pointerDown(target: Ported): boolean {
    if (!target) return false;
    // Flash sends the roll first if the press is the pointer's first contact.
    if (this.hovered !== target) this.pointerMove(target);
    setState(target, "down");
    this.pressed = target;
    return true;
  }

  /**
   * Release. The click fires here, not on the press, so the down art is
   * actually on screen for a frame before the screen it belongs to goes away.
   */
  pointerUp(): boolean {
    const target = this.pressed;
    this.pressed = null;
    if (!target) return false;
    setState(target, "up");
    this.click(target);
    // The click usually tears down the screen the button lived on, so the
    // hover is stale: a later ROLL_OUT would fire at a detached clip.
    this.hovered = null;
    return true;
  }

  /** Cancel a press that was released off the button, as Flash does. */
  pointerCancel(): void {
    if (this.pressed) setState(this.pressed, "up");
    this.pressed = null;
  }

  private pressed: Ported = null;

  /** Keep the keyboard cursor on whatever the mouse just picked. */
  private syncSelectionTo(target: Ported): void {
    const g = this.game as Ported;
    const name: string = target.name || "";
    if (name.startsWith("b_") && g.Translation) {
      const i = g.Translation.indexOf(name.slice(2));
      if (i >= 0) this.nodeSel = i + 1;
      return;
    }
    const intro = this.introButtons.indexOf(name);
    if (intro >= 0) { this.introSel = intro; return; }
    if (g.m_pauseMenu) {
      if (target === g.m_pauseMenu.retryBtn) this.traySel = 0;
      else if (target === g.m_pauseMenu.endGameBtn) this.traySel = 1;
    }
  }

  /** Which control is highlighted, for the harness readout. */
  get selection(): string {
    const g = this.game as Ported;
    switch (this.screen()) {
      case "intro": return this.introButtons[this.introSel];
      case "map":
        return "node " + this.nodeSel + " (" +
               ((g.Translation && g.Translation[this.nodeSel - 1]) || "?") + ")";
      case "game": return this.traySel === 0 ? "retry" : "end game";
      default: return "";
    }
  }

  // ---- forwarding to the ported handlers --------------------------------

  forwardDown(code: number): void {
    this.stage.dispatchEvent(new KeyboardEvent(KeyboardEvent.KEY_DOWN, code));
  }

  forwardUp(code: number): void {
    this.stage.dispatchEvent(new KeyboardEvent(KeyboardEvent.KEY_UP, code));
  }
}
