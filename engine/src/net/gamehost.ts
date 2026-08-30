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
import { SessionHost } from "./session.js";
import { Snapshot } from "./snapshot.js";

const MODE_INDEX: Record<string, number> = {
  adventure: 1, puzzle: 2, speed: 3,
};

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
   */
  start(mode: string, num: number): void {
    const g = this.game;
    const type = MODE_INDEX[mode] ?? 1;
    const name = `${type}_${num}`;
    const node = g.Translation ? g.Translation.indexOf(name) + 1 : 0;

    g.PlayingMusic = false;
    g.MusicChannel?.stop?.();
    g.cur_type = type;
    g.cur_lev = num;
    if (node > 0) {
      g.cur_node = node;
      if (g.NewsArray) g.NewsArray[node - 1] = false;
    }
    // Tear down whatever screen we were on, so a start is safe from anywhere.
    for (const screen of [g.m_mainMenu, g.m_introMenu, g.m_transition]) {
      if (screen && screen.parent === g) g.removeChild(screen);
    }
    if (g.m_level && g.m_level.parent === g) g.EndGame();
    g.StartGame(type, num);
  }

  /** The pause tray, driven exactly as clicking its tab would. */
  pause(): void {
    const g = this.game;
    if (!g.m_pauseMenu || !g.m_level || g.m_level.ended) return;
    g.m_pauseMenu.Show_Hide(new MouseEvent(MouseEvent.MOUSE_DOWN,
                                           g.m_pauseMenu.btn));
  }

  retry(): void { this.game.RetryGame?.(); }
  quit(): void { this.game.EndGame?.(); }
}
