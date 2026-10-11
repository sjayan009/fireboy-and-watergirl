/**
 * Offering a signed-in player the progress a guest earned in this browser.
 *
 * Never automatic: guest progress is kept under its own key precisely so
 * that on a shared computer the next person to sign in does not inherit
 * somebody else's medals. The player is asked, once per account, and only an
 * explicit "Add" moves anything.
 */
import { normaliseSave } from "@engine/game/save.js";
import { mergeProgress, type ProgressArrays } from "./outbox.js";
import type { SoloProgress } from "./solosave.js";

// Where the play screen keeps a guest's progress -- the key the old guest page
// at `#/local` used, so progress made there carries over. Never change it
// (app/test/progress-isolation.mjs fails if it does).
export const GUEST_KEY = "FBCookie:guest";
const askedKey = (userId: string) => `fbwg.guestAsked.${userId}`;

export interface GuestSummary { cleared: number; timed: number; data: ProgressArrays }

/** What the guest cleared, or null: nothing stored, unreadable, or no level cleared. */
export function guestSummary(): GuestSummary | null {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    if (!raw) return null;
    const data = normaliseSave(JSON.parse(raw)).data as ProgressArrays;
    const done = data.stats.map((s, i) => s >= 1 ? i : -1).filter(i => i >= 0);
    return done.length ? { cleared: done.length, timed: done.filter(i => data.times[i] > 0).length, data } : null;
  } catch { return null; }
}

/** The prompt's summary if this account should be asked now, else null. */
export function guestOffer(userId: string): GuestSummary | null {
  try { if (localStorage.getItem(askedKey(userId))) return null; } catch { return null; }
  return guestSummary();
}

export function guestOfferText(s: GuestSummary): string {
  return `This browser has guest progress: ${s.cleared} ${s.cleared === 1 ? "level" : "levels"} cleared, ` +
    `${s.timed} with times. Add it to your account?`;
}

/** "Not mine": ask no more for this account. The guest save is left exactly as it is. */
export function declineGuest(userId: string): void {
  try { localStorage.setItem(askedKey(userId), "1"); } catch { /* asked again next time */ }
}

/**
 * Merge into the account's solo save (it can only raise a medal or lower a
 * time) and sync. The guest copy is deleted only once the cloud has
 * acknowledged the merge; any failure leaves it where it is. Returns whether
 * the import is complete.
 */
export async function importGuest(solo: SoloProgress, userId: string): Promise<boolean> {
  const guest = guestSummary();
  if (!guest) return false;
  Object.assign(solo.store.data, mergeProgress(solo.store.data as ProgressArrays, guest.data));
  solo.touched();
  await solo.sync();
  if (solo.pending || solo.lastError) return false;
  try { localStorage.removeItem(GUEST_KEY); } catch { /* the asked flag below stops a second offer */ }
  declineGuest(userId);
  return true;
}
