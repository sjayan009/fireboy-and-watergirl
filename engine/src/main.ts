/**
 * Browser host for the whole game: intro menu, level map, play, pause,
 * results, and the determinism readouts.
 *
 * The loop is a fixed 1/26 s accumulator, never delta-time, because the
 * simulation has to advance in identical discrete steps on both peers. Each
 * step does what Flash did in a frame, in Flash's order: advance the
 * playheads (running any frame scripts), then broadcast ENTER_FRAME. The
 * ported shell hangs off that broadcast entirely -- level.Update, the pause
 * tray's slide, the results board's easing, the timer, the fireflies.
 *
 * Note there is no stage transform here any more. Game.StartGame does it
 * itself (`m_level.scaleX = 0.8; m_level.x += 16`), exactly as the original
 * did, and applying it a second time would shrink the level inside the menus.
 */
import { Game, level, tickClock, resetClock } from "./game/game.js";
import {
  Event, advanceTree, enterFrameTree, SoundBus, Keyboard,
} from "./flash/flash.js";
import { draw as drawDebug } from "./render/debugdraw.js";
import { SpriteRenderer } from "./render/sprites.js";
import { hashLevel, applyInput } from "./net/hash.js";
import { hostLevel } from "./game/headless.js";
import { ShellInput } from "./game/shellinput.js";
import { AudioPlayer } from "./audio/player.js";
import { NetSession, Slot } from "./net/session.js";
import { BroadcastTransport } from "./net/broadcast.js";
import { GameHost } from "./net/gamehost.js";
import { Command } from "./net/protocol.js";
import { connect, TransportKind } from "./net/connect.js";

const TIME_STEP = 1 / 26;

// The original stage. CreateGround lays clips out at 20px per tile and
// StartGame scales the level by 0.8 with a 16px offset: 39*20*0.8 + 16 = 640
// and 29*20*0.8 + 16 = 480 -- exactly the SWF's stage.
const STAGE_W = 640;
const STAGE_H = 480;

const canvas = document.getElementById("stage") as HTMLCanvasElement;
canvas.width = STAGE_W;
canvas.height = STAGE_H;
const ctx = canvas.getContext("2d")!;

let audio: AudioPlayer | null = null;
AudioPlayer.load("/extracted/assets")
  .then((a) => { audio = a; })
  .catch((e) => { console.warn("audio unavailable:", e); });

let sprites: SpriteRenderer | null = null;
SpriteRenderer.load("/extracted/assets")
  .then((r) => { sprites = r; })
  .catch((e) => { console.warn("sprite art unavailable:", e); });

const el = (id: string) => document.getElementById(id)!;

resetClock();
const game: any = new (Game as any)();
const shell = new ShellInput(game, game.stage);
(globalThis as any).game = game;      // for poking at from the console

let frame = 0;
let inputLog: number[] = [];
let lastLevel: any = null;

/**
 * The netplay session, once two peers have paired.
 *
 * While it exists it owns the fixed-step loop and the level's input: local
 * keys become this player's three bits and go to the peer, rather than being
 * written straight into the level by Game.keyPressed. Everything else -- the
 * menus, the renderer, the audio -- is untouched.
 */
let session: NetSession | null = null;
let mySlot: Slot = 0;
let linkKind: TransportKind | "" = "";
const netHeld = new Set<string>();

/**
 * This player's three bits. Either control scheme drives YOUR character: you
 * only have one, so there is nothing to disambiguate, and asking the Watergirl
 * player to use W/A/D just because that is what the 2009 keyboard split said
 * would be pointless when they are alone at their own keyboard.
 */
function netBits(): number {
  return ((netHeld.has("ArrowLeft") || netHeld.has("a")) ? 1 : 0) |
         ((netHeld.has("ArrowRight") || netHeld.has("d")) ? 2 : 0) |
         ((netHeld.has("ArrowUp") || netHeld.has("w")) ? 4 : 0);
}

