/** Original paired glyph: an ember and a pool around a shared doorway. */
export function emblem(): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "element-emblem";
  mark.setAttribute("aria-hidden", "true");
  mark.innerHTML = '<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M23 4C24 15 9 17 9 29a14 14 0 0 0 14 14V30c-6-1-6-7-3-10 1 4 3 5 3 5V4Z" fill="var(--fire)"/><path d="M29 6c0 9 12 14 12 23a14 14 0 0 1-14 14V29c7-2 8-7 2-13V6Z" fill="var(--water)"/></svg>';
  return mark;
}

/**
 * The board's heading mark; the guest's locked board wears it too. Kept here
 * rather than in leaderboard.ts so the guest panel does not pull the board,
 * and the client behind it, into a guest's download.
 */
export const TROPHY = '<svg width="20" height="20" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><path d="M9 5h14v7a7 7 0 0 1-14 0V5Zm7 14v7m-6 2h12M9 8H4v3a6 6 0 0 0 7 6m12-9h5v3a6 6 0 0 1-7 6"/><path d="m16 8 1 2 2 .3-1.5 1.5.4 2.2-1.9-1-1.9 1 .4-2.2-1.5-1.5 2-.3 1-2Z" fill="currentColor" stroke="none"/></svg>';
