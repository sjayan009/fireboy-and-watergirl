import { auth } from "./auth.js";

export interface PresentationPreferences { fps: number; scale: number }
export const PRESENTATION_CHANGED = "fbwg:presentation";
const key = () => `fbwg.presentation.${auth().user?.id ?? "local"}`;
export function presentationPreferences(): PresentationPreferences {
  try {
    const p = JSON.parse(localStorage.getItem(key()) ?? "{}");
    return { fps: [0, 30, 60, 120, 144, 240].includes(p.fps) ? p.fps : 0,
      scale: [1, 1.5, 2].includes(p.scale) ? p.scale : 1 };
  } catch { return { fps: 0, scale: 1 }; }
}
export function savePresentationPreferences(preferences: PresentationPreferences): void {
  try { localStorage.setItem(key(), JSON.stringify(preferences)); } catch { /* still apply for this visit */ }
  dispatchEvent(new CustomEvent(PRESENTATION_CHANGED, { detail: preferences }));
}