const MOVEMENT = ["ArrowLeft", "ArrowRight", "ArrowUp", "a", "d", "w"];

// --- input ---------------------------------------------------------------
// Fireboy = arrow keys, Watergirl = W/A/D, P pauses -- all of it handled by
// the ported Game.keyPressed, which listens on the stage. The shell dispatcher
// gets first refusal so menu navigation can claim the arrows.
const CODES: Record<string, number> = {
  ArrowLeft: Keyboard.LEFT, ArrowRight: Keyboard.RIGHT,
  ArrowUp: Keyboard.UP, ArrowDown: Keyboard.DOWN,
  Enter: Keyboard.ENTER, Escape: Keyboard.ESCAPE, " ": Keyboard.SPACE,
};

function codeOf(e: globalThis.KeyboardEvent): number {
  if (CODES[e.key] !== undefined) return CODES[e.key];
  if (e.key.length === 1) return e.key.toUpperCase().charCodeAt(0);
  return 0;
}

addEventListener("keydown", (e) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(e.key)) {
    e.preventDefault();
  }
  const code = codeOf(e);
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (session) {
    // In a session the level's input belongs to the netcode, not to
    // Game.keyPressed -- writing it locally would apply this player's move a
    // few frames before the other peer ever hears about it.
    if (MOVEMENT.includes(key)) { netHeld.add(key); return; }
    if (key === "p") { session.send(Command.Pause); return; }
    if (key === "r") { session.send(Command.Retry); return; }
    if (key === "Escape") { session.send(Command.Quit); return; }
  }

  if (shell.keyDown(code, key)) return;
  shell.forwardDown(code);
});

addEventListener("keyup", (e) => {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (session && MOVEMENT.includes(key)) { netHeld.delete(key); return; }
  shell.forwardUp(codeOf(e));
});
addEventListener("blur", () => {
  // Release everything, or a key held across a tab switch sticks down.
  for (const c of [Keyboard.LEFT, Keyboard.RIGHT, Keyboard.UP,
                   Keyboard.A, Keyboard.D, Keyboard.W]) shell.forwardUp(c);
});
addEventListener("pagehide", () => { game.The_cookie?.flush?.(); });

// --- mouse ---------------------------------------------------------------
// The canvas is a fixed 640x480 stage that CSS may be scaling, so pointer
// coordinates have to come back through that scale before they mean anything
// to the display list.
function stagePoint(e: PointerEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * (STAGE_W / r.width),
          (e.clientY - r.top) * (STAGE_H / r.height)];
}

function pick(e: PointerEvent): any {
  if (!sprites) return null;
  const [x, y] = stagePoint(e);
  return sprites.hitTest(game, x, y);
}

canvas.addEventListener("pointermove", (e) => {
  const over = shell.pointerMove(pick(e));
  canvas.style.cursor = over ? "pointer" : "default";
});

canvas.addEventListener("pointerdown", (e) => {
  const target = pick(e);
  if (!target) return;
  e.preventDefault();
  // Capture, so releasing off the button still reaches us and the press can be
  // cancelled the way Flash cancels it.
  canvas.setPointerCapture(e.pointerId);
  shell.pointerDown(target);
});

canvas.addEventListener("pointerup", (e) => {
  // The click fires on release, not on the press, so the down art is on screen
  // for at least a frame before the screen it belongs to is torn down.
  if (pick(e) === null) shell.pointerCancel();
  else shell.pointerUp();
  canvas.style.cursor = pick(e) ? "pointer" : "default";
});

canvas.addEventListener("pointercancel", () => { shell.pointerCancel(); });

canvas.addEventListener("pointerleave", () => {
  shell.pointerCancel();
  shell.pointerMove(null);
  canvas.style.cursor = "default";
});

// --- loop ----------------------------------------------------------------
let acc = 0;
let last = performance.now();
let running = true;

