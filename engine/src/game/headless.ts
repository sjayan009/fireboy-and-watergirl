/**
 * A minimal stand-in for `Game`, for tests and replays that exercise the
 * simulation without the shell.
 *
 * `level` reaches upward in exactly two places, and both are frame scripts on
 * clips it creates: `deadFire` frame 32 calls `(parent.parent as Game)
 * .GameOver()` and `WaterGirlStairs` frame 35 calls `.Recuent()`. Those are
 * the only triggers for the death and results screens in the whole game, so
 * they must not be softened -- but a headless replay has no Game above the
 * level, and reaching through a null parent would crash the moment a character
 * dies.
 *
 * Constructing a real `Game` instead would boot the intro menu and the save,
 * which is a lot of shell for a test that is measuring physics. This counts
 * the calls instead, which also makes "does dying actually trigger game over?"
 * something a test can assert rather than something to eyeball.
 */
import { Sprite } from "../flash/flash.js";
import type { Ported } from "../ported.js";

export class HeadlessHost extends Sprite {
  gameOvers = 0;
  recuents = 0;

  GameOver(): void { this.gameOvers++; }
  Recuent(): void { this.recuents++; }
}

/** Put `lv` under a headless host and return the host. */
export function hostLevel(lv: Ported): HeadlessHost {
  const host = new HeadlessHost();
  host.addChild(lv);
  return host;
}
