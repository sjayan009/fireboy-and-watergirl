/**
 * A SessionHost over a bare level, with no menu shell around it.
 *
 * This is what the netcode tests and any headless replay drive. The browser
 * uses a Game-backed host instead, so the pause tray and the results board
 * come along -- but both go through the same SessionHost interface, so the
 * netcode cannot tell them apart and neither can a test.
 */
import { level, tickClock, getClock, setClock } from "../game/game.js";
import {
  Event, advanceTree, enterFrameTree, SoundBus,
} from "../flash/flash.js";
import { applyInput, hashLevel } from "./hash.js";
import { hostLevel, HeadlessHost } from "../game/headless.js";
import { SessionHost } from "./session.js";
import { Snapshot } from "./snapshot.js";

export class LevelHost implements SessionHost {
  /** The running level, or null before the first start. */
  lv: any = null;
  /** Counts the GameOver and Recuent that deadFire and WaterGirlStairs fire. */
  shell: HeadlessHost | null = null;
  private mode = "adventure";
  private num = 1;

  start(mode: string, num: number): void {
    this.mode = mode;
    this.num = num;
    this.lv = new (level as any)(mode, num);
    this.shell = hostLevel(this.lv);
  }

  step(bits: number, frame = 0, replaying = false): void {
    if (!this.lv) return;
    // A replayed frame must sound like nothing at all; it has been heard.
    SoundBus.frame = frame;
    SoundBus.replaying = replaying;
    tickClock();
    applyInput(this.lv, bits);
    advanceTree(this.lv);
    enterFrameTree(this.lv);
    this.lv.Update(new Event(Event.ENTER_FRAME));
    SoundBus.replaying = false;
  }

  hash(): string | null {
    return this.lv ? hashLevel(this.lv) : null;
  }

  /**
   * The level reached through its headless host, because the two counters the
   * host keeps -- did anyone die, did anyone finish -- are simulation state
   * that a rollback has to put back like any other.
   *
   * The clock rides along separately: it lives in a module variable, where no
   * walk of the object graph can find it, and `Recuent` awards the medal by
   * reading it.
   */
  save(s: Snapshot): void {
    if (!this.shell) return;
    s.capture([this.shell]);
    s.clock = getClock();
  }

  load(s: Snapshot): void {
    s.restore();
    setClock(s.clock);
  }

  /**
   * Toggled on the level rather than on a field of this host, because a field
   * of this host is not in the snapshot: a rollback would put `lv.pause` back
   * and leave the shadow copy disagreeing with it.
   */
  pause(): void {
    if (!this.lv) return;
    this.lv.pause = !this.lv.pause;
  }

  retry(): void {
    this.start(this.mode, this.num);
  }

  quit(): void {
    this.lv = null;
    this.shell = null;
  }
}