function step(): void {
  tickClock();
  const lv = liveLevel();
  if (lv) {
    inputLog.push(
      (lv.l_pressed ? 1 : 0) | (lv.r_pressed ? 2 : 0) | (lv.u_pressed ? 4 : 0) |
      (lv.l_pressed2 ? 8 : 0) | (lv.r_pressed2 ? 16 : 0) |
      (lv.u_pressed2 ? 32 : 0));
  }
  SoundBus.frame = frame;
  advanceTree(game);
  enterFrameTree(game);
  frame++;
}

function tick(now: number): void {
  requestAnimationFrame(tick);
  const dt = Math.min((now - last) / 1000, 0.25);   // clamp after a tab stall
  last = now;
  if (!running) return;

  if (session) {
    // The session owns the clock now: it steps only when both players' input
    // for the next frame has arrived.
    session.setLocalInput(netBits());
    session.tick(dt);
    frame = session.frame;
  } else {
    acc += dt;
    let steps = 0;
    while (acc >= TIME_STEP && steps < 5) {
      step();
      acc -= TIME_STEP;
      steps++;
    }
  }

  // A newly started level resets the recorded input log, and a newly built
  // map wants its keyboard highlight back.
  if (game.m_level !== lastLevel) {
    lastLevel = game.m_level;
    inputLog = [];
    shell.syncMap();
    game.The_cookie?.flush?.();
  }
  if (frame % 26 === 0) game.The_cookie?.flush?.();

  // Audio is a side effect of the simulation, never an input to it.
  if (audio) {
    audio.setMuted((el("mute") as HTMLInputElement).checked);
    audio.drain();
  } else if (SoundBus.queue.length > 256) {
    // The player is still loading its manifest. Hold the queue rather than
    // discarding it: the soundtrack is started ONCE, on the intro menu, in the
    // first few frames -- throw that away and the music simply never plays.
    // The cap is only there so a failed load cannot grow the queue forever.
    SoundBus.drain();
  }

  render();
  readouts();
}

/**
 * The level currently on screen, or null.
 *
 * `EndGame` removes the level from the display list but leaves `m_level`
 * pointing at it, so the field alone outlives the level it names -- checking
 * the parent is what tells "playing" from "back on the menu".
 */
function liveLevel(): any {
  const lv = game.m_level;
  return lv && lv.parent ? lv : null;
}

function render(): void {
  const wantArt = (el("art") as HTMLInputElement).checked;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  if (wantArt && sprites) {
    sprites.draw(ctx, game);
  } else {
    const lv = liveLevel();
    if (!lv) return;
    // The physics view draws the world directly, so it needs the level's own
    // transform put back on the context.
    ctx.save();
    ctx.translate(lv.x, lv.y);
    ctx.scale(lv.scaleX, lv.scaleY);
    drawDebug(ctx, lv,
              { showGrid: (el("grid") as HTMLInputElement).checked });
    ctx.restore();
  }
}

