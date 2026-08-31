/**
 * The shell, end to end, with no browser.
 *
 * Every step here is one that silently did nothing at some point during the
 * port, and none of them would have been caught by the physics tests:
 *
 *  * frame scripts that do more than stop(). deadFire's frame 32 calls
 *    GameOver() and WaterGirlStairs' frame 35 calls Recuent(); they are the
 *    only triggers for the death and results screens in the whole game.
 *  * AS3 method references are bound. Recuento.Ease animates the results board
 *    off `this`, but the listener lives on the board's child.
 *  * AS3 anonymous functions capture the lexical `this`. The results board's
 *    back button is an inline closure calling Game.EndGame().
 *  * the display-list walk has to descend through plain Sprites, or nothing
 *    inside a level (which is a Sprite) ever animates.
 *  * progress: finishing a level has to record a medal and open the next node
 *    through the Adjacencies graph.
 */
import { Game } from "./game/game.js";
import { advanceTree, enterFrameTree, MouseEvent, SoundBus } from
  "./flash/flash.js";
import { Intent, ShellInput } from "./game/shellinput.js";

let failures = 0;

function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}` +
              (ok ? "" : ` (expected ${JSON.stringify(want)})`));
}

const game: any = new (Game as any)();

/** One simulation step, exactly as the browser host runs it. */
function step(n = 1): void {
  for (let i = 0; i < n; i++) {
    advanceTree(game);
    enterFrameTree(game);
    SoundBus.drain();          // audio is a side effect; just keep it bounded
  }
}

function click(target: any): void {
  target.dispatchEvent(new MouseEvent(MouseEvent.CLICK, target));
  target.dispatchEvent(new MouseEvent(MouseEvent.MOUSE_DOWN, target));
}

const symbols = () => game.children.map((c: any) => c.symbol).filter(Boolean);

console.log("boot");
check("starts on the intro menu", symbols(), ["IntroMenu"]);
check("a fresh save opens only level 1",
      game.The_cookie.data.stats.slice(0, 3), [0, -1, -1]);

console.log("\nintro -> level map");
click(game.m_introMenu.Buttons.Starter);
step(20);
check("main menu is up", symbols(), ["MainMenu"]);
check("node 1 shows as unplayed", game.m_mainMenu.node_1.currentFrame, 1);

console.log("\nlevel map -> adventure 1");
click(game.m_mainMenu.b_1_1);
step(20);
check("the level is running", game.m_level.CurrentMode, "adventure");
check("the timer, pause tray and mute button are present",
      symbols(), ["Watch", "PauseMenu", "Muter"]);

console.log("\npause");
const wasPaused = game.m_level.pause;
click(game.m_pauseMenu.btn);
step(40);
check("the level was not paused before", wasPaused, false);
check("P pauses the level", game.m_level.pause, true);
check("the tray shows the diamond counts",
      [game.m_pauseMenu.BlueCount.text, game.m_pauseMenu.RedCount.text],
      ["0", "0"]);
click(game.m_pauseMenu.btn);
step(60);
check("closing the tray resumes", game.m_level.pause, false);

console.log("\nfinishing the level");
const cl = game.m_level.myContactListener;
// stand both characters on their doors: the doors open over 22 frames, then
// level.Update spawns the stairs whose frame 35 script calls Recuent()
for (let i = 0; i < 140; i++) { cl.finish1 = true; cl.finish2 = true; step(); }
step(45);
check("the results board appeared", symbols().includes("Recuento"), true);
check("a medal was recorded", game.The_cookie.data.stats[0] > 0, true);
check("the next node was unlocked", game.The_cookie.data.stats[1], 0);
check("a best time was saved",
      /^\d\d:\d\d$/.test(game.The_cookie.data.timesString[0]), true);

console.log("\nresults -> back to the map");
const board = game.children.filter((c: any) => c.symbol === "Recuento").pop();
click(board.Rboard.ToMenuBtn);
step(20);
check("back on the map", symbols(), ["MainMenu"]);
check("node 1 now shows its medal", game.m_mainMenu.node_1.currentFrame > 1,
      true);
check("node 2 is on the map", game.m_mainMenu.node_2.currentFrame, 1);

console.log("\ndying");
click(game.m_mainMenu.b_1_1);
step(20);
game.m_level.myContactListener.deadFire = true;
step(80);
check("the game-over board appeared", symbols().includes("GameOvero"), true);

console.log("\nthe buttons that change shared state, and the ones that do not");
{
  // The rule the netplay screen depends on. A button that changes what BOTH
  // peers simulate must be answerable before it is dispatched, or it happens on
  // one machine only -- and, inside the rollback window, gets erased there too
  // when the next correction restores a snapshot that still has the board in it.
  const shell = new ShellInput(game, game.stage);
  const seen: Intent[] = [];
  const off = shell.onIntent((i) => { seen.push(i); return true; });

  const press = (target: any) => { shell.pointerDown(target); shell.pointerUp(); };

  const board = game.children.filter((c: any) => c.symbol === "GameOvero").pop();
  const level = game.m_level;
  press(board.GOboard.RetryBtn);
  step(20);
  check("the game-over retry is an intent, not a rebuild",
        seen.map((i) => i.kind), ["retry"]);
  check("and the level it would have rebuilt is untouched",
        game.m_level === level, true);
  check("with the board still up", symbols().includes("GameOvero"), true);

  seen.length = 0;
  const wasPaused = game.m_level.pause;
  press(game.m_pauseMenu.btn);
  press(game.m_pauseMenu.retryBtn);
  press(game.m_pauseMenu.endGameBtn);
  press(game.m_muter.muteBtn);
  check("so are the pause tray and the mute button",
        seen.map((i) => i.kind), ["pause", "retry", "quit", "mute"]);
  check("and none of them reached the level behind the hook",
        game.m_level.pause, wasPaused);

  // Everything else on this screen is one person looking around their own copy
  // of the shell, and travels nowhere.
  seen.length = 0;
  press(board.GOboard.ToMenuBtn);
  step(20);
  check("leaving to the map is an intent too", seen.map((i) => i.kind),
        ["quit"]);
  check("so it did not happen either", symbols().includes("GameOvero"), true);

  // Let it through this time, to get back to the map for the last two checks.
  off();
  press(board.GOboard.ToMenuBtn);
  step(20);
  check("and with nobody claiming it, the click lands exactly as before",
        symbols(), ["MainMenu"]);

  seen.length = 0;
  const claim = shell.onIntent((i) => { seen.push(i); return true; });
  press(game.m_mainMenu.b_1_1);
  step(20);
  check("a map node names the level it would have started",
        seen, [{ kind: "start", mode: "adventure", num: 1 }]);
  check("and did not start it", symbols(), ["MainMenu"]);

  seen.length = 0;
  press(game.m_mainMenu.BackToIntro);
  step(20);
  check("while the intro button is nobody else's business", seen, []);
  check("and simply worked", symbols(), ["IntroMenu"]);
  claim();
}

console.log("\n" + (failures === 0 ? "SHELL TEST PASSED"
                                   : `SHELL TEST FAILED (${failures})`));
process.exit(failures === 0 ? 0 : 1);
