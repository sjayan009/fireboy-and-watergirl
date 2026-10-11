import { auth } from "./auth.js";

/**
 * How the game is drawn on this device: frame rate, output quality, and the
 * stage glow (off unless somebody turns it on). Per account and device, like
 * the other two, and announced so every open screen follows a change at once.
 */
export interface PresentationPreferences { fps: number; scale: number; glow: boolean }
export const PRESENTATION_CHANGED = "fbwg:presentation";
const key = () => `fbwg.presentation.${auth().user?.id ?? "local"}`;
export function presentationPreferences(): PresentationPreferences {
  try {
    const p = JSON.parse(localStorage.getItem(key()) ?? "{}");
    return { fps: [0, 30, 60, 120, 144, 240].includes(p.fps) ? p.fps : 0,
      scale: [1, 1.5, 2].includes(p.scale) ? p.scale : 1, glow: p.glow === true };
  } catch { return { fps: 0, scale: 1, glow: false }; }
}
/** Change some of them; the rest stay as they were. */
export function savePresentationPreferences(change: Partial<PresentationPreferences>): void {
  const preferences = { ...presentationPreferences(), ...change };
  try { localStorage.setItem(key(), JSON.stringify(preferences)); } catch { /* still apply for this visit */ }
  dispatchEvent(new CustomEvent(PRESENTATION_CHANGED, { detail: preferences }));
}
