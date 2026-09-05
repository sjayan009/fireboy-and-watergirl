/** Full-shell replay verification. Run each job in an isolated JS realm. */
import { Game, resetClock } from "./game/game.js";
import { MemorySave, getSaveStore, setSaveStore } from "./game/save.js";
import { SoundBus } from "./flash/flash.js";
import { GameHost } from "./net/gamehost.js";
import { Command } from "./net/protocol.js";
import { ENGINE_VERSION } from "./version.js";

export interface Replay {
  version: 1; engine: string; mode: string; num: number; frames: number;
  inputs: string; commands: [number, number, number, number][];
}
export interface VerifiedResult { node: number; medal: number; seconds: number; frames: number }
export const MAX_REPLAY_FRAMES = 200000;
export function canonicalReplay(r: Replay): string {
  return JSON.stringify([r.version, r.engine, r.mode, r.num, r.frames, r.inputs, r.commands]);
}
export function encodeInputs(bits: readonly number[]): string {
  let s = "";
  for (const b of bits) s += String.fromCharCode(b);
  return btoa(s);
}
/** Reads the actual result board, never the personal-best save. */
export function completedResult(game: any, frames: number): VerifiedResult | null {
  const board = game.children.find((c: any) => c.Rboard)?.Rboard;
  if (!board || board.Result.F.visible) return null;
  const medal = board.Result.A.visible ? 3 : board.Result.B.visible ? 2 : board.Result.C.visible ? 1 : 0;
  if (!medal) return null;
  // The clock is two text fields, so it can be unreadable in a way a number
  // cannot: `Number("")` is 0 and `Number("--")` is NaN, and NaN passes every
  // range check written as a comparison, because every comparison against NaN
  // is false. A completion nobody can put a time on is not a completion this
  // can score, so it is refused here rather than allowed to reach a caller
  // whose bounds check would wave it through.
  const mins = Number(game.m_timer.mins.text), secs = Number(game.m_timer.secs.text);
  if (!Number.isInteger(mins) || !Number.isInteger(secs) || mins < 0 || secs < 0 || secs > 59) return null;
  const seconds = mins * 60 + secs;
  if (seconds < 3 || seconds > 5999) return null;
  return { node: game.cur_node, medal, seconds, frames };
}
export function parseReplay(text: string): Replay {
  if (text.length > 1024 * 1024) throw new Error("Replay exceeds size limit");
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length !== 7) throw new Error("Invalid replay");
  const [version, engine, mode, num, frames, inputs, commands] = value as any[];
  const levels: Record<string, number> = { adventure: 17, puzzle: 9, speed: 6 };
  if (version !== 1 || engine !== ENGINE_VERSION || typeof mode !== "string" || !Object.hasOwn(levels, mode) || !Number.isInteger(num) || num < 1 || num > levels[mode] || !Number.isInteger(frames) || frames < 1 || frames > MAX_REPLAY_FRAMES || typeof inputs !== "string" || inputs.length !== Math.ceil(frames / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(inputs) || !Array.isArray(commands) || commands.length > 2048) throw new Error("Unsupported or invalid replay");
  let previous = -1, previousAction = -1;
  for (const c of commands) {
    if (!Array.isArray(c) || c.length !== 4 || !c.every(Number.isInteger) || c[0] < 0 || c[0] >= frames || c[0] < previous || c[1] !== Command.Pause || ![0,1].includes(c[2]) || c[3] !== 0) throw new Error("Invalid gameplay commands");
    if (c[0] === previous && c[2] <= previousAction) throw new Error("Gameplay commands are not uniquely ordered");
    previous = c[0];
    previousAction = c[2];
  }
  const r: Replay = { version, engine, mode, num, frames, inputs, commands };
  if (canonicalReplay(r) !== text) throw new Error("Replay is not canonical");
  return r;
}
export function verifyReplay(text: string): VerifiedResult {
  const r = parseReplay(text);
  const bits = Uint8Array.from(atob(r.inputs), c => c.charCodeAt(0));
  if (bits.length !== r.frames || bits.some(b => b > 63)) throw new Error("Invalid inputs");
  const old = getSaveStore();
  const store = new MemorySave();
  let game: any;
  setSaveStore(() => store);
  resetClock();
  try { game = new (Game as any)(); } finally { setSaveStore(old); }
  const host = new GameHost(game);
  host.start(r.mode, r.num);
  let command = 0;
  for (let f = 0; f < r.frames; f++) {
    while (r.commands[command]?.[0] === f) { host.pause(r.commands[command][2] === 1); command++; }
    host.step(bits[f], f, true);
    SoundBus.drain();
    const result = completedResult(game, f + 1);
    if (result) {
      // Only the boundary: `completedResult` has already refused anything it
      // could not put a plausible time on, so repeating the range here would
      // be a condition that can no longer be true.
      if (f + 1 !== r.frames) throw new Error("Replay completion boundary disagrees");
      return result;
    }
    if (game.children.some((c: any) => c.GOboard)) throw new Error("Level failed");
  }
  throw new Error("Level did not complete");
}