function readouts(): void {
  const lv = liveLevel();
  el("netStatus").textContent = !session
    ? "solo"
    : `${mySlot === 0 ? "Fireboy" : "Watergirl"} · ` +
      `${linkKind === "webrtc" ? "direct" : "relay"} · ` +
      `frame ${session.frame}` +
      (session.stalled ? " · waiting for the other player" : " · in step") +
      (session.predicting ? ` · ${session.rollbacks} corrections` : "") +
      (session.desyncs ? ` · ${session.desyncs} desync(s)` : "") +
      (session.rebuilds ? ` · ${session.rebuilds} replay(s)` : "") +
      (session.lead ? ` · peer +${session.lead}` : "");
  el("screen").textContent = shell.selection || "—";
  el("frame").textContent = String(frame);
  el("hash").textContent = lv ? hashLevel(lv) : "—";
  el("levelName").textContent = lv
    ? `${lv.CurrentMode}-${String(game.cur_lev).padStart(2, "0")}`
    : "menu";
  if (lv) {
    const p1 = lv.pers1.GetPosition();
    const p2 = lv.pers2.GetPosition();
    el("pos").textContent =
      `fire ${p1.x.toFixed(2)}, ${p1.y.toFixed(2)}   ` +
      `water ${p2.x.toFixed(2)}, ${p2.y.toFixed(2)}`;
    el("diamonds").textContent =
      `${lv.RDcount | 0} red / ${lv.BDcount | 0} blue`;
    const cl = lv.myContactListener;
    // level.as sets `ended` for BOTH death and completion; the contact
    // listener's flags are what tell them apart.
    el("state").textContent =
      cl?.deadFire ? "Fireboy died (water or goo)"
      : cl?.deadWater ? "Watergirl died (lava or goo)"
      : lv.ended ? "level complete"
      : lv.pause ? "paused"
      : "playing";
  } else {
    el("pos").textContent = "—";
    el("diamonds").textContent = "—";
    el("state").textContent = "in the menus";
  }

  el("audio-status").textContent = !audio
    ? "loading…"
    : !audio.ready ? "press a key to enable"
      : `${audio.known} effects, ${audio.playingLoops} looping`;
  el("art-status").textContent = !sprites
    ? "loading manifest…"
    : sprites.loading
      ? `${sprites.loading} images loading`
      : sprites.missing
        ? `${sprites.missing} missing`
        : "ready";
}

// --- controls ------------------------------------------------------------
el("pause").addEventListener("click", () => {
  running = !running;
  el("pause").textContent = running ? "Resume host" : "Pause host";
});

/**
 * Pair with another tab and play a level together.
 *
 * This is netplay with no account, no signalling server and no network: open
 * the page twice and the two tabs agree who is Fireboy, then run the same
 * lockstep session that will later run over WebRTC. Everything above the
 * transport is the real thing.
 */
el("netplay").addEventListener("click", async () => {
  const out = el("netStatus");
  if (session) {
    session.send(Command.Quit);
    session = null;
    netHeld.clear();
    out.textContent = "left the session";
    el("netplay").textContent = "Play together (2 tabs)";
    return;
  }
  out.textContent = "waiting for a second tab…";
  // A room, so two pairs on one machine do not end up in each other's game.
  // ?room=... in the URL; the default is fine for one pair at a time.
  const room = new URLSearchParams(location.search).get("room") || "default";
  const transport = new BroadcastTransport("fbwg-netplay-" + room);
  try {
    mySlot = await transport.pair();
  } catch (e) {
    out.textContent = String((e as Error).message);
    transport.close();
    return;
  }
  // Upgrade to a direct peer connection if one can be had; otherwise keep
  // using the channel we paired on, which carries 10 bytes a second perfectly
  // well.
  out.textContent = "connecting…";
  const link = await connect(transport, mySlot === 0);
  linkKind = link.kind;
  if (link.reason) console.info("using the relay path:", link.reason);

  const host = new GameHost(game);
  session = new NetSession({
    // Rollback: your own character answers on the very next frame, exactly as
    // it does in single-player, and the other player's input is predicted and
    // corrected. Measured at one frame against lockstep's five.
    rollback: true,
    slot: mySlot, host, transport: link.transport,
    onDesync: (f, mine, theirs) =>
      console.warn(`desync at frame ${f}: ${mine} != ${theirs}`),
  });
  el("netplay").textContent = "Leave session";
  // The lower id starts the level; the other peer follows the Start command.
  if (mySlot === 0) session.requestStart("adventure", 1);
});

/**
 * Unlock every node on the map. A fresh save only opens level 1, and walking
 * the whole map to reach level 30 is not a reasonable way to test level 30.
 */
el("unlock").addEventListener("click", () => {
  const stats = game.The_cookie?.data?.stats;
  if (!stats) return;
  for (let i = 0; i < 32; i++) if (stats[i] < 0) stats[i] = 0;
  game.The_cookie.flush();
  el("unlock").textContent = "Unlocked — reopen the map";
});

/**
 * Replay the recorded inputs from a fresh level and compare hashes. Passing
 * here means the simulation is a pure function of (level, input log) *in this
 * browser*; the cross-engine check is what proves it across engines.
 */
