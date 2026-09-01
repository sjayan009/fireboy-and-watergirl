/**
 * A SessionHost over the real `Game` -- menus, pause tray, results board and
 * all -- as opposed to LevelHost, which drives a bare level for the tests.
 *
 * The netcode cannot tell the two apart, which is the point: what the netcode
 * test proves against LevelHost holds here too.
 */
import { tickClock, getClock, setClock } from "../game/game.js";
import {
  advanceTree, enterFrameTree, MouseEvent, SoundBus,
} from "../flash/flash.js";
import { applyInput, hashLevel } from "./hash.js";
import { MODES, SessionHost } from "./session.js";
import { Snapshot } from "./snapshot.js";

/**
 * Take down the results or game-over board, as the click that reached the
 * command would have.
 *
 * `Recuent` and `GameOver` attach the ONLY removal of their board to the inline
 * click listener on its button -- `{ EndGame(); removeChild(board) }` -- and in
 * a session that click never happens. The intent hook swallows it and sends a
 * command, which arrives here instead; `EndGame` and `RetryGame` take down the
 * level, the timer, the tray and the mute button and know nothing about a
 * board. So without this the board outlives the level it belongs to: a
 * near-opaque `Tapper` over the map and over every level after it, a live
 * ENTER_FRAME easing it, one more object graph inside every snapshot, and a
 * `ShellInput.screen()` that answers "board" forever -- which is what kills the
 * map's keyboard navigation.
 *
 * The same predicate `ShellInput.overlay()` uses, so the two cannot disagree
 * about what a board is.
 */
function closeBoards(g: any): void {
  for (const c of [...g.children]) {
    if (c.GOboard || c.Rboard) g.removeChild(c);
  }
}

export class GameHost implements SessionHost {
  constructor(private game: any) {}

  /** One fixed step, in Flash's order: playheads, then ENTER_FRAME. */
  step(bits: number, frame = 0, replaying = false): void {
    // A frame being re-run to correct a mispredicted input has already been
    // heard once. Everything else about it must come out identical.
    SoundBus.frame = frame;
    SoundBus.replaying = replaying;
    tickClock();
    const lv = this.game.m_level;
    if (lv && lv.parent) applyInput(lv, bits);
    advanceTree(this.game);
    enterFrameTree(this.game);
    SoundBus.replaying = false;
  }

  /**
   * The whole Game, not just the level.
   *
   * Wider than it first looks necessary, and deliberately so: the pause tray's
   * slide, the results board's easing and `cur_node` all live above the level
   * and all of them are simulated, so a rollback that put only the physics back
   * would leave the shell describing a frame that no longer happened. The walk
   * costs what it costs; correctness is not the place to economise.
   *
   * The clock rides along separately, in a module variable that no walk of the
   * object graph can reach.
   */
  save(s: Snapshot): void {
    s.capture([this.game]);
    s.clock = getClock();
  }

  load(s: Snapshot): void {
    s.restore();
    setClock(s.clock);
  }

  /** Only a level that is actually on screen is shared state worth hashing. */
  hash(): string | null {
    const lv = this.game.m_level;
    return lv && lv.parent ? hashLevel(lv) : null;
  }

  /**
   * Start a level directly, without the map's fade.
   *
   * `StartGameBtn` normally does this bookkeeping before handing off to
   * `Transit`, and `Recuent` later reads `cur_node` to decide which map node to
   * award a medal to -- so skipping the transition must not mean skipping the
   * bookkeeping.
   *
   * ## The order here is load-bearing
   *
   * `EndGame` is not only a teardown: its last line is `CreateMainMenu()`, so
   * it PUTS A MAP BACK. Sweeping the screens before calling it therefore swept
   * a map that did not exist yet and left the one it made behind -- an extra
   * MainMenu underneath the level, one per start-from-a-level, which is every
   * `resync` and every level a watcher joins. Ending the level first and
   * sweeping afterwards leaves exactly one thing on screen.
   *
   * The music follows for the same reason. `CreateMainMenu` starts the menu
   * theme, and `StartGame` only switches to the level's if `PlayingMusic` is
   * false -- so silencing the music before `EndGame` had it start the menu
   * theme meant playing a level with the map's music over it.
   */
  start(mode: string, num: number): void {
    const g = this.game;
    const type = MODES.indexOf(mode) + 1 || 1;
    const name = `${type}_${num}`;
    const node = g.Translation ? g.Translation.indexOf(name) + 1 : 0;

    g.cur_type = type;
    g.cur_lev = num;
    if (node > 0) {
      g.cur_node = node;
      if (g.NewsArray) g.NewsArray[node - 1] = false;
    }
    // Leaving the level we are on, if we are on one. This is also what puts a
    // map back, which is why it comes before the sweep and not after it.
    if (g.m_level && g.m_level.parent === g) g.EndGame();
    // Tear down whatever screen we are on now, so a start is safe from
    // anywhere: the map, the intro, a transition, or a board.
    for (const screen of [g.m_mainMenu, g.m_introMenu, g.m_transition]) {
      if (screen && screen.parent === g) g.removeChild(screen);
    }
    closeBoards(g);
    // Last, so that whatever the teardown above started playing is stopped and
    // `StartGame` is free to put the level's own music on.
    g.PlayingMusic = false;
    g.MusicChannel?.stop?.();
    g.StartGame(type, num);
  }

  /** The pause tray, driven exactly as clicking its tab would. */
  pause(): void {
    const g = this.game;
    if (!g.m_pauseMenu || !g.m_level || g.m_level.ended) return;
    g.m_pauseMenu.Show_Hide(new MouseEvent(MouseEvent.MOUSE_DOWN,
                                           g.m_pauseMenu.btn));
  }

  /**
   * Rebuild the level from its beginning.
   *
   * The board goes first: a retry is reached from the game-over board as often
   * as from the pause tray, and `RetryGame` does not know the board is there.
   */
  retry(): void {
    closeBoards(this.game);
    this.game.RetryGame?.();
  }

  /**
   * Leave the level, if there is one.
   *
   * `EndGame` reaches straight into `m_level.windChannels` on its first line,
   * so calling it with no level on screen throws -- and there are now callers
   * that legitimately have none. A watcher who closes the tab before the pair
   * has started anything is the plain example: it is leaving a game it never
   * entered, which is a no-op and should read as one.
   */
  quit(): void {
    const g = this.game;
    // Before the guard below, not after. The guard is there for a caller with
    // no level at all -- a watcher leaving a game it never entered -- and a
    // board is not the level, so it must not be able to hide behind that.
    closeBoards(g);
    if (!g.m_level || g.m_level.parent !== g) return;
    g.EndGame?.();
  }
}
