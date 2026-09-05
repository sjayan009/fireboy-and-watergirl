export interface LevelSelection {
  mode: "adventure" | "puzzle" | "speed";
  num: number;
  iAmFireboy: boolean;
}

export type PlayState = "idle" | "configuring" | "inviting" | "accepting" |
  "connecting" | "playing" | "between-levels" | "reconnecting" | "ended";

/** Owns asynchronous attempts. A superseded operation can never commit. */
export class PlayController {
  state: PlayState = "idle";
  private attempt: AbortController | null = null;
  private listeners = new Set<(state: PlayState) => void>();

  set(state: PlayState): void {
    if (state === this.state) return;
    this.state = state;
    for (const fn of this.listeners) fn(state);
  }

  start(state: PlayState): AbortController {
    this.cancel();
    this.attempt = new AbortController();
    this.set(state);
    return this.attempt;
  }

  owns(attempt: AbortController): boolean {
    return this.attempt === attempt && !attempt.signal.aborted;
  }

  finish(attempt: AbortController, state: PlayState): boolean {
    if (!this.owns(attempt)) return false;
    this.attempt = null;
    this.set(state);
    return true;
  }

  cancel(): void {
    this.attempt?.abort();
    this.attempt = null;
  }

  onChange(fn: (state: PlayState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }
}

export function selectionKey(owner: string, friend: string): string {
  return `fbwg.selection.${owner}.${friend}`;
}

export function loadSelection(owner: string, friend: string): LevelSelection {
  const fallback: LevelSelection = { mode: "adventure", num: 1, iAmFireboy: true };
  try {
    const p = JSON.parse(localStorage.getItem(selectionKey(owner, friend)) ?? "null") as LevelSelection | null;
    const count = p && ({ adventure: 17, puzzle: 9, speed: 6 })[p.mode];
    return p && count && Number.isInteger(p.num) && p.num >= 1 && p.num <= count
      && typeof p.iAmFireboy === "boolean" ? p : fallback;
  } catch { return fallback; }
}