el("replay").addEventListener("click", () => {
  const lv = liveLevel();
  const out = el("replayResult");
  if (!lv) { out.textContent = "start a level first"; out.className = ""; return; }
  const expected = hashLevel(lv);
  const replay: any = new (level as any)(lv.CurrentMode, game.cur_lev);
  hostLevel(replay);
  for (const bits of inputLog) {
    applyInput(replay, bits);
    advanceTree(replay);
    replay.Update(new Event(Event.ENTER_FRAME));
  }
  const got = hashLevel(replay);
  const ok = got === expected;
  out.textContent = ok
    ? `deterministic over ${inputLog.length} frames (${got})`
    : `DIVERGED after ${inputLog.length} frames: ${got} != ${expected}`;
  out.className = ok ? "ok" : "bad";
});

/**
 * Cross-engine determinism check.
 *
 * Replays a fixed 600-frame input log shipped as a file, so every browser and
 * every machine runs the identical input. If the digest below matches
 * REFERENCE, this engine would have stayed in lockstep with the reference run.
 *
 * The log is a file rather than generated in-page on purpose: an LCG written
 * in JS loses precision past 2^53 and produces a *different log* per host,
 * which looks exactly like a physics desync and isn't one.
 *
 * `npm test` runs this same log in Chromium, Firefox and WebKit; this button
 * is here for whatever browser you happen to be holding.
 */
const REFERENCE = "aba863c1";   // node dist/replay.js adventure 1 "$(cat scriptlog.txt)"

el("crosscheck").addEventListener("click", async () => {
  const out = el("crossResult");
  out.className = "";
  out.textContent = "running...";
  const txt = await (await fetch("/scriptlog.txt", { cache: "no-store" })).text();
  const bits = txt.trim().split(",").map(Number);
  const sim: any = new (level as any)("adventure", 1);
  hostLevel(sim);
  for (const b of bits) {
    applyInput(sim, b);
    advanceTree(sim);
    sim.Update(new Event(Event.ENTER_FRAME));
  }
  const got = hashLevel(sim);
  const ok = got === REFERENCE;
  out.textContent = ok
    ? `${got} over ${bits.length} frames — matches reference`
    : `${got} != reference ${REFERENCE} — THIS ENGINE WOULD DESYNC`;
  out.className = ok ? "ok" : "bad";
});

/**
 * Debug hooks. requestAnimationFrame is throttled to a crawl in a hidden or a
 * background tab, which makes the game impossible to drive from automation --
 * so expose stepping and drawing directly.
 */
(globalThis as any).__debug = {
  step(n = 1) {
    for (let i = 0; i < n; i++) step();
    // Drain audio too, so stepping behaves like the real loop -- a debug step
    // that skipped it would let plays and stops pile up and be reordered.
    if (audio) audio.drain();
    else if (SoundBus.queue.length > 256) SoundBus.drain();
  },
  render,
  readouts,
  get sprites() { return sprites; },
  get audio() { return audio; },
  get session() { return session; },
  get slot() { return mySlot; },
  get link() { return linkKind; },
  /**
   * Stop the requestAnimationFrame loop from stepping, so a test can be the
   * only thing driving the clock. Without this the page keeps advancing
   * between a test's assertions and its measurements, and two peers read a
   * frame apart look exactly like a desync.
   */
  autoTick(on: boolean) { running = on; },
  /** Advance a netplay session by whole frames, for automation. */
  netTick(n = 1) {
    for (let i = 0; i < n; i++) {
      if (!session) return;
      session.setLocalInput(netBits());
      session.tick(TIME_STEP);
    }
    frame = session ? session.frame : frame;
  },
  /** Hold or release a movement key without a real keyboard. */
  hold(key: string, down: boolean) {
    if (down) netHeld.add(key); else netHeld.delete(key);
  },
  shell,
};

requestAnimationFrame(tick);
