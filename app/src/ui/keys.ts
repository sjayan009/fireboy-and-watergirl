/**
 * Keycaps that answer the keyboard.
 *
 * Brought over from the old guest page, which people liked for one thing in
 * particular: a key goes down the moment it is pressed and lights in its
 * player's colour, so two people learning the controls can see whose key is
 * whose. They live in the footer (always in sight) and in the drawer (the
 * guest's "Playing here together" and the Menu's "At Your Fingertips").
 *
 * Online, either set of keys drives your one character -- the engine maps both
 * onto your slot -- so a press of W lights Fireboy's ↑ when you are Fireboy.
 */
import { el, on } from "./dom.js";

type Player = "fire" | "water";
export type KeyMode = "both" | Player;

const KEYS: Record<Player, [code: string, label: string, name: string][]> = {
  fire: [["ArrowLeft", "←", "Left arrow"], ["ArrowUp", "↑", "Up arrow"], ["ArrowRight", "→", "Right arrow"]],
  water: [["KeyA", "A", "A"], ["KeyW", "W", "W"], ["KeyD", "D", "D"]],
};
/** The other scheme's key for the same move, for online play. */
const TWIN: Record<string, string> = { KeyA: "ArrowLeft", KeyW: "ArrowUp", KeyD: "ArrowRight",
  ArrowLeft: "KeyA", ArrowUp: "KeyW", ArrowRight: "KeyD" };
const NAME: Record<Player, string> = { fire: "Fireboy", water: "Watergirl" };

const cap = (code: string, label: string, name?: string) =>
  el("kbd", { class: "kc", "data-key": code, ...(name ? { title: name } : {}) }, label);

/** One player's keys in their coloured outline: name, then keys (mirrored for Watergirl). */
export function keyGroup(player: Player): HTMLElement {
  const caps = KEYS[player].map(([code, label, name]) => cap(code, label, name));
  const who = el("span", { class: "who" }, NAME[player]);
  return el("span", { class: `kgroup ${player}`, "aria-hidden": "true" }, ...(player === "fire" ? [who, ...caps] : [...caps, who]));
}

/** P, which is neither player's: it lights lavender. */
export function pauseKey(text: string): HTMLElement {
  return el("span", { class: "kgroup pause", "aria-hidden": "true" }, cap("KeyP", "P", "P"), el("span", {}, text));
}

/** A full-width row for the drawer: the name on the left, larger keys on the right. */
export function keyRow(player: Player): HTMLElement {
  return el("p", { class: `keyrow ${player}` }, el("span", { class: "who" }, NAME[player]),
    el("span", { class: "caps", "aria-hidden": "true" }, ...KEYS[player].map(([code, label]) => cap(code, label))),
    el("span", { class: "sr-only" }, player === "fire" ? ": arrow keys" : ": W, A and D"));
}

/** The footer legend: both players and P, or only you when playing online. */
export function keyLegend(): { root: HTMLElement; setMode(mode: KeyMode): void } {
  const said = el("span", { class: "sr-only" });
  const root = el("div", { class: "keys-legend", id: "play-keys", "data-mode": "both" },
    said, keyGroup("fire"), pauseKey("pauses"), keyGroup("water"));
  const setMode = (mode: KeyMode) => {
    root.dataset.mode = mode;
    said.textContent = mode === "both"
      ? "Fireboy moves with the arrow keys, Watergirl with W, A and D. P pauses."
      : `You are ${NAME[mode]}: the arrow keys or W, A and D. P pauses.`;
  };
  setMode("both");
  return { root, setMode };
}

/**
 * Light every cap under `scope` while its key is held.
 *
 * Listening is all this does -- the game reads its own input and nothing here
 * prevents or changes a key. Typing in a field lights nothing, and leaving the
 * window lets every key up, since a keyup there never arrives.
 */
export function lightKeys(scope: HTMLElement, mode: () => KeyMode): () => void {
  const typing = (t: EventTarget | null) => t instanceof HTMLElement && t.matches("input, textarea, select, [contenteditable='true']");
  const press = (down: boolean) => (event: Event) => {
    const e = event as KeyboardEvent;
    if (down && typing(e.target)) return;
    const m = mode();
    // Online, the scheme you did not press still means your character's move.
    const code = m === "fire" && e.code in TWIN && e.code.startsWith("Key") ? TWIN[e.code]
      : m === "water" && e.code in TWIN && e.code.startsWith("Arrow") ? TWIN[e.code] : e.code;
    for (const k of scope.querySelectorAll<HTMLElement>(`kbd[data-key="${code}"]`)) k.classList.toggle("is-down", down);
  };
  const release = () => { for (const k of scope.querySelectorAll(".kc.is-down")) k.classList.remove("is-down"); };
  const offs = [on(window, "keydown", press(true)), on(window, "keyup", press(false)), on(window, "blur", release)];
  return () => { offs.forEach(off => off()); };
}
